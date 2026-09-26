//! One turn, end to end, onto the channels the webview subscribes to: the real
//! `chat_send` command, the real event sink, and a loopback SSE provider, with the
//! payloads asserted field by field against the contract in `src/types/grove.ts`.
//!
//! This is the check the released build lacked. Every streaming event the panel
//! reads is addressed by its turn id, so a payload without `turnId` renders
//! nothing and leaves the turn spinning forever — which is exactly what shipped.

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use grove_lib::chat::{
    save_chat_settings, ChatContext, ChatSendRequest, ChatSettings, CostCaps, ProviderKindWire,
    QuickAction,
};
use serde_json::Value;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Listener};

/// Every test in this binary shares one process-wide data directory, so they queue.
static ENV: Mutex<()> = Mutex::new(());
static FIXTURES: AtomicU32 = AtomicU32::new(0);

/// The channels the panel listens on, in the order a healthy turn uses them.
const CHANNELS: [&str; 6] = [
    "grove://chat-egress",
    "grove://chat-delta",
    "grove://chat-reasoning",
    "grove://chat-tool",
    "grove://chat-done",
    "grove://chat-error",
];

/// A provider stub that never outlives its deadline, so a turn that fails before
/// connecting surfaces as an assertion about the request, not a hung test.
struct Stub {
    base_url: String,
    saw_request: Arc<AtomicBool>,
    finished: std::thread::JoinHandle<()>,
}

/// Answers one request with the given SSE frames.
fn serve_stream(frames: String) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("listener address").port();
    let saw_request = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&saw_request);
    let finished = std::thread::spawn(move || {
        let Some(mut stream) = accept_before_deadline(&listener) else {
            return;
        };
        let request = read_request(&stream);
        seen.store(true, Ordering::Relaxed);
        assert!(
            request.contains("\"stream\":true"),
            "the turn must ask the provider to stream: {request}"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{frames}data: [DONE]\n\n"
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    });
    Stub {
        base_url: format!("http://127.0.0.1:{port}"),
        saw_request,
        finished,
    }
}

/// Refuses one request the way a misconfigured provider does.
fn serve_refusal() -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("listener address").port();
    let saw_request = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&saw_request);
    let finished = std::thread::spawn(move || {
        let Some(mut stream) = accept_before_deadline(&listener) else {
            return;
        };
        let _ = read_request(&stream);
        seen.store(true, Ordering::Relaxed);
        let body =
            r#"{"error":{"message":"boom: insufficient balance","type":"invalid_request_error"}}"#;
        let response = format!(
            "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    });
    Stub {
        base_url: format!("http://127.0.0.1:{port}"),
        saw_request,
        finished,
    }
}

/// Accepts one connection, or gives up so the test can report the real failure.
fn accept_before_deadline(listener: &TcpListener) -> Option<TcpStream> {
    listener
        .set_nonblocking(true)
        .expect("non-blocking listener");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).expect("blocking stream");
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("read timeout");
                return Some(stream);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
    None
}

/// Reads one HTTP request far enough to prove the body arrived.
fn read_request(stream: &TcpStream) -> String {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
        let blank = line == "\r\n" || line == "\n";
        head.push_str(&line);
        if blank {
            break;
        }
    }
    let mut body = vec![0u8; length];
    let _ = reader.read_exact(&mut body);
    format!("{head}{}", String::from_utf8_lossy(&body))
}

fn openai_delta(text: &str) -> String {
    let frame = serde_json::json!({
        "choices": [{ "delta": { "content": text }, "index": 0 }],
    });
    format!("data: {frame}\n\n")
}

/// A store of its own: no registered projects, no history, no real key.
fn isolate_store() -> PathBuf {
    let unique = FIXTURES.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("grove-chat-events-{}-{unique}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("fixture store");
    // A registered-project store with nothing registered: the turn reads it for
    // its workspace manifest, and an unreadable one fails the turn.
    std::fs::write(dir.join("projects.json"), r#"{"projects":[]}"#)
        .expect("fixture projects store");
    std::env::set_var("GROVE_DATA_DIR", &dir);
    std::env::set_var("GROVE_CHAT_KEY", "test-key");
    dir
}

fn mock_app() -> App<MockRuntime> {
    mock_builder()
        .build(mock_context(noop_assets()))
        .expect("mock app")
}

/// Collects every chat payload the app emits, tagged with its channel.
fn collect(app: &App<MockRuntime>) -> mpsc::Receiver<(String, Value)> {
    let (sender, receiver) = mpsc::channel();
    for channel in CHANNELS {
        let sender = sender.clone();
        app.listen(channel, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).expect("payload is JSON");
            let _ = sender.send((channel.to_string(), payload));
        });
    }
    receiver
}

/// Blocks until the turn settles, returning every payload it saw.
fn drain_until_settled(receiver: &mpsc::Receiver<(String, Value)>) -> Vec<(String, Value)> {
    let mut seen = Vec::new();
    loop {
        match receiver.recv_timeout(Duration::from_secs(20)) {
            Ok(event) => {
                let settled = event.0 == "grove://chat-done" || event.0 == "grove://chat-error";
                seen.push(event);
                if settled {
                    return seen;
                }
            }
            Err(error) => panic!(
                "the panel would wait forever: no event within 20s after {} payloads: {error}",
                seen.len()
            ),
        }
    }
}

/// Points the turn at `base_url` and stores the key the loop expects.
fn settings_for(base_url: String) -> ChatSettings {
    let settings = ChatSettings {
        provider: ProviderKindWire::OpenAiCompatible,
        base_url,
        model: "deepseek-flash".to_string(),
        max_tokens: 256,
        temperature: None,
        allow_cloud_egress: false,
        ..ChatSettings::default()
    };
    save_chat_settings(&settings).expect("settings persist");
    settings
}

fn start_turn(app: &App<MockRuntime>, turn_id: &str, text: &str) {
    start_request(
        app,
        ChatSendRequest {
            turn_id: turn_id.to_string(),
            text: text.to_string(),
            context: ChatContext::default(),
            action: None,
        },
    );
}

fn start_request(app: &App<MockRuntime>, request: ChatSendRequest) {
    let handle = app.handle().clone();
    tauri::async_runtime::block_on(async move {
        grove_lib::commands::chat_send(handle, request)
            .await
            .expect("turn accepted");
    });
}

/// Joins the stub and reports whether the turn actually reached it.
fn finish_stub(stub: Stub) {
    let Stub {
        saw_request,
        finished,
        ..
    } = stub;
    assert!(finished.join().is_ok(), "the stub provider thread panicked");
    assert!(
        saw_request.load(Ordering::Relaxed),
        "the turn never reached the provider"
    );
}

#[test]
fn one_turn_reaches_the_webview_with_addressable_payloads() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let mut frames = openai_delta("Hello");
    frames.push_str(&openai_delta(" world"));
    let stub = serve_stream(frames);
    settings_for(stub.base_url.clone());

    let app = mock_app();
    let receiver = collect(&app);
    start_turn(&app, "turn-abc", "say hello");

    let events = drain_until_settled(&receiver);
    finish_stub(stub);

    let kinds: Vec<&str> = events
        .iter()
        .map(|(_, payload)| payload["kind"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        kinds,
        vec!["egress", "delta", "delta", "done"],
        "one turn reports what it sends, then its deltas, then a done: {events:#?}"
    );

    for (channel, payload) in &events {
        assert_eq!(
            payload["turnId"].as_str(),
            Some("turn-abc"),
            "{channel} must address the turn the panel is rendering: {payload}"
        );
    }

    assert_eq!(events[0].0, "grove://chat-egress");
    assert_eq!(events[0].1["loopback"].as_bool(), Some(true));
    assert!(
        events[0].1["sentBytes"]
            .as_u64()
            .is_some_and(|bytes| bytes > 0),
        "the counter names the bytes that left: {}",
        events[0].1
    );
    assert_eq!(events[1].0, "grove://chat-delta");
    assert_eq!(events[1].1["text"].as_str(), Some("Hello"));
    assert_eq!(events[2].1["text"].as_str(), Some(" world"));

    let done = &events[3].1;
    assert_eq!(events[3].0, "grove://chat-done");
    assert_eq!(
        done["message"]["text"].as_str(),
        Some("Hello world"),
        "the final message carries the streamed answer: {done}"
    );
    assert_eq!(done["message"]["role"].as_str(), Some("assistant"));
    assert_eq!(done["message"]["model"].as_str(), Some("deepseek-flash"));
    assert!(
        done["message"]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "the final message is persisted under an id: {done}"
    );
    assert!(
        done["message"]["citations"].is_array(),
        "citations are always an array, never null: {done}"
    );
    assert!(
        done.get("totalTokens").is_some(),
        "token usage travels as camelCase: {done}"
    );
    assert!(
        done["message"].get("replay").is_none(),
        "replayed tool payloads stay on disk, never on the webview channel: {done}"
    );
    assert_eq!(done["message"]["cached"].as_bool(), Some(false));

    let stored = grove_lib::chat::load_chat_history().expect("history readable");
    assert_eq!(stored.len(), 2, "the turn persists its question and answer");
    assert_eq!(stored[0].text, "say hello");
    assert_eq!(stored[1].text, "Hello world");
}

#[test]
fn a_provider_failure_settles_the_turn_instead_of_hanging() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let stub = serve_refusal();
    settings_for(stub.base_url.clone());

    let app = mock_app();
    let receiver = collect(&app);
    start_turn(&app, "turn-refused", "say hello");

    let events: Vec<(String, Value)> = drain_until_settled(&receiver)
        .into_iter()
        .filter(|(channel, _)| channel != "grove://chat-egress")
        .collect();
    finish_stub(stub);

    assert_eq!(
        events.len(),
        1,
        "a refused turn reports exactly one error: {events:#?}"
    );
    let (channel, payload) = &events[0];
    assert_eq!(channel, "grove://chat-error");
    assert_eq!(payload["kind"].as_str(), Some("error"));
    assert_eq!(
        payload["turnId"].as_str(),
        Some("turn-refused"),
        "the error must address the turn the panel is rendering: {payload}"
    );
    let message = payload["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("boom") && message.contains("402"),
        "the provider's own words and status survive: {message}"
    );
    assert_eq!(payload["retryable"].as_bool(), Some(false));

    let stored = grove_lib::chat::load_chat_history().expect("history readable");
    assert!(
        stored.is_empty(),
        "a refused turn persists nothing: {stored:#?}"
    );
}

/// Answers one request with an exact response body, byte for byte.
fn serve_raw(response: String) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let port = listener.local_addr().expect("listener address").port();
    let saw_request = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&saw_request);
    let finished = std::thread::spawn(move || {
        let Some(mut stream) = accept_before_deadline(&listener) else {
            return;
        };
        let _ = read_request(&stream);
        seen.store(true, Ordering::Relaxed);
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    });
    Stub {
        base_url: format!("http://127.0.0.1:{port}"),
        saw_request,
        finished,
    }
}

fn sse_head() -> &'static str {
    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
}

fn plain_json_head() -> &'static str {
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n"
}

/// Waits for the turn to settle and returns its final error payload. A
/// mid-stream failure may legitimately arrive after partial deltas.
fn error_event(receiver: &mpsc::Receiver<(String, Value)>) -> Value {
    let events = drain_until_settled(receiver);
    let last = events.last().expect("the turn settles with an event");
    assert_eq!(
        last.0, "grove://chat-error",
        "the turn fails once: {events:#?}"
    );
    assert_eq!(last.1["kind"].as_str(), Some("error"));
    assert_eq!(last.1["retryable"].as_bool(), Some(false));
    last.1.clone()
}

#[test]
fn sse_frames_parse_across_crlf_multiline_and_unterminated_done() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    // CRLF terminators, one JSON frame spread over several `data:` lines, and
    // a `[DONE]` with no trailing newline after it.
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n",
        "\r\n",
        "data: {\r\n",
        "data: \"choices\": [{\"delta\": {\"content\": \"b\"}}]\r\n",
        "data: }\r\n",
        "\r\n",
        "data: [DONE]\n"
    );
    let stub = serve_raw(format!("{}{body}", sse_head()));
    settings_for(stub.base_url.clone());

    let app = mock_app();
    let receiver = collect(&app);
    start_turn(&app, "turn-crlf", "say hello");
    let events = drain_until_settled(&receiver);
    finish_stub(stub);

    let text: String = events
        .iter()
        .filter(|(channel, _)| channel == "grove://chat-delta")
        .filter_map(|(_, payload)| payload["text"].as_str())
        .collect();
    assert_eq!(
        text, "ab",
        "both frames must arrive, whatever the line endings: {events:#?}"
    );
    assert!(
        events
            .iter()
            .any(|(channel, _)| channel == "grove://chat-done"),
        "an unterminated [DONE] still ends the turn: {events:#?}"
    );
}

#[test]
fn a_provider_error_frame_mid_stream_fails_the_turn_readably() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n",
        "\n",
        "data: {\"error\":{\"message\":\"quota exceeded\"}}\n",
        "\n",
        "data: [DONE]\n\n",
    );
    let stub = serve_raw(format!("{}{body}", sse_head()));
    settings_for(stub.base_url.clone());

    let app = mock_app();
    let receiver = collect(&app);
    start_turn(&app, "turn-errframe", "say hello");
    let payload = error_event(&receiver);
    finish_stub(stub);

    assert_eq!(payload["turnId"].as_str(), Some("turn-errframe"));
    let message = payload["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("quota exceeded"),
        "the provider's own words survive: {message}"
    );
    let stored = grove_lib::chat::load_chat_history().expect("history readable");
    assert!(
        stored.is_empty(),
        "a failed turn persists nothing: {stored:#?}"
    );
}

#[test]
fn a_non_stream_success_body_is_reported_not_rendered_as_empty() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let body = "{\"error\":{\"message\":\"model overloaded\"}}";
    let stub = serve_raw(format!("{}{body}", plain_json_head()));
    settings_for(stub.base_url.clone());

    let app = mock_app();
    let receiver = collect(&app);
    start_turn(&app, "turn-notsse", "say hello");
    let payload = error_event(&receiver);
    finish_stub(stub);

    let message = payload["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("model overloaded") && message.contains("stream"),
        "a 200 JSON error body is described readably: {message}"
    );
}

// --- Assistant: replay, findings, cost caps, summary cache -----------------------
//
// Ways these fail, written before the code they check:
// - A replayed assistant turn drops its tool calls, or keeps the calls but loses
//   their results, or pairs a result with the wrong call id: every provider
//   rejects the conversation, or the model re-reads what it already read.
// - The Anthropic replay puts a tool_result anywhere but in the user message
//   directly after its tool_use.
// - A finding outside every hunk (or in a file that did not change) reaches the
//   gutter as if it were anchored, or is dropped silently with no count.
// - A turn over its cost cap still reaches the provider, or fails with a vague
//   message, or fails without settling the panel.
// - A repeated identical request contacts the provider again, or the cached
//   answer arrives without the `cached` mark.

/// A provider that answers each request in turn with the next canned response and
/// records every request body, so a test can count and inspect what was sent.
struct Recorder {
    base_url: String,
    bodies: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

fn serve_sequence(responses: Vec<String>) -> Recorder {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    listener
        .set_nonblocking(true)
        .expect("non-blocking listener");
    let port = listener.local_addr().expect("listener address").port();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let (recorded, stopping) = (Arc::clone(&bodies), Arc::clone(&stop));
    let thread = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut served = 0usize;
        while !stopping.load(Ordering::Relaxed) && Instant::now() < deadline {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            };
            stream.set_nonblocking(false).expect("blocking stream");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let request = read_request(&stream);
            let body = request
                .split_once("\r\n\r\n")
                .map(|(_, body)| body.to_string())
                .unwrap_or_default();
            recorded.lock().expect("recorder lock").push(body);
            let response = responses.get(served).cloned().unwrap_or_else(|| {
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string()
            });
            served += 1;
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    Recorder {
        base_url: format!("http://127.0.0.1:{port}"),
        bodies,
        stop,
        thread,
    }
}

/// Stops the recorder and returns every request body it saw, parsed.
fn stop_recorder(recorder: Recorder) -> Vec<Value> {
    recorder.stop.store(true, Ordering::Relaxed);
    assert!(recorder.thread.join().is_ok(), "the recorder panicked");
    let bodies = recorder.bodies.lock().expect("recorder lock").clone();
    bodies
        .iter()
        .map(|body| serde_json::from_str(body).expect("request body is JSON"))
        .collect()
}

fn openai_answer(text: &str) -> String {
    format!("{}{}data: [DONE]\n\n", sse_head(), openai_delta(text))
}

fn openai_tool_call(id: &str, name: &str) -> String {
    let frame = serde_json::json!({
        "choices": [{ "index": 0, "delta": { "tool_calls": [{
            "index": 0, "id": id, "type": "function",
            "function": { "name": name, "arguments": "{}" },
        }]}}],
    });
    format!("{}data: {frame}\n\ndata: [DONE]\n\n", sse_head())
}

fn anthropic_answer(text: &str) -> String {
    let frames = [
        serde_json::json!({"type": "message_start", "message": {"usage": {"input_tokens": 3}}}),
        serde_json::json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        serde_json::json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        serde_json::json!({"type": "content_block_stop", "index": 0}),
        serde_json::json!({"type": "message_stop"}),
    ];
    let body: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    format!("{}{body}", sse_head())
}

/// Runs one turn to completion and returns its settling payload.
fn run_request(app: &App<MockRuntime>, request: ChatSendRequest) -> (String, Value) {
    let receiver = collect(app);
    start_request(app, request);
    drain_until_settled(&receiver)
        .pop()
        .expect("the turn settles")
}

fn plain_request(turn_id: &str, text: &str) -> ChatSendRequest {
    ChatSendRequest {
        turn_id: turn_id.to_string(),
        text: text.to_string(),
        context: ChatContext::default(),
        action: None,
    }
}

#[test]
fn replayed_history_carries_tool_calls_and_their_results_in_provider_format() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let recorder = serve_sequence(vec![
        openai_tool_call("call-1", "list_projects"),
        openai_answer("No projects are registered."),
        openai_answer("Still none."),
        anthropic_answer("None, again."),
    ]);
    let mut settings = settings_for(recorder.base_url.clone());
    let app = mock_app();

    let (channel, done) = run_request(&app, plain_request("turn-tools", "what is registered?"));
    assert_eq!(channel, "grove://chat-done", "{done}");
    let (channel, done) = run_request(&app, plain_request("turn-openai", "and now?"));
    assert_eq!(channel, "grove://chat-done", "{done}");

    settings.provider = ProviderKindWire::Anthropic;
    save_chat_settings(&settings).expect("settings persist");
    let (channel, done) = run_request(&app, plain_request("turn-anthropic", "last time?"));
    assert_eq!(channel, "grove://chat-done", "{done}");

    let bodies = stop_recorder(recorder);
    assert_eq!(
        bodies.len(),
        4,
        "tool round, answer, two replays: {bodies:#?}"
    );

    // OpenAI: the assistant's tool_calls, then a tool message answering that id,
    // then the assistant's final text, then the new question.
    let messages = bodies[2]["messages"].as_array().expect("messages");
    let roles: Vec<&str> = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        roles,
        vec!["system", "user", "assistant", "tool", "assistant", "user"],
        "the earlier turn replays its tool round: {messages:#?}"
    );
    assert_eq!(messages[2]["tool_calls"][0]["id"].as_str(), Some("call-1"));
    assert_eq!(
        messages[2]["tool_calls"][0]["function"]["name"].as_str(),
        Some("list_projects")
    );
    assert_eq!(messages[3]["tool_call_id"].as_str(), Some("call-1"));
    assert!(
        messages[3]["content"]
            .as_str()
            .is_some_and(|content| content.contains("projects")),
        "the tool's own result is replayed, not a placeholder: {}",
        messages[3]
    );
    assert_eq!(
        messages[4]["content"].as_str(),
        Some("No projects are registered.")
    );

    // Anthropic: tool_use in the assistant turn, its tool_result in the very
    // next user message, same id.
    let messages = bodies[3]["messages"].as_array().expect("messages");
    let has_tool_use = |message: &Value| {
        message["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_use"))
    };
    let use_at = messages
        .iter()
        .position(has_tool_use)
        .expect("a replayed tool_use block");
    let tool_use = messages[use_at]["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|block| block["type"] == "tool_use"))
        .expect("tool_use block");
    assert_eq!(tool_use["id"].as_str(), Some("call-1"));
    let answer = &messages[use_at + 1];
    assert_eq!(answer["role"].as_str(), Some("user"));
    assert_eq!(answer["content"][0]["type"].as_str(), Some("tool_result"));
    assert_eq!(answer["content"][0]["tool_use_id"].as_str(), Some("call-1"));
    assert!(
        bodies[3].get("system").is_some(),
        "the system prompt travels in Anthropic's own field: {}",
        bodies[3]
    );
}

/// A committed twenty-line file with line ten edited: one hunk, new lines 7-13.
fn edited_fixture() -> PathBuf {
    let unique = FIXTURES.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "grove-chat-findings-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("fixture root");
    let repository = git2::Repository::init(&root).expect("repository init");
    let lines = |edited: bool| -> String {
        (1..=20)
            .map(|line| match (line, edited) {
                (10, true) => "ten, edited\n".to_string(),
                _ => format!("line {line}\n"),
            })
            .collect()
    };
    std::fs::write(root.join("numbers.txt"), lines(false)).expect("write file");
    let mut index = repository.index().expect("index");
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .expect("stage");
    index.write().expect("index write");
    let tree = repository
        .find_tree(index.write_tree().expect("tree"))
        .expect("find tree");
    let signature = git2::Signature::now("Grove test", "grove@example.com").expect("signature");
    repository
        .commit(Some("HEAD"), &signature, &signature, "base", &tree, &[])
        .expect("commit");
    std::fs::write(root.join("numbers.txt"), lines(true)).expect("edit file");
    std::fs::canonicalize(&root).expect("canonical fixture")
}

#[test]
fn findings_outside_a_changed_hunk_are_dropped_and_counted() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let store = isolate_store();
    let project = edited_fixture();
    let project_path = project.to_string_lossy().into_owned();
    std::fs::write(
        store.join("projects.json"),
        serde_json::json!({ "projects": [project_path] }).to_string(),
    )
    .expect("register fixture");

    let findings = serde_json::json!([
        {"path": "numbers.txt", "startLine": 10, "endLine": 10, "severity": "P1",
         "title": "Edited line", "detail": "The tenth line changed."},
        {"path": "numbers.txt", "startLine": 19, "endLine": 19, "severity": "P0",
         "title": "Untouched line", "detail": "Line 19 is not part of any hunk."},
        {"path": "absent.txt", "startLine": 1, "endLine": 1, "severity": "P2",
         "title": "No such change", "detail": "This file did not change."},
    ]);
    let answer = format!("One real issue.\n\n```findings\n{findings}\n```\n");
    let recorder = serve_sequence(vec![openai_answer(&answer)]);
    settings_for(recorder.base_url.clone());
    let app = mock_app();

    let (channel, done) = run_request(
        &app,
        ChatSendRequest {
            turn_id: "turn-findings".to_string(),
            text: "review this file".to_string(),
            context: ChatContext {
                project_path: Some(project_path.clone()),
                file_path: Some("numbers.txt".to_string()),
                files: Vec::new(),
            },
            action: None,
        },
    );
    stop_recorder(recorder);
    assert_eq!(channel, "grove://chat-done", "{done}");

    let kept = done["message"]["findings"]
        .as_array()
        .expect("findings array");
    assert_eq!(kept.len(), 1, "only the in-hunk finding survives: {done}");
    assert_eq!(kept[0]["path"].as_str(), Some("numbers.txt"));
    assert_eq!(kept[0]["startLine"].as_u64(), Some(10));
    assert_eq!(kept[0]["severity"].as_str(), Some("P1"));
    assert_eq!(kept[0]["projectPath"].as_str(), Some(project_path.as_str()));
    assert_eq!(
        done["message"]["droppedFindings"].as_u64(),
        Some(2),
        "the dropped findings are counted, not hidden: {done}"
    );
    let _ = std::fs::remove_dir_all(project);
}

#[test]
fn a_turn_over_its_cost_cap_is_refused_before_anything_is_sent() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let recorder = serve_sequence(Vec::new());
    let mut settings = settings_for(recorder.base_url.clone());
    settings.caps = CostCaps {
        per_turn_tokens: Some(50),
        per_session_tokens: None,
        per_month_tokens: None,
    };
    save_chat_settings(&settings).expect("settings persist");
    let app = mock_app();

    let (channel, error) = run_request(&app, plain_request("turn-capped", "summarize everything"));
    let bodies = stop_recorder(recorder);

    assert_eq!(channel, "grove://chat-error", "{error}");
    assert_eq!(error["turnId"].as_str(), Some("turn-capped"));
    let message = error["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("per-turn cap") && message.contains("50"),
        "the refusal names the cap it hit: {message}"
    );
    assert!(
        bodies.is_empty(),
        "nothing reached the provider: {bodies:#?}"
    );
    let stored = grove_lib::chat::load_chat_history().expect("history readable");
    assert!(stored.is_empty(), "a refused turn persists nothing");
}

#[test]
fn an_identical_request_is_answered_from_the_summary_cache() {
    let _guard = ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    isolate_store();

    let recorder = serve_sequence(vec![openai_answer("The repository is empty.")]);
    let mut settings = settings_for(recorder.base_url.clone());
    settings.summary_cache = true;
    save_chat_settings(&settings).expect("settings persist");
    let app = mock_app();

    let summary = |turn_id: &str| ChatSendRequest {
        turn_id: turn_id.to_string(),
        text: "Explain this repository.".to_string(),
        context: ChatContext::default(),
        action: Some(QuickAction::ExplainRepo),
    };
    let (channel, first) = run_request(&app, summary("turn-fresh"));
    assert_eq!(channel, "grove://chat-done", "{first}");
    assert_eq!(first["message"]["cached"].as_bool(), Some(false));

    let (channel, second) = run_request(&app, summary("turn-cached"));
    let bodies = stop_recorder(recorder);
    assert_eq!(channel, "grove://chat-done", "{second}");
    assert_eq!(second["turnId"].as_str(), Some("turn-cached"));
    assert_eq!(
        second["message"]["cached"].as_bool(),
        Some(true),
        "a cache hit is marked: {second}"
    );
    assert_eq!(
        second["message"]["text"].as_str(),
        Some("The repository is empty.")
    );
    assert_eq!(bodies.len(), 1, "the repeat never reached the provider");
}
