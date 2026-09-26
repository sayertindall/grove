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
    save_chat_settings, ChatContext, ChatSendRequest, ChatSettings, ProviderKindWire,
};
use serde_json::Value;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Listener};

/// Every test in this binary shares one process-wide data directory, so they queue.
static ENV: Mutex<()> = Mutex::new(());
static FIXTURES: AtomicU32 = AtomicU32::new(0);

/// The channels the panel listens on, in the order a healthy turn uses them.
const CHANNELS: [&str; 5] = [
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
    };
    save_chat_settings(&settings).expect("settings persist");
    settings
}

fn start_turn(app: &App<MockRuntime>, turn_id: &str, text: &str) {
    let request = ChatSendRequest {
        turn_id: turn_id.to_string(),
        text: text.to_string(),
        context: ChatContext::default(),
    };
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
        vec!["delta", "delta", "done"],
        "one turn emits its deltas then a done: {events:#?}"
    );

    for (channel, payload) in &events {
        assert_eq!(
            payload["turnId"].as_str(),
            Some("turn-abc"),
            "{channel} must address the turn the panel is rendering: {payload}"
        );
    }

    assert_eq!(events[0].0, "grove://chat-delta");
    assert_eq!(events[0].1["text"].as_str(), Some("Hello"));
    assert_eq!(events[1].1["text"].as_str(), Some(" world"));

    let done = &events[2].1;
    assert_eq!(events[2].0, "grove://chat-done");
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

    let events = drain_until_settled(&receiver);
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
