//! The CLI entry: one ask, one turn, through the same loop the GUI uses.

use std::io::Write as _;
use std::sync::Arc;

use crate::chat::{
    load_chat_settings, new_message_id, send_turn_with_projects, ChatContext, ChatEvent,
    ChatSendRequest, ChatSink,
};

/// `grove ask "question" [--project <path>] [--json]`. Streams assistant text to
/// stdout (reasoning to stderr), then prints a `sources:` block; `--json` prints
/// only the final message as JSON.
pub fn run_ask(args: &[String]) -> Result<(), String> {
    let mut json = false;
    let mut project: Option<String> = None;
    let mut question: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--json" => json = true,
            "--project" => {
                index += 1;
                let value = args
                    .get(index)
                    .ok_or_else(|| "--project needs a path".to_string())?;
                project = Some(value.clone());
            }
            other if other.starts_with("--project=") => {
                project = Some(other["--project=".len()..].to_string());
            }
            other => question.push(other),
        }
        index += 1;
    }
    let text = question.join(" ");
    if text.trim().is_empty() {
        return Err("ask needs a question: grove ask \"what changed?\"".to_string());
    }

    let settings = load_chat_settings()?;
    let mut projects = crate::chat::load_registered_projects()?;
    if let Some(given) = &project {
        let canonical = std::fs::canonicalize(given)
            .map_err(|error| format!("{given}: {error}"))?
            .to_string_lossy()
            .into_owned();
        if !projects.contains(&canonical) {
            projects.push(canonical);
        }
    }

    let request = ChatSendRequest {
        turn_id: format!("cli-{}", new_message_id(&text)),
        text,
        context: ChatContext {
            project_path: project,
            file_path: None,
        },
    };

    let sink = Arc::new(CliSink { json });
    let final_message = tauri::async_runtime::block_on(send_turn_with_projects(
        sink,
        settings,
        Some(projects),
        request,
    ))?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&final_message).map_err(|error| error.to_string())?
        );
    } else if !final_message.citations.is_empty() {
        println!();
        println!("sources:");
        for citation in &final_message.citations {
            println!("  - {}", citation.label);
        }
    }
    Ok(())
}

/// Prints streamed text as it arrives; reasoning goes to stderr so stdout stays
/// parseable.
struct CliSink {
    json: bool,
}

impl ChatSink for CliSink {
    fn emit(&self, event: &ChatEvent) {
        match event {
            ChatEvent::Delta { text, .. } => {
                if !self.json {
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
            }
            ChatEvent::Reasoning { text, .. } => {
                if !self.json {
                    eprint!("{text}");
                    let _ = std::io::stderr().flush();
                }
            }
            ChatEvent::Tool { .. } => {}
            ChatEvent::Done { .. } => {
                if !self.json {
                    println!();
                    let _ = std::io::stdout().flush();
                }
            }
            ChatEvent::Error { message, .. } => {
                eprintln!("error: {message}");
            }
        }
    }
}
