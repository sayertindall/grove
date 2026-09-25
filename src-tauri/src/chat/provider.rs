//! The provider seam: one streaming interface, two adapters (OpenAI-compatible
//! chat completions and the Anthropic messages API). SSE is parsed by hand from
//! `bytes_stream` with a line buffer — no new dependencies.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

/// How long one streaming request may run in total.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// How long connecting may take before the turn fails.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// One streamed provider event.
#[derive(Debug, Clone)]
pub enum ProviderEvent {
    TextDelta(String),
    ReasoningDelta(String),
    /// Emitted once per complete call: the fragmented argument fragments joined.
    ToolCall {
        index: usize,
        id: String,
        name: String,
        arguments: String,
    },
    /// Total tokens when the provider reported them.
    Done {
        usage: Option<u64>,
    },
    Error(String),
}

/// Which provider kind to talk to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
}

/// A message in the turn, provider-neutral. Adapters map this to their wire format.
#[derive(Debug, Clone)]
pub enum TurnMessage {
    System(String),
    User(String),
    /// Assistant text with zero or more tool calls it requested.
    Assistant {
        text: String,
        calls: Vec<CompletedToolCall>,
    },
    /// The result of one tool call, by call id.
    ToolResult {
        call_id: String,
        name: String,
        content: String,
    },
}

/// A complete tool call (either requested by the model or replayed into history).
#[derive(Debug, Clone)]
pub struct CompletedToolCall {
    pub index: usize,
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// The tool declarations sent with every request.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON schema for the arguments object.
    pub parameters: Value,
}

/// What one streaming request produced.
#[derive(Debug, Default, Clone)]
pub struct StreamOutcome {
    pub text: String,
    pub reasoning: String,
    pub calls: Vec<CompletedToolCall>,
    pub total_tokens: Option<u64>,
}

/// Streams one model turn, forwarding events to `on`. Cancellation is checked on
/// every chunk; a cancelled stream fails with a readable error.
#[allow(clippy::too_many_arguments)]
pub async fn stream_turn(
    kind: ProviderKind,
    base_url: &str,
    api_key: &str,
    model: &str,
    max_tokens: u32,
    temperature: Option<f64>,
    messages: &[TurnMessage],
    tools: &[ToolSpec],
    cancel: &AtomicBool,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) -> Result<StreamOutcome, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("http client: {error}"))?;

    match kind {
        ProviderKind::OpenAiCompatible => {
            let (url, body) =
                openai_request(base_url, model, max_tokens, temperature, messages, tools);
            let mut adapter = OpenAiAdapter::default();
            stream_sse(
                &client,
                url,
                vec![("Authorization", format!("Bearer {api_key}"))],
                body,
                cancel,
                &mut adapter,
                on,
            )
            .await
        }
        ProviderKind::Anthropic => {
            let (url, body) =
                anthropic_request(base_url, model, max_tokens, temperature, messages, tools);
            let mut adapter = AnthropicAdapter::default();
            stream_sse(
                &client,
                url,
                vec![
                    ("x-api-key", api_key.to_string()),
                    ("anthropic-version", "2023-06-01".to_string()),
                ],
                body,
                cancel,
                &mut adapter,
                on,
            )
            .await
        }
    }
}

/// One wire protocol. Folds SSE data frames into the outcome, then completes any
/// tool calls it was still assembling.
trait Adapter {
    fn fold(
        &mut self,
        frame: &str,
        outcome: &mut StreamOutcome,
        on: &(dyn Fn(ProviderEvent) + Send + Sync),
    ) -> Result<(), String>;

    /// Called once the stream ends: emits and collects the assembled calls.
    fn finish(
        &mut self,
        outcome: &mut StreamOutcome,
        on: &(dyn Fn(ProviderEvent) + Send + Sync),
    ) -> Result<(), String>;
}

// --- OpenAI-compatible ---------------------------------------------------------

#[derive(Default)]
struct OpenAiAdapter {
    /// Fragmented tool calls keyed by their declared index.
    pending: BTreeMap<usize, PendingToolCall>,
}

#[derive(Default, Clone)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

impl Adapter for OpenAiAdapter {
    fn fold(
        &mut self,
        frame: &str,
        outcome: &mut StreamOutcome,
        on: &(dyn Fn(ProviderEvent) + Send + Sync),
    ) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Frame {
            #[serde(default)]
            choices: Vec<Choice>,
            usage: Option<Usage>,
        }
        #[derive(Deserialize)]
        struct Choice {
            #[serde(default)]
            delta: Delta,
        }
        #[derive(Deserialize, Default)]
        struct Delta {
            content: Option<String>,
            #[serde(rename = "reasoning_content")]
            reasoning_content: Option<String>,
            #[serde(rename = "tool_calls", default)]
            tool_calls: Vec<ToolCallDelta>,
        }
        #[derive(Deserialize)]
        struct ToolCallDelta {
            index: usize,
            id: Option<String>,
            function: Option<FunctionDelta>,
        }
        #[derive(Deserialize)]
        struct FunctionDelta {
            name: Option<String>,
            arguments: Option<String>,
        }
        #[derive(Deserialize)]
        struct Usage {
            total_tokens: Option<u64>,
        }

        let Ok(parsed) = serde_json::from_str::<Frame>(frame) else {
            // Unrecognized frames are skipped; the contract's frames all parse.
            return Ok(());
        };
        for choice in &parsed.choices {
            if let Some(text) = nonempty(&choice.delta.content) {
                outcome.text.push_str(text);
                on(ProviderEvent::TextDelta(text.to_string()));
            }
            if let Some(reasoning) = nonempty(&choice.delta.reasoning_content) {
                outcome.reasoning.push_str(reasoning);
                on(ProviderEvent::ReasoningDelta(reasoning.to_string()));
            }
            for call in &choice.delta.tool_calls {
                let pending = self
                    .pending
                    .entry(call.index)
                    .or_default();
                if let Some(id) = &call.id {
                    pending.id = id.clone();
                }
                if let Some(function) = &call.function {
                    if let Some(name) = &function.name {
                        pending.name = name.clone();
                    }
                    if let Some(fragment) = &function.arguments {
                        pending.arguments.push_str(fragment);
                    }
                }
            }
            // `finish_reason` needs no handling: the turn completes on [DONE] or
            // end-of-stream, and usage arrives on the final data frame.
        }
        if let Some(total) = parsed.usage.and_then(|usage| usage.total_tokens) {
            outcome.total_tokens = Some(total);
        }
        Ok(())
    }

    fn finish(
        &mut self,
        outcome: &mut StreamOutcome,
        on: &(dyn Fn(ProviderEvent) + Send + Sync),
    ) -> Result<(), String> {
        for (index, call) in std::mem::take(&mut self.pending) {
            on(ProviderEvent::ToolCall {
                index,
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            });
            outcome.calls.push(CompletedToolCall {
                index,
                id: call.id,
                name: call.name,
                arguments: call.arguments,
            });
        }
        on(ProviderEvent::Done {
            usage: outcome.total_tokens,
        });
        Ok(())
    }
}

fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

fn openai_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn openai_request(
    base_url: &str,
    model: &str,
    max_tokens: u32,
    temperature: Option<f64>,
    messages: &[TurnMessage],
    tools: &[ToolSpec],
) -> (String, Value) {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(openai_message).collect::<Vec<_>>(),
        "stream": true,
        "max_tokens": max_tokens,
    });
    if let Some(temperature) = temperature {
        body["temperature"] = json!(temperature);
    }
    if !tools.is_empty() {
        // Never `tool_choice`: thinking endpoints reject a forced one.
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            }))
            .collect::<Vec<_>>());
    }
    (openai_url(base_url), body)
}

fn openai_message(message: &TurnMessage) -> Value {
    match message {
        TurnMessage::System(text) => json!({"role": "system", "content": text}),
        TurnMessage::User(text) => json!({"role": "user", "content": text}),
        TurnMessage::Assistant { text, calls } => {
            let mut message = json!({"role": "assistant", "content": text});
            if !calls.is_empty() {
                message["tool_calls"] = json!(calls
                    .iter()
                    .map(|call| json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": call.arguments,
                        },
                    }))
                    .collect::<Vec<_>>());
            }
            message
        }
        TurnMessage::ToolResult {
            call_id, content, ..
        } => json!({
            "role": "tool",
            "tool_call_id": call_id,
            "content": content,
        }),
    }
}

// --- Anthropic ------------------------------------------------------------------

#[derive(Default)]
struct AnthropicAdapter {
    /// Open `tool_use` blocks keyed by block index, completed at block stop.
    pending: BTreeMap<usize, PendingToolCall>,
    input_tokens: u64,
    output_tokens: u64,
}

impl Adapter for AnthropicAdapter {
    fn fold(
        &mut self,
        frame: &str,
        outcome: &mut StreamOutcome,
        on: &(dyn Fn(ProviderEvent) + Send + Sync),
    ) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Frame {
            #[serde(rename = "type")]
            kind: String,
            #[serde(default)]
            index: usize,
            #[serde(default)]
            delta: Delta,
            #[serde(default)]
            content_block: Option<Block>,
            #[serde(default)]
            usage: Option<Usage>,
            #[serde(default)]
            error: Option<ErrorBody>,
        }
        #[derive(Deserialize, Default)]
        struct Delta {
            #[serde(rename = "type", default)]
            kind: Option<String>,
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            thinking: Option<String>,
            #[serde(rename = "partial_json", default)]
            partial_json: Option<String>,
        }
        #[derive(Deserialize)]
        struct Block {
            #[serde(rename = "type")]
            kind: String,
            #[serde(default)]
            id: Option<String>,
            #[serde(default)]
            name: Option<String>,
        }
        #[derive(Deserialize, Default)]
        struct Usage {
            #[serde(rename = "input_tokens", default)]
            input_tokens: Option<u64>,
            #[serde(rename = "output_tokens", default)]
            output_tokens: Option<u64>,
        }
        #[derive(Deserialize)]
        struct ErrorBody {
            #[serde(default)]
            message: Option<String>,
        }

        let Ok(parsed) = serde_json::from_str::<Frame>(frame) else {
            return Ok(());
        };
        if let Some(error) = &parsed.error {
            return Err(format!(
                "provider error ({})",
                error.message.as_deref().unwrap_or("unknown")
            ));
        }
        match parsed.kind.as_str() {
            "message_start" => {
                self.input_tokens = parsed
                    .usage
                    .and_then(|usage| usage.input_tokens)
                    .unwrap_or(0);
            }
            "content_block_start" => {
                if let Some(block) = &parsed.content_block {
                    if block.kind == "tool_use" {
                        self.pending.insert(
                            parsed.index,
                            PendingToolCall {
                                id: block.id.clone().unwrap_or_default(),
                                name: block.name.clone().unwrap_or_default(),
                                arguments: String::new(),
                            },
                        );
                    }
                }
            }
            "content_block_delta" => match parsed.delta.kind.as_deref() {
                Some("text_delta") => {
                    if let Some(text) = nonempty(&parsed.delta.text) {
                        outcome.text.push_str(text);
                        on(ProviderEvent::TextDelta(text.to_string()));
                    }
                }
                Some("thinking_delta") => {
                    if let Some(thinking) = nonempty(&parsed.delta.thinking) {
                        outcome.reasoning.push_str(thinking);
                        on(ProviderEvent::ReasoningDelta(thinking.to_string()));
                    }
                }
                Some("input_json_delta") => {
                    if let (Some(fragment), Some(pending)) = (
                        nonempty(&parsed.delta.partial_json),
                        self.pending.get_mut(&parsed.index),
                    ) {
                        pending.arguments.push_str(fragment);
                    }
                }
                _ => {}
            },
            "content_block_stop" => {
                if let Some(call) = self.pending.remove(&parsed.index) {
                    emit_call(&mut self.pending, &parsed.index, call, outcome, on);
                }
            }
            "message_delta" => {
                if let Some(output) = parsed.usage.and_then(|usage| usage.output_tokens) {
                    self.output_tokens = output;
                }
            }
            "message_stop" => {}
            _ => {}
        }
        Ok(())
    }

    fn finish(
        &mut self,
        outcome: &mut StreamOutcome,
        on: &(dyn Fn(ProviderEvent) + Send + Sync),
    ) -> Result<(), String> {
        for (index, call) in std::mem::take(&mut self.pending) {
            emit_call(&mut self.pending, &index, call, outcome, on);
        }
        let usage = (self.input_tokens + self.output_tokens)
            .checked_add(0)
            .filter(|total| *total > 0);
        outcome.total_tokens = usage;
        on(ProviderEvent::Done { usage });
        Ok(())
    }
}

/// Moves an assembled call into the outcome. `pending` is unused after removal;
/// the signature keeps call sites uniform.
fn emit_call(
    _pending: &mut BTreeMap<usize, PendingToolCall>,
    index: &usize,
    call: PendingToolCall,
    outcome: &mut StreamOutcome,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) {
    on(ProviderEvent::ToolCall {
        index: *index,
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    });
    outcome.calls.push(CompletedToolCall {
        index: *index,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
    });
}

fn anthropic_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn anthropic_request(
    base_url: &str,
    model: &str,
    max_tokens: u32,
    temperature: Option<f64>,
    messages: &[TurnMessage],
    tools: &[ToolSpec],
) -> (String, Value) {
    let system: Vec<&String> = messages
        .iter()
        .filter_map(|message| match message {
            TurnMessage::System(text) => Some(text),
            _ => None,
        })
        .collect();

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages
            .iter()
            .filter_map(anthropic_message)
            .collect::<Vec<_>>(),
        "stream": true,
    });
    if !system.is_empty() {
        body["system"] = json!(system
            .into_iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n\n"));
    }
    if let Some(temperature) = temperature {
        body["temperature"] = json!(temperature);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            }))
            .collect::<Vec<_>>());
    }
    (anthropic_url(base_url), body)
}

fn anthropic_message(message: &TurnMessage) -> Option<Value> {
    match message {
        TurnMessage::System(_) => None,
        TurnMessage::User(text) => Some(json!({
            "role": "user",
            "content": [{"type": "text", "text": text}],
        })),
        TurnMessage::Assistant { text, calls } => {
            let mut content = Vec::new();
            if !text.is_empty() {
                content.push(json!({"type": "text", "text": text}));
            }
            for call in calls {
                let input = serde_json::from_str::<Value>(&call.arguments).unwrap_or(json!({}));
                content.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": input,
                }));
            }
            if content.is_empty() {
                content.push(json!({"type": "text", "text": ""}));
            }
            Some(json!({"role": "assistant", "content": content}))
        }
        TurnMessage::ToolResult {
            call_id, content, ..
        } => Some(json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": call_id,
                "content": content,
            }],
        })),
    }
}

// --- Shared SSE plumbing ---------------------------------------------------------

/// POSTs `body` and folds the SSE stream frame by frame. Non-2xx bodies are plain
/// JSON errors; `data: [DONE]` or end-of-stream ends the turn.
async fn stream_sse<A: Adapter>(
    client: &reqwest::Client,
    url: String,
    headers: Vec<(&str, String)>,
    body: Value,
    cancel: &AtomicBool,
    adapter: &mut A,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) -> Result<StreamOutcome, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }

    let mut request = client.post(&url).json(&body);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| transport_error(&error))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(describe_http_error(status.as_u16(), &text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut outcome = StreamOutcome::default();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let chunk = match tokio::time::timeout(REQUEST_TIMEOUT, stream.next()).await {
            Ok(chunk) => chunk,
            Err(_elapsed) => return Err("the provider stream timed out".to_string()),
        };
        let Some(chunk) = chunk.transpose().map_err(|error| transport_error(&error))? else {
            break;
        };

        buffer.extend_from_slice(&chunk);
        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)]);
            let Some(payload) = line.trim_end_matches('\r').strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                adapter.finish(&mut outcome, on)?;
                return Ok(outcome);
            }
            if payload.is_empty() {
                continue;
            }
            adapter.fold(payload, &mut outcome, on)?;
        }
    }

    adapter.finish(&mut outcome, on)?;
    Ok(outcome)
}

fn transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the provider did not respond in time; try again".to_string()
    } else if error.is_connect() {
        format!("could not reach the provider: {error}")
    } else {
        format!("provider request failed: {error}")
    }
}

/// Turns a non-2xx body into one readable line. Both wire formats nest the
/// message under an `error` object.
fn describe_http_error(status: u16, text: &str) -> String {
    #[derive(Deserialize)]
    struct ErrorBody {
        error: Option<Value>,
    }

    let detail = serde_json::from_str::<ErrorBody>(text)
        .ok()
        .and_then(|body| body.error)
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| Some(error.to_string()))
        })
        .unwrap_or_else(|| text.chars().take(300).collect());
    format!("provider returned HTTP {status}: {detail}")
}
