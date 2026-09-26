//! The turn loop: streams the model, runs the tools it asks for, and settles the
//! turn with one `Done` (or, through the caller, one `Error`). Every request is
//! measured and admitted against the cost caps before it leaves, reported on the
//! egress channel, and — when the summary cache is on — looked up by its exact
//! body first.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;

use crate::chat::cost_caps::{admit_request, estimate_tokens, record_usage};
use crate::chat::findings::validate_findings;
use crate::chat::installed_cli::{cli_prompt, cli_request, stream_cli};
use crate::chat::provider::{
    build_request, stream_request, CompletedToolCall, ProviderEvent, ProviderKind, ProviderRequest,
    StreamOutcome, ToolSpec, TurnMessage,
};
use crate::chat::replay::{ReplayCall, ReplayStep};
use crate::chat::summary_cache;
use crate::chat::tools::{run_tool, ToolCallRequest, ToolContext, ToolOutcome};
use crate::chat::turn_plan::{plan_turn, turn_guard, TurnPlan};
use crate::chat::{
    append_chat_history, new_message_id, now_millis, provider_kind, register_turn, resolve_api_key,
    ChatCitation, ChatEvent, ChatMessage, ChatRole, ChatSendRequest, ChatSettings, ChatSink,
    ChatToolRun, ChatToolStatus, ProviderKindWire, MAX_TOOL_ITERATIONS,
};

/// Runs one turn to its final message. Every failure leaves as `Err`, so the
/// caller reports it on the turn's error channel.
pub async fn run_turn(
    sink: Arc<dyn ChatSink>,
    settings: ChatSettings,
    projects_override: Option<Vec<String>>,
    request: ChatSendRequest,
) -> Result<ChatMessage, String> {
    turn_guard(&settings, &request)?;
    let plan = plan_turn(&settings, projects_override, &request)?;
    let mut run = TurnRun::new(sink, settings, &request, &plan)?;
    let mut state = TurnState::new(plan.messages());
    let ended = match provider_kind(run.settings.provider) {
        Some(kind) => run.api_steps(kind, &mut state).await?,
        None => run.cli_step(&plan, &mut state).await?,
    };
    match ended {
        StepEnd::Cached(message) => run.finish_cached(&request, *message),
        _ => run.finish(&request, &plan, state).await,
    }
}

/// How one model step ended.
enum StepEnd {
    Continue,
    Done,
    Cached(Box<ChatMessage>),
}

/// A built request, or the stored answer for it.
enum Prepared {
    Send(ProviderRequest),
    Cached(Box<ChatMessage>),
}

/// Everything shared by the steps of one turn.
struct TurnRun {
    sink: Arc<dyn ChatSink>,
    turn_id: String,
    settings: ChatSettings,
    api_key: String,
    cancel: Arc<AtomicBool>,
    loopback: bool,
    specs: Vec<ToolSpec>,
    tools: Arc<ToolContext>,
    sent_bytes: u64,
    turn_tokens: u64,
    cache_key: Option<String>,
}

impl TurnRun {
    fn new(
        sink: Arc<dyn ChatSink>,
        settings: ChatSettings,
        request: &ChatSendRequest,
        plan: &TurnPlan,
    ) -> Result<Self, String> {
        Ok(TurnRun {
            api_key: resolve_api_key(settings.provider, &settings.base_url)?,
            cancel: register_turn(&request.turn_id),
            turn_id: request.turn_id.clone(),
            sink,
            settings,
            loopback: plan.loopback,
            specs: plan.specs.clone(),
            tools: Arc::new(ToolContext {
                projects: plan.projects.clone(),
            }),
            sent_bytes: 0,
            turn_tokens: 0,
            cache_key: None,
        })
    }

    fn ensure_live(&self) -> Result<(), String> {
        match self.cancel.load(Ordering::Relaxed) {
            true => Err("cancelled".to_string()),
            false => Ok(()),
        }
    }

    async fn api_steps(
        &mut self,
        kind: ProviderKind,
        state: &mut TurnState,
    ) -> Result<StepEnd, String> {
        for iteration in 0..MAX_TOOL_ITERATIONS {
            self.ensure_live()?;
            match self.api_step(kind, state, iteration).await? {
                StepEnd::Continue => continue,
                ended => return Ok(ended),
            }
        }
        Ok(StepEnd::Done)
    }

    /// One request: build, admit, stream, and run whatever tools it asked for.
    async fn api_step(
        &mut self,
        kind: ProviderKind,
        state: &mut TurnState,
        iteration: usize,
    ) -> Result<StepEnd, String> {
        let request = match self.prepare(kind, &state.messages, iteration == 0)? {
            Prepared::Send(request) => request,
            Prepared::Cached(message) => return Ok(StepEnd::Cached(message)),
        };
        let forward = self.forwarder();
        let outcome =
            stream_request(&request, &self.api_key, &self.cancel, forward.as_ref()).await?;
        self.record(request.body.to_string().len(), &outcome);
        state.absorb(&outcome);
        let last_round = iteration + 1 == MAX_TOOL_ITERATIONS;
        if outcome.calls.is_empty() || last_round {
            state.note_limit(if last_round { outcome.calls.len() } else { 0 }, self);
            state.steps.push(text_step(&outcome.text));
            return Ok(StepEnd::Done);
        }
        state.messages.push(TurnMessage::Assistant {
            text: outcome.text.clone(),
            calls: outcome.calls.clone(),
        });
        let calls = self.execute_calls(state, &outcome.calls).await;
        state.steps.push(ReplayStep {
            text: outcome.text,
            calls,
        });
        Ok(StepEnd::Continue)
    }

    /// Builds the step's request; the first step may be answered from the cache.
    /// The cost caps admit the input and lower `max_tokens` to what is left.
    fn prepare(
        &mut self,
        kind: ProviderKind,
        messages: &[TurnMessage],
        first: bool,
    ) -> Result<Prepared, String> {
        let settings = &self.settings;
        let mut request = build_request(
            kind,
            &settings.base_url,
            &settings.model,
            settings.max_tokens,
            settings.temperature,
            messages,
            &self.specs,
        );
        if let Some(message) = first.then(|| self.cached(&request.body)).flatten() {
            return Ok(Prepared::Cached(message));
        }
        let estimate = estimate_tokens(request.body.to_string().len());
        let output = admit_request(
            &self.settings.caps,
            self.turn_tokens,
            estimate,
            self.settings.max_tokens,
        )?;
        request.body["max_tokens"] = json!(output);
        self.report_egress(request.body.to_string().len());
        Ok(Prepared::Send(request))
    }

    /// A delegated CLI answers in one step, with the diffs in its prompt.
    async fn cli_step(
        &mut self,
        plan: &TurnPlan,
        state: &mut TurnState,
    ) -> Result<StepEnd, String> {
        let prompt = cli_prompt(&state.messages);
        let body = cli_request(&self.settings, &plan.system, &prompt);
        if let Some(message) = self.cached(&body) {
            return Ok(StepEnd::Cached(message));
        }
        let bytes = body.to_string().len();
        admit_request(
            &self.settings.caps,
            0,
            estimate_tokens(bytes),
            self.settings.max_tokens,
        )?;
        self.report_egress(bytes);
        let outcome = stream_cli(
            self.settings.clone(),
            plan.system.clone(),
            prompt,
            Arc::clone(&self.cancel),
            self.forwarder(),
        )
        .await?;
        self.record(bytes, &outcome);
        state.absorb(&outcome);
        state.steps.push(text_step(&outcome.text));
        Ok(StepEnd::Done)
    }

    /// Looks the request body up when the cache is on, remembering the key.
    fn cached(&mut self, body: &serde_json::Value) -> Option<Box<ChatMessage>> {
        if !self.settings.summary_cache {
            return None;
        }
        let key = summary_cache::request_key(body);
        let hit = summary_cache::lookup(&key);
        self.cache_key = Some(key);
        hit.map(Box::new)
    }

    fn report_egress(&mut self, bytes: usize) {
        self.sent_bytes += bytes as u64;
        self.sink.emit(&ChatEvent::Egress {
            turn_id: self.turn_id.clone(),
            request_bytes: bytes as u64,
            sent_bytes: self.sent_bytes,
            estimated_tokens: estimate_tokens(self.sent_bytes as usize),
            loopback: self.loopback,
        });
    }

    /// Counts the step against the caps: the provider's usage when it reports
    /// one, else the estimate of what went out and came back.
    fn record(&mut self, request_bytes: usize, outcome: &StreamOutcome) {
        let tokens = outcome.total_tokens.unwrap_or_else(|| {
            estimate_tokens(request_bytes)
                + estimate_tokens(outcome.text.len() + outcome.reasoning.len())
        });
        self.turn_tokens += tokens;
        if let Err(error) = record_usage(tokens) {
            eprintln!("chat usage: {error}");
        }
    }

    /// Streams text and reasoning to the sink under this turn's id.
    fn forwarder(&self) -> Arc<dyn Fn(ProviderEvent) + Send + Sync> {
        let sink = Arc::clone(&self.sink);
        let turn_id = self.turn_id.clone();
        Arc::new(move |event| match event {
            ProviderEvent::TextDelta(text) => sink.emit(&ChatEvent::Delta {
                turn_id: turn_id.clone(),
                text,
            }),
            ProviderEvent::ReasoningDelta(text) => sink.emit(&ChatEvent::Reasoning {
                turn_id: turn_id.clone(),
                text,
            }),
            ProviderEvent::ToolCall { .. }
            | ProviderEvent::Done { .. }
            | ProviderEvent::Error(_) => {}
        })
    }

    /// Runs every tool call the model asked for, appending results to the
    /// messages. A failed tool reports its error to the model and the panel, and
    /// the turn goes on. Returns the calls with their results, for replay.
    async fn execute_calls(
        &self,
        state: &mut TurnState,
        calls: &[CompletedToolCall],
    ) -> Vec<ReplayCall> {
        let mut replayed = Vec::with_capacity(calls.len());
        for call in calls {
            let running = running_run(call);
            self.emit_tool(&running);
            if self.cancel.load(Ordering::Relaxed) {
                state.runs.push(running);
                break;
            }
            let request = ToolCallRequest {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            };
            let tools = Arc::clone(&self.tools);
            let executed = crate::commands::blocking(move || run_tool(&tools, &request)).await;
            let finished = finish_tool_run(&running, executed);
            self.emit_tool(&finished.run);
            state.runs.push(finished.run);
            replayed.push(ReplayCall::stored(call, &finished.content));
            state.messages.push(TurnMessage::ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                content: finished.content,
            });
        }
        replayed
    }

    fn emit_tool(&self, tool: &ChatToolRun) {
        self.sink.emit(&ChatEvent::Tool {
            turn_id: self.turn_id.clone(),
            tool: tool.clone(),
        });
    }

    /// Builds the final message (findings validated against the real hunks),
    /// stores it in the cache when that is on, persists the pair, reports `Done`.
    async fn finish(
        self,
        request: &ChatSendRequest,
        plan: &TurnPlan,
        state: TurnState,
    ) -> Result<ChatMessage, String> {
        let (answer, projects) = (state.text.clone(), plan.projects.clone());
        let ambient = request.context.project_path.clone();
        let findings = crate::commands::blocking(move || {
            Ok::<_, String>(validate_findings(&answer, &projects, ambient.as_deref()))
        })
        .await?;
        let message = ChatMessage {
            findings: findings.kept,
            dropped_findings: findings.dropped,
            replay: state.steps,
            ..assistant_message(&self.settings, state.text, state.reasoning, state.runs)
        };
        self.store_in_cache(&message);
        self.settle(request, message, state.total_tokens)
    }

    fn store_in_cache(&self, message: &ChatMessage) {
        let Some(key) = self
            .cache_key
            .as_deref()
            .filter(|_| !message.text.is_empty())
        else {
            return;
        };
        if let Err(error) = summary_cache::store(key, message) {
            eprintln!("chat summary cache: {error}");
        }
    }

    /// A cache hit: the stored answer under a fresh id, marked as cached.
    fn finish_cached(
        self,
        request: &ChatSendRequest,
        stored: ChatMessage,
    ) -> Result<ChatMessage, String> {
        let message = ChatMessage {
            id: new_message_id(&stored.text),
            created_at: now_millis(),
            cached: true,
            ..stored
        };
        self.settle(request, message, None)
    }

    fn settle(
        self,
        request: &ChatSendRequest,
        message: ChatMessage,
        total_tokens: Option<u64>,
    ) -> Result<ChatMessage, String> {
        append_chat_history(&[user_message(&request.text), message.clone()])?;
        let visible = message.for_webview();
        self.sink.emit(&ChatEvent::Done {
            turn_id: request.turn_id.clone(),
            message: Box::new(visible.clone()),
            total_tokens,
        });
        Ok(visible)
    }
}

fn text_step(text: &str) -> ReplayStep {
    ReplayStep {
        text: text.to_string(),
        calls: Vec::new(),
    }
}

fn assistant_message(
    settings: &ChatSettings,
    text: String,
    reasoning: String,
    runs: Vec<ChatToolRun>,
) -> ChatMessage {
    let model = match settings.provider {
        ProviderKindWire::Cli if settings.model.is_empty() => {
            format!("{:?} CLI", settings.cli_command).to_lowercase()
        }
        _ => settings.model.clone(),
    };
    ChatMessage {
        id: new_message_id(&text),
        role: ChatRole::Assistant,
        citations: dedup_citations(&runs),
        text,
        reasoning,
        tools: runs,
        model: Some(model),
        ..user_message("")
    }
}

fn user_message(text: &str) -> ChatMessage {
    ChatMessage {
        id: new_message_id(text),
        role: ChatRole::User,
        text: text.to_string(),
        reasoning: String::new(),
        tools: Vec::new(),
        citations: Vec::new(),
        model: None,
        created_at: now_millis(),
        error: None,
        cached: false,
        findings: Vec::new(),
        dropped_findings: 0,
        replay: Vec::new(),
    }
}

/// The running answer plus everything the turn accumulates.
struct TurnState {
    messages: Vec<TurnMessage>,
    text: String,
    reasoning: String,
    runs: Vec<ChatToolRun>,
    steps: Vec<ReplayStep>,
    total_tokens: Option<u64>,
}

impl TurnState {
    fn new(messages: Vec<TurnMessage>) -> Self {
        TurnState {
            messages,
            text: String::new(),
            reasoning: String::new(),
            runs: Vec::new(),
            steps: Vec::new(),
            total_tokens: None,
        }
    }

    fn absorb(&mut self, outcome: &StreamOutcome) {
        self.text.push_str(&outcome.text);
        self.reasoning.push_str(&outcome.reasoning);
        if let Some(tokens) = outcome.total_tokens {
            self.total_tokens = Some(self.total_tokens.unwrap_or(0) + tokens);
        }
    }

    /// A model that hit the tool cap still asked for tools; say so instead of
    /// silently dropping its requests.
    fn note_limit(&mut self, pending: usize, run: &TurnRun) {
        if pending == 0 {
            return;
        }
        let note = format!(
            "\n\n(Stopped after {MAX_TOOL_ITERATIONS} tool rounds; {pending} requested \
             tool call(s) were not run.)"
        );
        run.sink.emit(&ChatEvent::Delta {
            turn_id: run.turn_id.clone(),
            text: note.clone(),
        });
        self.text.push_str(&note);
    }
}

fn running_run(call: &CompletedToolCall) -> ChatToolRun {
    ChatToolRun {
        call_id: call.id.clone(),
        name: call.name.clone(),
        status: ChatToolStatus::Running,
        detail: tool_detail(call),
        sources: Vec::new(),
    }
}

/// A completed run plus the bounded text the model sees.
struct FinishedToolRun {
    run: ChatToolRun,
    content: String,
}

fn finish_tool_run(
    running: &ChatToolRun,
    executed: Result<ToolOutcome, String>,
) -> FinishedToolRun {
    let (content, sources, status) = match executed {
        Ok(outcome) => (
            cap_tool_result(outcome.content),
            outcome.sources,
            ChatToolStatus::Ok,
        ),
        Err(error) => (error_payload(&error), Vec::new(), ChatToolStatus::Error),
    };
    FinishedToolRun {
        run: ChatToolRun {
            status,
            sources,
            ..running.clone()
        },
        content,
    }
}

/// Tool errors travel as valid JSON so the provider always parses the result.
fn error_payload(error: &str) -> String {
    serde_json::to_string(&json!({ "error": error })).unwrap_or_else(|_| {
        "{\"error\": \"the tool failed and its error could not be serialized\"}".to_string()
    })
}

/// Nothing a tool read may exceed the text bound, even if a reader regresses.
fn cap_tool_result(content: String) -> String {
    let bound = crate::git::MAX_TEXT_SIDE_BYTES as usize;
    if content.len() <= bound {
        return content;
    }
    format!("{{\"truncated\": true, \"note\": \"tool result exceeded {bound} bytes and was cut\"}}")
}

/// One line per tool run for the UI chips.
fn tool_detail(call: &CompletedToolCall) -> String {
    let args = serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap_or_default();
    let target = ["file", "project", "query"]
        .iter()
        .find_map(|key| args.get(key).and_then(serde_json::Value::as_str))
        .filter(|target| !target.is_empty());
    match target {
        Some(target) => format!("{} {target}", call.name),
        None => call.name.clone(),
    }
}

fn dedup_citations(runs: &[ChatToolRun]) -> Vec<ChatCitation> {
    let mut seen = HashSet::new();
    let mut labels = HashSet::new();
    let mut citations = Vec::new();
    for citation in runs.iter().flat_map(|run| &run.sources) {
        let unique = seen.insert((
            citation.project_path.clone(),
            citation.file_path.clone(),
            citation.start_line,
            citation.end_line,
            citation.label.clone(),
        ));
        // The printed `sources:` block is the label list, so two citations
        // that name the same location must not both survive.
        if unique && labels.insert(citation.label.clone()) {
            citations.push(citation.clone());
        }
    }
    citations
}
