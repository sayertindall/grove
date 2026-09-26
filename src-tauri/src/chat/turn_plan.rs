//! Everything a turn will send, decided before anything is sent. The pre-send
//! sheet and the turn loop read the same plan, so what the sheet lists is what
//! leaves the machine.

use crate::chat::ambient::{
    ambient_snapshot, read_rule_files, snapshot_cap, AmbientSnapshot, RuleFile,
};
use crate::chat::prompt::{system_prompt, PromptInputs};
use crate::chat::provider::{ToolSpec, TurnMessage};
use crate::chat::replay::{replay_history, ReplayedHistory, REPLAY_TOKEN_BUDGET};
use crate::chat::tools::tool_specs;
use crate::chat::{
    build_manifest, dedupe_projects, load_chat_history, load_registered_projects, ChatSendRequest,
    ChatSettings, CliCommand, ProviderKindWire,
};
use crate::config::registered_path;

pub struct TurnPlan {
    pub system: String,
    pub rule_files: Vec<RuleFile>,
    pub snapshot: Option<AmbientSnapshot>,
    pub history: ReplayedHistory,
    /// The question as sent: the user's text plus the snapshot, if any.
    pub question: String,
    /// Projects the manifest and the tools may name.
    pub projects: Vec<String>,
    /// Registered projects left out because they are on the never-send list.
    pub hidden_projects: usize,
    /// Empty for a delegated CLI.
    pub specs: Vec<ToolSpec>,
    pub loopback: bool,
}

impl TurnPlan {
    /// The provider-neutral conversation: system, replayed turns, question.
    pub fn messages(&self) -> Vec<TurnMessage> {
        std::iter::once(TurnMessage::System(self.system.clone()))
            .chain(self.history.messages.iter().cloned())
            .chain(std::iter::once(TurnMessage::User(self.question.clone())))
            .collect()
    }
}

/// Builds the plan. Quick actions are standalone summaries: they replay no
/// history, so the same action on the same diff is a byte-identical request.
pub fn plan_turn(
    settings: &ChatSettings,
    projects_override: Option<Vec<String>>,
    request: &ChatSendRequest,
) -> Result<TurnPlan, String> {
    let scope = turn_scope(settings, projects_override, request)?;
    let rule_files = scope
        .ambient
        .as_deref()
        .map(read_rule_files)
        .unwrap_or_default();
    let snapshot = snapshot_cap(request.action, scope.delegated)
        .zip(scope.ambient.as_deref())
        .and_then(|(cap, project)| ambient_snapshot(project, &request.context, cap));
    let history = match request.action {
        Some(_) => ReplayedHistory::default(),
        None => replay_history(&load_chat_history()?, REPLAY_TOKEN_BUDGET),
    };
    let system = system_prompt(&PromptInputs {
        manifest: &build_manifest(&scope.projects),
        context: &request.context,
        guidance: &rule_files,
        action: request.action,
        omitted_turns: history.omitted,
        tools: !scope.delegated,
    });
    Ok(TurnPlan {
        system,
        question: question_text(&request.text, snapshot.as_ref()),
        rule_files,
        snapshot,
        history,
        hidden_projects: scope.hidden,
        specs: if scope.delegated { Vec::new() } else { specs() },
        projects: scope.projects,
        loopback: scope.loopback,
    })
}

/// Which projects a turn may name and read, and where it goes.
struct TurnScope {
    projects: Vec<String>,
    hidden: usize,
    ambient: Option<String>,
    loopback: bool,
    delegated: bool,
}

fn turn_scope(
    settings: &ChatSettings,
    projects_override: Option<Vec<String>>,
    request: &ChatSendRequest,
) -> Result<TurnScope, String> {
    let stored = match projects_override {
        Some(projects) => projects,
        None => load_registered_projects()?,
    };
    let loopback = is_loopback(settings);
    let registered = dedupe_projects(&stored);
    let projects = visible_projects(&registered, settings, loopback);
    Ok(TurnScope {
        hidden: registered.len() - projects.len(),
        ambient: ambient_project(&projects, request),
        projects,
        loopback,
        delegated: settings.provider == ProviderKindWire::Cli,
    })
}

fn specs() -> Vec<ToolSpec> {
    tool_specs()
        .into_iter()
        .map(|(name, description, parameters)| ToolSpec {
            name,
            description,
            parameters,
        })
        .collect()
}

fn question_text(text: &str, snapshot: Option<&AmbientSnapshot>) -> String {
    match snapshot {
        Some(snapshot) => format!(
            "{text}\n\n---\nAttached by Grove ({}):\n\n{}",
            snapshot.label, snapshot.text
        ),
        None => text.to_string(),
    }
}

/// The project in view, when it is one the turn may read.
fn ambient_project(projects: &[String], request: &ChatSendRequest) -> Option<String> {
    let candidate = request.context.project_path.as_deref()?;
    registered_path(projects, candidate)
        .ok()
        .map(|registered| registered.project)
}

/// Every registered project, minus the never-send list when the turn leaves
/// the machine.
fn visible_projects(registered: &[String], settings: &ChatSettings, loopback: bool) -> Vec<String> {
    registered
        .iter()
        .filter(|project| loopback || !on_never_send_list(settings, project))
        .cloned()
        .collect()
}

pub fn on_never_send_list(settings: &ChatSettings, project: &str) -> bool {
    let canonical = |path: &str| {
        std::fs::canonicalize(path)
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string())
    };
    let target = canonical(project);
    settings
        .never_send
        .iter()
        .any(|listed| canonical(listed) == target)
}

/// Refuses a turn that would leave the machine without consent, or that is
/// about a project on the never-send list.
pub fn turn_guard(settings: &ChatSettings, request: &ChatSendRequest) -> Result<(), String> {
    if request.text.trim().is_empty() {
        return Err("the message was empty".to_string());
    }
    if is_loopback(settings) {
        return Ok(());
    }
    if !settings.allow_cloud_egress {
        return Err(format!(
            "cloud egress is off; allow it in chat settings before using {}",
            destination(settings)
        ));
    }
    match request.context.project_path.as_deref() {
        Some(project) if on_never_send_list(settings, project) => Err(format!(
            "{project} is on the never-send list, and this turn would reach {}. Nothing was \
             sent. Remove it from the list or switch to a local provider.",
            destination(settings)
        )),
        _ => Ok(()),
    }
}

/// True when the turn stays on this machine: a loopback endpoint, or `codex`
/// pointed at a local model server. The `claude` CLI always reaches the cloud.
pub fn is_loopback(settings: &ChatSettings) -> bool {
    match (settings.provider, settings.cli_command) {
        (ProviderKindWire::Cli, CliCommand::Codex) => settings.cli_local_server.is_some(),
        (ProviderKindWire::Cli, CliCommand::Claude) => false,
        _ => is_loopback_url(&settings.base_url),
    }
}

pub fn is_loopback_url(base_url: &str) -> bool {
    host_of(base_url)
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]"))
}

/// Where a turn goes, for messages and the pre-send sheet.
pub fn destination(settings: &ChatSettings) -> String {
    match (settings.provider, settings.cli_command) {
        (ProviderKindWire::Cli, CliCommand::Claude) => "the claude CLI".to_string(),
        (ProviderKindWire::Cli, CliCommand::Codex) => "the codex CLI".to_string(),
        _ => host_of(&settings.base_url).unwrap_or_else(|| settings.base_url.clone()),
    }
}

pub fn host_of(base_url: &str) -> Option<String> {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}
