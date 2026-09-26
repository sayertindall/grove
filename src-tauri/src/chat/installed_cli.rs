//! Delegation to a locally installed agent CLI (`claude` or `codex`). The CLI
//! answers with its own authentication and model; Grove's tool loop is off, so
//! the conversation and the ambient diffs travel in the prompt instead. Each CLI
//! runs with its own tools disabled or sandboxed read-only, from an empty
//! scratch directory, so nothing it does can touch a repository.
//!
//! Flags verified against `claude --help` (2.1) and `codex exec --help` (0.157):
//! `claude -p --output-format stream-json --verbose --include-partial-messages
//! --tools "" --no-session-persistence --setting-sources "" --strict-mcp-config
//! --system-prompt <text>` and `codex exec --json --sandbox read-only
//! --skip-git-repo-check --ephemeral --color never -C <dir> -`, prompt on stdin.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::chat::provider::{ProviderEvent, StreamOutcome, TurnMessage};
use crate::chat::{ChatSettings, CliCommand, LocalModelServer};

/// Directories a GUI app's minimal PATH lacks but CLIs are installed in.
const EXTRA_BIN_DIRS: [&str; 3] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Whether the CLI is installed, for the settings list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn binary_name(command: CliCommand) -> &'static str {
    match command {
        CliCommand::Claude => "claude",
        CliCommand::Codex => "codex",
    }
}

/// The CLI on PATH, else in the usual install directories.
pub fn locate(command: CliCommand) -> Option<PathBuf> {
    let name = binary_name(command);
    let home_bins = dirs::home_dir()
        .map(|home| vec![home.join(".local/bin"), home.join(".claude/local")])
        .unwrap_or_default();
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(EXTRA_BIN_DIRS.iter().map(PathBuf::from))
        .chain(home_bins)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Locates the CLI and asks it for its version.
pub fn cli_status(command: CliCommand) -> CliStatus {
    let Some(path) = locate(command) else {
        return CliStatus {
            found: false,
            path: None,
            version: None,
        };
    };
    let version = Command::new(&path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|version| !version.is_empty());
    CliStatus {
        found: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
    }
}

/// The conversation as one prompt: replayed turns as a transcript, then the
/// question (which already carries the attached diffs).
pub fn cli_prompt(messages: &[TurnMessage]) -> String {
    messages
        .iter()
        .filter_map(|message| match message {
            TurnMessage::System(_) => None,
            TurnMessage::User(text) => Some(format!("User:\n{text}")),
            TurnMessage::Assistant { text, .. } if text.is_empty() => None,
            TurnMessage::Assistant { text, .. } => Some(format!("Assistant:\n{text}")),
            TurnMessage::ToolResult { name, content, .. } => {
                Some(format!("Tool result ({name}):\n{content}"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What the CLI is given, as one JSON value: measured, capped, and cached like
/// an HTTP request body.
pub fn cli_request(settings: &ChatSettings, system: &str, prompt: &str) -> Value {
    json!({
        "cli": binary_name(settings.cli_command),
        "model": settings.model,
        "localServer": settings.cli_local_server,
        "system": system,
        "prompt": prompt,
    })
}

fn cli_arguments(settings: &ChatSettings, system: &str, scratch: &Path) -> Vec<String> {
    let mut args: Vec<String> = match settings.cli_command {
        CliCommand::Claude => [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            "",
            "--no-session-persistence",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--system-prompt",
            system,
        ]
        .map(str::to_string)
        .to_vec(),
        CliCommand::Codex => [
            "exec",
            "--json",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "-C",
        ]
        .map(str::to_string)
        .into_iter()
        .chain(std::iter::once(scratch.to_string_lossy().into_owned()))
        .collect(),
    };
    args.extend(model_arguments(settings));
    if settings.cli_command == CliCommand::Codex {
        args.push("-".to_string());
    }
    args
}

fn model_arguments(settings: &ChatSettings) -> Vec<String> {
    let flag = match settings.cli_command {
        CliCommand::Claude => "--model",
        CliCommand::Codex => "-m",
    };
    let model = settings.model.trim();
    let model = if model.is_empty() {
        Vec::new()
    } else {
        vec![flag.to_string(), model.to_string()]
    };
    let local = match (settings.cli_command, settings.cli_local_server) {
        (CliCommand::Codex, Some(LocalModelServer::Ollama)) => {
            vec!["--oss", "--local-provider", "ollama"]
        }
        (CliCommand::Codex, Some(LocalModelServer::Lmstudio)) => {
            vec!["--oss", "--local-provider", "lmstudio"]
        }
        _ => Vec::new(),
    };
    model
        .into_iter()
        .chain(local.into_iter().map(str::to_string))
        .collect()
}

/// Codex takes the system prompt as the head of its stdin prompt.
fn stdin_text(settings: &ChatSettings, system: &str, prompt: &str) -> String {
    match settings.cli_command {
        CliCommand::Claude => prompt.to_string(),
        CliCommand::Codex => format!("{system}\n\n---\n\n{prompt}"),
    }
}

/// Runs the CLI to completion on the blocking pool, forwarding text and
/// reasoning as they arrive. Cancellation kills the process.
pub async fn stream_cli(
    settings: ChatSettings,
    system: String,
    prompt: String,
    cancel: Arc<AtomicBool>,
    on: Arc<dyn Fn(ProviderEvent) + Send + Sync>,
) -> Result<StreamOutcome, String> {
    crate::commands::blocking(move || run_cli(&settings, &system, &prompt, &cancel, on.as_ref()))
        .await
}

fn run_cli(
    settings: &ChatSettings,
    system: &str,
    prompt: &str,
    cancel: &Arc<AtomicBool>,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) -> Result<StreamOutcome, String> {
    let name = binary_name(settings.cli_command);
    let binary = locate(settings.cli_command)
        .ok_or_else(|| format!("the {name} CLI is not installed or not on PATH"))?;
    let scratch = std::env::temp_dir().join("grove-cli-turn");
    std::fs::create_dir_all(&scratch).map_err(|error| format!("{}: {error}", scratch.display()))?;
    let mut child = Command::new(&binary)
        .args(cli_arguments(settings, system, &scratch))
        .current_dir(&scratch)
        .env("PATH", search_path(&binary))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{name}: {error}"))?;
    feed_stdin(&mut child, stdin_text(settings, system, prompt));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{name}: no stdout"))?;
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let watchdog = spawn_watchdog(Arc::clone(&child), Arc::clone(cancel));
    let folded = fold_output(settings.cli_command, stdout, on);
    watchdog.store(true, Ordering::Relaxed);
    let status = child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .wait();
    finish_run(name, folded, status.ok(), stderr, cancel)
}

/// The binary's own directory first, so a CLI that execs siblings finds them.
fn search_path(binary: &Path) -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let own = binary
        .parent()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    [own, inherited, EXTRA_BIN_DIRS.join(":")].join(":")
}

/// Writes the prompt on its own thread so a large prompt cannot deadlock
/// against a CLI that is already writing to stdout.
fn feed_stdin(child: &mut Child, text: String) {
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
}

/// Kills the child when the turn is cancelled; returns the flag that stops it.
fn spawn_watchdog(child: Arc<Mutex<Child>>, cancel: Arc<AtomicBool>) -> Arc<AtomicBool> {
    let finished = Arc::new(AtomicBool::new(false));
    let done = Arc::clone(&finished);
    std::thread::spawn(move || {
        while !done.load(Ordering::Relaxed) {
            if cancel.load(Ordering::Relaxed) {
                let _ = child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .kill();
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    });
    finished
}

fn fold_output(
    command: CliCommand,
    stdout: impl Read,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) -> Result<StreamOutcome, String> {
    let mut outcome = StreamOutcome::default();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match command {
            CliCommand::Claude => fold_claude_event(&event, &mut outcome, on)?,
            CliCommand::Codex => fold_codex_event(&event, &mut outcome, on)?,
        }
    }
    Ok(outcome)
}

fn finish_run(
    name: &str,
    folded: Result<StreamOutcome, String>,
    status: Option<std::process::ExitStatus>,
    stderr: Option<impl Read>,
    cancel: &AtomicBool,
) -> Result<StreamOutcome, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }
    let outcome = folded?;
    let failed = status.is_none_or(|status| !status.success());
    if failed && outcome.text.is_empty() {
        return Err(format!(
            "{name} exited without an answer: {}",
            stderr_tail(stderr)
        ));
    }
    Ok(outcome)
}

fn stderr_tail(stderr: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut stderr) = stderr {
        let _ = stderr.read_to_string(&mut text);
    }
    let trimmed = text.trim();
    let start = trimmed
        .char_indices()
        .rev()
        .nth(400)
        .map_or(0, |(index, _)| index);
    let tail = &trimmed[start..];
    if tail.is_empty() {
        "no error output".to_string()
    } else {
        tail.to_string()
    }
}

/// `claude --output-format stream-json`: partial text/thinking deltas arrive as
/// `stream_event`s; the closing `result` line carries usage or the failure.
fn fold_claude_event(
    event: &Value,
    outcome: &mut StreamOutcome,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) -> Result<(), String> {
    let delta = &event["event"]["delta"];
    match (event["type"].as_str(), delta["type"].as_str()) {
        (Some("stream_event"), Some("text_delta")) => {
            push_text(outcome, delta["text"].as_str(), on)
        }
        (Some("stream_event"), Some("thinking_delta")) => {
            push_reasoning(outcome, delta["thinking"].as_str(), on)
        }
        (Some("result"), _) => return claude_result(event, outcome),
        _ => {}
    }
    Ok(())
}

fn claude_result(event: &Value, outcome: &mut StreamOutcome) -> Result<(), String> {
    if event["is_error"].as_bool() == Some(true) {
        let reason = event["result"]
            .as_str()
            .unwrap_or("the claude CLI reported an error");
        return Err(format!("claude: {reason}"));
    }
    outcome.total_tokens = usage_total(&event["usage"]);
    if outcome.text.is_empty() {
        outcome.text = event["result"].as_str().unwrap_or_default().to_string();
    }
    Ok(())
}

/// `codex exec --json`: whole messages arrive as completed items; the turn's
/// usage or failure closes the stream.
fn fold_codex_event(
    event: &Value,
    outcome: &mut StreamOutcome,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) -> Result<(), String> {
    let item = &event["item"];
    match (event["type"].as_str(), item["type"].as_str()) {
        (Some("item.completed"), Some("agent_message")) => {
            let separator = (!outcome.text.is_empty()).then_some("\n\n");
            push_text(outcome, separator, on);
            push_text(outcome, item["text"].as_str(), on);
        }
        (Some("item.completed"), Some("reasoning")) => {
            push_reasoning(outcome, item["text"].as_str(), on)
        }
        (Some("turn.completed"), _) => outcome.total_tokens = usage_total(&event["usage"]),
        (Some("turn.failed"), _) | (Some("error"), _) => return Err(codex_failure(event)),
        _ => {}
    }
    Ok(())
}

fn codex_failure(event: &Value) -> String {
    let message = event["error"]["message"]
        .as_str()
        .or_else(|| event["message"].as_str())
        .unwrap_or("the codex CLI reported an error");
    format!("codex: {message}")
}

fn usage_total(usage: &Value) -> Option<u64> {
    let input = usage["input_tokens"].as_u64()?;
    Some(input + usage["output_tokens"].as_u64().unwrap_or(0))
}

fn push_text(
    outcome: &mut StreamOutcome,
    text: Option<&str>,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) {
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        outcome.text.push_str(text);
        on(ProviderEvent::TextDelta(text.to_string()));
    }
}

fn push_reasoning(
    outcome: &mut StreamOutcome,
    text: Option<&str>,
    on: &(dyn Fn(ProviderEvent) + Send + Sync),
) {
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        outcome.reasoning.push_str(text);
        on(ProviderEvent::ReasoningDelta(text.to_string()));
    }
}
