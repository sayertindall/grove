//! The chat session: types, persistence, cancellation, and the single turn loop
//! shared by the GUI (Tauri events) and the CLI (stdout). One free-flowing chat,
//! one system prompt, no modes.

pub mod cli;
pub mod prompt;
pub mod provider;
pub mod tools;

use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::chat::prompt::system_prompt;
use crate::chat::provider::{
    stream_turn, CompletedToolCall, ProviderKind, StreamOutcome, ToolSpec, TurnMessage,
};
use crate::chat::tools::{run_tool, tool_specs, ToolCallRequest, ToolContext, ToolOutcome};
use crate::git::read_project_status;

/// The store files this module owns, relative to the data directory.
pub const HISTORY_FILE: &str = "chat-history.json";
pub const SETTINGS_FILE: &str = "chat-settings.json";
/// The projects store, read here without an AppHandle so the CLI reuses it.
pub const PROJECTS_FILE: &str = "projects.json";
/// The project list and the chat history are both bounded stores.
pub const HISTORY_LIMIT: usize = 200;
/// Tool rounds per turn; a model that keeps calling tools is stopped here.
pub const MAX_TOOL_ITERATIONS: usize = 8;
/// Keychain service for provider keys.
pub const KEYCHAIN_SERVICE: &str = "com.grove.app";

// --- Wire types (mirror of src/types/grove.ts) ---------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatToolStatus {
    Running,
    Ok,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCitation {
    pub project_path: String,
    pub file_path: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolRun {
    pub call_id: String,
    pub name: String,
    pub status: ChatToolStatus,
    pub detail: String,
    #[serde(default)]
    pub sources: Vec<ChatCitation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub tools: Vec<ChatToolRun>,
    #[serde(default)]
    pub citations: Vec<ChatCitation>,
    pub model: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKindWire {
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    Anthropic,
}

impl From<ProviderKindWire> for ProviderKind {
    fn from(value: ProviderKindWire) -> Self {
        match value {
            ProviderKindWire::OpenAiCompatible => ProviderKind::OpenAiCompatible,
            ProviderKindWire::Anthropic => ProviderKind::Anthropic,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatSettings {
    pub provider: ProviderKindWire,
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
    pub temperature: Option<f64>,
    pub allow_cloud_egress: bool,
}

impl Default for ChatSettings {
    fn default() -> Self {
        ChatSettings {
            provider: ProviderKindWire::OpenAiCompatible,
            base_url: "https://api.deepseek.com".to_string(),
            model: "deepseek-chat".to_string(),
            max_tokens: 8192,
            temperature: None,
            allow_cloud_egress: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    pub project_path: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    pub turn_id: String,
    pub text: String,
    #[serde(default)]
    pub context: ChatContext,
}

/// The one sink both frontends implement.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ChatEvent {
    Delta {
        #[serde(rename = "turnId")]
        turn_id: String,
        text: String,
    },
    Reasoning {
        #[serde(rename = "turnId")]
        turn_id: String,
        text: String,
    },
    Tool {
        #[serde(rename = "turnId")]
        turn_id: String,
        tool: ChatToolRun,
    },
    Done {
        #[serde(rename = "turnId")]
        turn_id: String,
        message: Box<ChatMessage>,
        #[serde(rename = "totalTokens")]
        total_tokens: Option<u64>,
    },
    Error {
        #[serde(rename = "turnId")]
        turn_id: String,
        message: String,
        retryable: bool,
    },
}

/// Receives streamed events for one turn.
pub trait ChatSink: Send + Sync {
    fn emit(&self, event: &ChatEvent);
}

/// A sink that drops everything; used when events are not wanted.
pub struct NullSink;

impl ChatSink for NullSink {
    fn emit(&self, _event: &ChatEvent) {}
}

// --- Data directory and persistence (no AppHandle) ------------------------------

/// The app-data directory. `GROVE_DATA_DIR` overrides it so the CLI and tests can
/// point at a throwaway store and never touch the user's real one.
pub fn data_dir() -> Result<PathBuf, String> {
    if let Some(override_dir) = std::env::var_os("GROVE_DATA_DIR") {
        if !override_dir.is_empty() {
            return Ok(PathBuf::from(override_dir));
        }
    }
    dirs::data_dir()
        .map(|dir| dir.join("com.grove.app"))
        .ok_or_else(|| "could not locate the application data directory".to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json(path: &std::path::Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("{}: {error}", path.display()))?;
    }
    file.write_all(text.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Loads the stored settings, or the defaults when nothing is stored yet.
pub fn load_chat_settings() -> Result<ChatSettings, String> {
    let path = data_dir()?.join(SETTINGS_FILE);
    Ok(read_json(&path).unwrap_or_default())
}

/// Stores the settings and returns what was stored.
pub fn save_chat_settings(settings: &ChatSettings) -> Result<ChatSettings, String> {
    let path = data_dir()?.join(SETTINGS_FILE);
    write_json(&path, settings)?;
    Ok(settings.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    #[serde(default)]
    messages: Vec<ChatMessage>,
}

/// Loads the persisted history, oldest first.
pub fn load_chat_history() -> Result<Vec<ChatMessage>, String> {
    let path = data_dir()?.join(HISTORY_FILE);
    Ok(read_json::<HistoryFile>(&path).unwrap_or_default().messages)
}

/// Appends messages and keeps the newest `HISTORY_LIMIT`.
pub fn append_chat_history(messages: &[ChatMessage]) -> Result<(), String> {
    let path = data_dir()?.join(HISTORY_FILE);
    let mut history = read_json::<HistoryFile>(&path).unwrap_or_default().messages;
    history.extend_from_slice(messages);
    if history.len() > HISTORY_LIMIT {
        let keep_from = history.len() - HISTORY_LIMIT;
        history.drain(..keep_from);
    }
    write_json(&path, &HistoryFile { messages: history })
}

/// Clears the persisted history.
pub fn clear_chat_history() -> Result<(), String> {
    let path = data_dir()?.join(HISTORY_FILE);
    write_json(&path, &HistoryFile::default())
}

/// Reads the registered project list straight from the store file, so no AppHandle
/// is needed. A missing file is an empty list.
pub fn load_registered_projects() -> Result<Vec<String>, String> {
    let path = data_dir()?.join(PROJECTS_FILE);
    #[derive(Deserialize)]
    struct Store {
        #[serde(default = "missing_key", rename = "projects")]
        projects: Option<Vec<String>>,
    }
    fn missing_key() -> Option<Vec<String>> {
        None
    }
    let store: Store = read_json(&path)
        .ok_or_else(|| format!("{}: not a readable projects store", path.display()))?;
    Ok(store.projects.unwrap_or_default())
}

// --- Keys -----------------------------------------------------------------------

/// The environment variable matched by provider and host.
fn provider_env_var(provider: ProviderKindWire, base_url: &str) -> &'static str {
    if provider == ProviderKindWire::Anthropic {
        return "ANTHROPIC_API_KEY";
    }
    let host = base_url.to_lowercase();
    if host.contains("deepseek") {
        "DEEPSEEK_API_KEY"
    } else if host.contains("groq") {
        "GROQ_API_KEY"
    } else if host.contains("openrouter") {
        "OPENROUTER_API_KEY"
    } else if host.contains("anthropic") {
        "ANTHROPIC_API_KEY"
    } else {
        "OPENAI_API_KEY"
    }
}

/// Resolves the provider key: `GROVE_CHAT_KEY` → provider env var → Keychain.
/// The key never reaches a log or a command result.
pub fn resolve_api_key(provider: ProviderKindWire, base_url: &str) -> Result<String, String> {
    if let Ok(key) = std::env::var("GROVE_CHAT_KEY") {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    let env_name = provider_env_var(provider, base_url);
    if let Ok(key) = std::env::var(env_name) {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider_id(provider))
        .map_err(|error| format!("keychain: {error}"))?;
    match entry.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(key),
        Ok(_) => missing_key_error(env_name),
        Err(keyring::Error::NoEntry) => missing_key_error(env_name),
        Err(error) => Err(format!("keychain: {error}")),
    }
}

fn missing_key_error(env_name: &str) -> Result<String, String> {
    Err(format!(
        "no API key for this provider; set GROVE_CHAT_KEY or {env_name}, or store one in the app"
    ))
}

fn provider_id(provider: ProviderKindWire) -> &'static str {
    match provider {
        ProviderKindWire::OpenAiCompatible => "openai-compatible",
        ProviderKindWire::Anthropic => "anthropic",
    }
}

/// Stores a key in the macOS Keychain (service `com.grove.app`, account = provider).
pub fn store_chat_key(provider: ProviderKindWire, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider_id(provider))
        .map_err(|error| format!("keychain: {error}"))?;
    entry
        .set_password(key)
        .map_err(|error| format!("keychain: {error}"))
}

/// Removes the stored key. A missing key is already cleared, not a failure.
pub fn clear_chat_key(provider: ProviderKindWire) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider_id(provider))
        .map_err(|error| format!("keychain: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("keychain: {error}")),
    }
}

/// True when a key would resolve without storing or returning it.
pub fn chat_key_status(provider: ProviderKindWire, base_url: &str) -> bool {
    resolve_api_key(provider, base_url).is_ok()
}

// --- Cancellation ---------------------------------------------------------------

static CANCEL_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn register_turn(turn_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut registry) = CANCEL_REGISTRY.lock() {
        registry.retain(|_, flag| !flag.load(Ordering::Relaxed));
        registry.insert(turn_id.to_string(), Arc::clone(&flag));
    }
    flag
}

/// Marks a running turn cancelled. The turn fails with "cancelled" at its next
/// check point.
pub fn cancel_turn(turn_id: &str) {
    if let Ok(registry) = CANCEL_REGISTRY.lock() {
        if let Some(flag) = registry.get(turn_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

// --- Egress guard ---------------------------------------------------------------

/// Refuses a turn when cloud egress is not allowed and the provider is remote.
pub fn ensure_egress_allowed(settings: &ChatSettings) -> Result<(), String> {
    let host = host_of(&settings.base_url);
    let local = matches!(
        host.as_deref(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    );
    if !local && !settings.allow_cloud_egress {
        return Err(format!(
            "cloud egress is off; allow it in chat settings before using {}",
            host.as_deref().unwrap_or(settings.base_url.as_str())
        ));
    }
    Ok(())
}

fn host_of(base_url: &str) -> Option<String> {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

// --- Turn loop ------------------------------------------------------------------

/// Runs one full turn: streams the model, executes tools, loops, and returns the
/// final assistant message. Events go to `sink`; the caller persists history.
pub async fn send_turn(
    sink: Arc<dyn ChatSink>,
    settings: ChatSettings,
    request: ChatSendRequest,
) -> Result<ChatMessage, String> {
    send_turn_with_projects(sink, settings, None, request).await
}

/// Same loop with an explicit project list, for the CLI's `--project` override and
/// for tests. `None` reads the registered list from the store.
pub async fn send_turn_with_projects(
    sink: Arc<dyn ChatSink>,
    settings: ChatSettings,
    projects_override: Option<Vec<String>>,
    request: ChatSendRequest,
) -> Result<ChatMessage, String> {
    let turn_id = request.turn_id.clone();
    let result = run_turn(Arc::clone(&sink), settings, projects_override, request).await;
    if let Err(error) = &result {
        sink.emit(&ChatEvent::Error {
            turn_id,
            message: error.clone(),
            retryable: false,
        });
    }
    result
}

/// The loop itself: streams the model, runs the tools it asks for, persists the
/// pair, and reports the final message. Every failure leaves as `Err`, so the
/// caller reports it on the turn's error channel instead of leaving the panel
/// waiting for an answer that will never come.
async fn run_turn(
    sink: Arc<dyn ChatSink>,
    settings: ChatSettings,
    projects_override: Option<Vec<String>>,
    request: ChatSendRequest,
) -> Result<ChatMessage, String> {
    let turn_id = request.turn_id.clone();
    let cancel = register_turn(&turn_id);
    let PreparedTurn {
        messages,
        specs,
        context,
        api_key,
    } = prepare_turn(&settings, projects_override, &request)?;
    let mut state = TurnState::new(messages);

    for iteration in 0..MAX_TOOL_ITERATIONS {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let outcome = stream_step(
            &sink,
            &turn_id,
            &settings,
            &state.messages,
            &specs,
            &api_key,
            &cancel,
        )
        .await?;
        state.absorb(&outcome);
        if outcome.calls.is_empty() {
            break;
        }
        if iteration + 1 == MAX_TOOL_ITERATIONS {
            state.note_limit(outcome.calls.len(), &sink, &turn_id);
            break;
        }
        state.messages.push(TurnMessage::Assistant {
            text: outcome.text.clone(),
            calls: outcome.calls.clone(),
        });
        execute_calls(
            &sink,
            &turn_id,
            &context,
            &cancel,
            &mut state,
            &outcome.calls,
        )
        .await;
    }

    finish_turn(sink, settings, request, state).await
}

/// Everything one turn needs before the first request: validated settings,
/// history, tool specs, and the shared tool context.
struct PreparedTurn {
    messages: Vec<TurnMessage>,
    specs: Vec<ToolSpec>,
    context: Arc<ToolContext>,
    api_key: String,
}

fn prepare_turn(
    settings: &ChatSettings,
    projects_override: Option<Vec<String>>,
    request: &ChatSendRequest,
) -> Result<PreparedTurn, String> {
    if request.text.trim().is_empty() {
        return Err("the message was empty".to_string());
    }
    ensure_egress_allowed(settings)?;
    let stored = match projects_override {
        Some(projects) => projects,
        None => load_registered_projects()?,
    };
    let projects = dedupe_projects(&stored);
    let api_key = resolve_api_key(settings.provider, &settings.base_url)?;

    let manifest = build_manifest(&projects);
    let system = system_prompt(&manifest, &request.context);
    let history = load_chat_history()?;
    let mut messages = replay_history(&history);
    messages.insert(0, TurnMessage::System(system));
    messages.push(TurnMessage::User(request.text.clone()));

    Ok(PreparedTurn {
        messages,
        specs: tool_specs()
            .into_iter()
            .map(|(name, description, parameters)| ToolSpec {
                name,
                description,
                parameters,
            })
            .collect(),
        context: Arc::new(ToolContext {
            projects: projects.clone(),
        }),
        api_key,
    })
}

/// Stored history keeps no tool-result payloads, so assistant rows replay as
/// plain text: replaying calls without their results would violate every
/// provider's contract.
fn replay_history(history: &[ChatMessage]) -> Vec<TurnMessage> {
    history
        .iter()
        .map(|message| match message.role {
            ChatRole::User => TurnMessage::User(message.text.clone()),
            ChatRole::Assistant => TurnMessage::Assistant {
                text: message.text.clone(),
                calls: Vec::new(),
            },
        })
        .collect()
}

/// Streams one model response, forwarding text and reasoning to the sink.
#[allow(clippy::too_many_arguments)]
async fn stream_step(
    sink: &Arc<dyn ChatSink>,
    turn_id: &str,
    settings: &ChatSettings,
    messages: &[TurnMessage],
    specs: &[ToolSpec],
    api_key: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<StreamOutcome, String> {
    let sink = Arc::clone(sink);
    let turn_key = turn_id.to_string();
    stream_turn(
        settings.provider.into(),
        &settings.base_url,
        api_key,
        &settings.model,
        settings.max_tokens,
        settings.temperature,
        messages,
        specs,
        cancel,
        &move |event| match event {
            provider::ProviderEvent::TextDelta(delta) => sink.emit(&ChatEvent::Delta {
                turn_id: turn_key.clone(),
                text: delta,
            }),
            provider::ProviderEvent::ReasoningDelta(delta) => sink.emit(&ChatEvent::Reasoning {
                turn_id: turn_key.clone(),
                text: delta,
            }),
            provider::ProviderEvent::ToolCall { .. }
            | provider::ProviderEvent::Done { .. }
            | provider::ProviderEvent::Error(_) => {}
        },
    )
    .await
}

/// The running answer plus everything the turn accumulates.
struct TurnState {
    messages: Vec<TurnMessage>,
    text: String,
    reasoning: String,
    runs: Vec<ChatToolRun>,
    total_tokens: Option<u64>,
}

impl TurnState {
    fn new(messages: Vec<TurnMessage>) -> Self {
        TurnState {
            messages,
            text: String::new(),
            reasoning: String::new(),
            runs: Vec::new(),
            total_tokens: None,
        }
    }

    fn absorb(&mut self, outcome: &StreamOutcome) {
        self.text.push_str(&outcome.text);
        self.reasoning.push_str(&outcome.reasoning);
        if outcome.total_tokens.is_some() {
            self.total_tokens = outcome.total_tokens;
        }
    }

    /// A model that hit the tool cap still asked for tools; say so instead of
    /// silently dropping its requests.
    fn note_limit(&mut self, pending: usize, sink: &Arc<dyn ChatSink>, turn_id: &str) {
        let note = format!(
            "\n\n(Stopped after {MAX_TOOL_ITERATIONS} tool rounds; {pending} requested \
             tool call(s) were not run.)"
        );
        sink.emit(&ChatEvent::Delta {
            turn_id: turn_id.to_string(),
            text: note.clone(),
        });
        self.text.push_str(&note);
    }
}

/// Runs every tool call the model asked for, appending results to the messages.
/// A failed tool reports its error to the model and the panel, and the turn goes on.
async fn execute_calls(
    sink: &Arc<dyn ChatSink>,
    turn_id: &str,
    context: &Arc<ToolContext>,
    cancel: &Arc<AtomicBool>,
    state: &mut TurnState,
    calls: &[CompletedToolCall],
) {
    for call in calls {
        let running = ChatToolRun {
            call_id: call.id.clone(),
            name: call.name.clone(),
            status: ChatToolStatus::Running,
            detail: tool_detail(call),
            sources: Vec::new(),
        };
        sink.emit(&ChatEvent::Tool {
            turn_id: turn_id.to_string(),
            tool: running.clone(),
        });
        if cancel.load(Ordering::Relaxed) {
            state.runs.push(running);
            return;
        }

        let request = ToolCallRequest {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
        };
        let tool_context = Arc::clone(context);
        let executed = crate::commands::blocking(move || run_tool(&tool_context, &request)).await;

        let finished = finish_tool_run(&running, executed);
        sink.emit(&ChatEvent::Tool {
            turn_id: turn_id.to_string(),
            tool: finished.run.clone(),
        });
        state.runs.push(finished.run.clone());
        state.messages.push(TurnMessage::ToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: finished.content,
        });
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
            call_id: running.call_id.clone(),
            name: running.name.clone(),
            status,
            detail: running.detail.clone(),
            sources,
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

/// Builds the final assistant message, persists the pair, and reports `Done`.
async fn finish_turn(
    sink: Arc<dyn ChatSink>,
    settings: ChatSettings,
    request: ChatSendRequest,
    state: TurnState,
) -> Result<ChatMessage, String> {
    let message = ChatMessage {
        id: new_message_id(&state.text),
        role: ChatRole::Assistant,
        text: state.text,
        reasoning: state.reasoning,
        tools: state.runs.clone(),
        citations: dedup_citations(&state.runs),
        model: Some(settings.model.clone()),
        created_at: now_millis(),
        error: None,
    };
    append_chat_history(&[
        ChatMessage {
            id: new_message_id(&request.text),
            role: ChatRole::User,
            text: request.text.clone(),
            reasoning: String::new(),
            tools: Vec::new(),
            citations: Vec::new(),
            model: None,
            created_at: now_millis(),
            error: None,
        },
        message.clone(),
    ])?;
    sink.emit(&ChatEvent::Done {
        turn_id: request.turn_id,
        message: Box::new(message.clone()),
        total_tokens: state.total_tokens,
    });
    Ok(message)
}

/// One line per tool run for the UI chips.
fn tool_detail(call: &CompletedToolCall) -> String {
    let args = serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap_or_default();
    let file = args
        .get("file")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let project = args
        .get("project")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let target = file
        .or(project)
        .or_else(|| {
            args.get("query")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let target = if target.is_empty() {
        String::new()
    } else {
        format!(" {target}")
    };
    format!("{}{}", call.name, target)
}

fn dedup_citations(runs: &[ChatToolRun]) -> Vec<ChatCitation> {
    let mut seen = HashSet::new();
    let mut labels = HashSet::new();
    let mut citations = Vec::new();
    for run in runs {
        for citation in &run.sources {
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
    }
    citations
}

/// One row per distinct repository: deduplicated by canonical path so a store
/// holding both spellings of a symlinked directory (`/tmp` vs `/private/tmp`)
/// yields one entry. The first stored spelling is kept as the identity the
/// model and the CLI/GUI see.
fn dedupe_projects(projects: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::with_capacity(projects.len());
    for path in projects {
        let key = std::fs::canonicalize(path)
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.clone());
        if seen.insert(key) {
            unique.push(path.clone());
        }
    }
    unique
}

/// The workspace manifest: one compact line per registered project.
fn build_manifest(projects: &[String]) -> String {
    let rows: Vec<String> = projects
        .iter()
        .map(|path| {
            let status = read_project_status(path);
            let branch = status
                .branch
                .as_ref()
                .and_then(|branch| branch.name.clone())
                .unwrap_or_else(|| "no branch".to_string());
            let upstream = status
                .branch
                .as_ref()
                .and_then(|branch| branch.upstream.clone())
                .map(|upstream| {
                    let ahead = status.branch.as_ref().map_or(0, |branch| branch.ahead);
                    let behind = status.branch.as_ref().map_or(0, |branch| branch.behind);
                    format!(" (upstream {upstream}, ahead {ahead}, behind {behind})")
                })
                .unwrap_or_default();
            format!(
                "- {} | {} | {}{} | staged {} unstaged {} untracked {} (+{}/-{})",
                status.path,
                format!("{:?}", status.state).to_lowercase(),
                branch,
                upstream,
                status.staged_count,
                status.unstaged_count,
                status.untracked_count,
                status.additions,
                status.deletions,
            )
        })
        .collect();
    if rows.is_empty() {
        "The workspace has no registered projects.".to_string()
    } else {
        format!("Registered projects:\n{}", rows.join("\n"))
    }
}

pub fn new_message_id(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update(now_millis().to_le_bytes());
    let digest = hasher.finalize();
    let hex: String = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("m-{hex}")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
