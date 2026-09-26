//! The pre-send sheet's content: exactly what the next turn's first request
//! would carry, measured from the same plan the turn loop sends.

use serde::Serialize;

use crate::chat::cost_caps::estimate_tokens;
use crate::chat::installed_cli::{cli_prompt, cli_request};
use crate::chat::provider::build_request;
use crate::chat::turn_plan::{destination, plan_turn, turn_guard, TurnPlan};
use crate::chat::{provider_kind, ChatSendRequest, ChatSettings, ProviderKindWire};

/// One named part of the request and its size in bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPart {
    pub label: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPreview {
    /// Host, or the delegated CLI.
    pub destination: String,
    pub loopback: bool,
    pub provider: ProviderKindWire,
    pub model: String,
    /// The system prompt without the rule files (listed on their own).
    pub system_prompt_bytes: u64,
    pub tool_schema_bytes: u64,
    pub rule_files: Vec<PreviewPart>,
    /// Diffs attached to the question, when the turn carries a snapshot.
    pub ambient: Option<PreviewPart>,
    pub question_bytes: u64,
    pub history_turns: u32,
    pub history_bytes: u64,
    pub omitted_turns: u32,
    /// Registered projects left out because they are on the never-send list.
    pub hidden_projects: u32,
    /// The whole first request, exactly as it would be sent.
    pub total_bytes: u64,
    pub estimated_tokens: u64,
    /// Why the turn would be refused, when it would be.
    pub blocked: Option<String>,
}

/// Measures the turn `request` would start, without sending anything.
pub fn preview_turn(
    settings: &ChatSettings,
    request: &ChatSendRequest,
) -> Result<ChatPreview, String> {
    let plan = plan_turn(settings, None, request)?;
    let total = first_request_bytes(settings, &plan);
    let rules: usize = plan.rule_files.iter().map(|file| file.text.len()).sum();
    let snapshot = plan
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.text.len())
        .unwrap_or(0);
    Ok(ChatPreview {
        destination: destination(settings),
        loopback: plan.loopback,
        provider: settings.provider,
        model: settings.model.clone(),
        system_prompt_bytes: plan.system.len().saturating_sub(rules) as u64,
        tool_schema_bytes: serde_json::to_string(&tool_schemas(&plan)).map_or(0, |text| text.len())
            as u64,
        rule_files: plan
            .rule_files
            .iter()
            .map(|file| part(&file.name, file.text.len()))
            .collect(),
        ambient: plan
            .snapshot
            .as_ref()
            .map(|snapshot| part(&snapshot.label, snapshot.text.len())),
        question_bytes: plan.question.len().saturating_sub(snapshot) as u64,
        history_turns: plan.history.turns as u32,
        history_bytes: plan.history.bytes as u64,
        omitted_turns: plan.history.omitted as u32,
        hidden_projects: plan.hidden_projects as u32,
        total_bytes: total as u64,
        estimated_tokens: estimate_tokens(total),
        blocked: turn_guard(settings, request).err(),
    })
}

fn part(label: &str, bytes: usize) -> PreviewPart {
    PreviewPart {
        label: label.to_string(),
        bytes: bytes as u64,
    }
}

fn tool_schemas(plan: &TurnPlan) -> Vec<serde_json::Value> {
    plan.specs
        .iter()
        .map(|spec| serde_json::json!([spec.name, spec.description, spec.parameters]))
        .collect()
}

/// The serialized size of the first request the turn would send.
fn first_request_bytes(settings: &ChatSettings, plan: &TurnPlan) -> usize {
    let messages = plan.messages();
    let body = match provider_kind(settings.provider) {
        Some(kind) => {
            build_request(
                kind,
                &settings.base_url,
                &settings.model,
                settings.max_tokens,
                settings.temperature,
                &messages,
                &plan.specs,
            )
            .body
        }
        None => cli_request(settings, &plan.system, &cli_prompt(&messages)),
    };
    body.to_string().len()
}
