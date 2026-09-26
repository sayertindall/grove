//! Replaying the stored conversation into a new turn. Assistant turns keep their
//! tool rounds on disk (calls and bounded results) so the next request carries
//! them in each provider's own format, and the whole replay fits a token budget
//! by dropping the oldest turns first.

use serde::{Deserialize, Serialize};

use crate::chat::provider::{CompletedToolCall, TurnMessage};
use crate::chat::{ChatMessage, ChatRole};

/// Approximate tokens (chars / 4) the replayed history may take.
pub const REPLAY_TOKEN_BUDGET: usize = 24_000;
/// A stored tool result is cut here; the live turn saw the full (capped) text.
pub const STORED_RESULT_BYTES: usize = 32 * 1024;

/// One model step of an assistant turn: its text and the tools it called, each
/// with the result the model was given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStep {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub calls: Vec<ReplayCall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub result: String,
}

impl ReplayCall {
    /// A call plus the result the model saw, bounded for storage.
    pub fn stored(call: &CompletedToolCall, result: &str) -> Self {
        ReplayCall {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
            result: bounded_result(result),
        }
    }
}

fn bounded_result(result: &str) -> String {
    if result.len() <= STORED_RESULT_BYTES {
        return result.to_string();
    }
    let mut cut = STORED_RESULT_BYTES;
    while !result.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n[result cut at {STORED_RESULT_BYTES} bytes when stored]",
        &result[..cut]
    )
}

/// The replayed messages plus what the pre-send sheet reports about them.
#[derive(Debug, Clone, Default)]
pub struct ReplayedHistory {
    pub messages: Vec<TurnMessage>,
    pub turns: usize,
    pub omitted: usize,
    pub bytes: usize,
}

/// Replays whole turns, newest kept first, until the budget is spent. A turn is
/// one user message and the assistant messages that answered it.
pub fn replay_history(history: &[ChatMessage], budget_tokens: usize) -> ReplayedHistory {
    let turns = group_turns(history);
    let mut kept: Vec<Vec<TurnMessage>> = Vec::new();
    let mut bytes = 0usize;
    for turn in turns.iter().rev() {
        let messages: Vec<TurnMessage> = turn.iter().flat_map(replay_message).collect();
        let size: usize = messages.iter().map(message_bytes).sum();
        if (bytes + size) / 4 > budget_tokens {
            break;
        }
        bytes += size;
        kept.push(messages);
    }
    ReplayedHistory {
        turns: kept.len(),
        omitted: turns.len() - kept.len(),
        messages: kept.into_iter().rev().flatten().collect(),
        bytes,
    }
}

/// Groups messages into turns that start with a user message; assistant rows
/// before the first question have nothing to answer and are skipped.
fn group_turns(history: &[ChatMessage]) -> Vec<&[ChatMessage]> {
    let starts: Vec<usize> = history
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == ChatRole::User)
        .map(|(index, _)| index)
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(position, &start)| {
            let end = starts.get(position + 1).copied().unwrap_or(history.len());
            &history[start..end]
        })
        .collect()
}

/// A user row replays as text; an assistant row replays its tool rounds, or its
/// text alone when it was stored before rounds were kept.
fn replay_message(message: &ChatMessage) -> Vec<TurnMessage> {
    if message.role == ChatRole::User {
        return vec![TurnMessage::User(message.text.clone())];
    }
    if message.replay.is_empty() {
        return vec![TurnMessage::Assistant {
            text: message.text.clone(),
            calls: Vec::new(),
        }];
    }
    message.replay.iter().flat_map(replay_step).collect()
}

fn replay_step(step: &ReplayStep) -> Vec<TurnMessage> {
    if step.calls.is_empty() && step.text.is_empty() {
        return Vec::new();
    }
    let calls = step
        .calls
        .iter()
        .enumerate()
        .map(|(index, call)| CompletedToolCall {
            index,
            id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
        })
        .collect();
    let results = step.calls.iter().map(|call| TurnMessage::ToolResult {
        call_id: call.id.clone(),
        name: call.name.clone(),
        content: call.result.clone(),
    });
    std::iter::once(TurnMessage::Assistant {
        text: step.text.clone(),
        calls,
    })
    .chain(results)
    .collect()
}

/// The text a message puts on the wire, for budgeting and the pre-send sheet.
pub fn message_bytes(message: &TurnMessage) -> usize {
    match message {
        TurnMessage::System(text) | TurnMessage::User(text) => text.len(),
        TurnMessage::Assistant { text, calls } => {
            text.len()
                + calls
                    .iter()
                    .map(|call| call.name.len() + call.arguments.len())
                    .sum::<usize>()
        }
        TurnMessage::ToolResult { content, .. } => content.len(),
    }
}
