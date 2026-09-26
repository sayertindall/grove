//! The chat session: types, persistence, cancellation, and the single turn loop
//! shared by the GUI (Tauri events) and the CLI (stdout). One free-flowing chat,
//! one system prompt, no modes.

pub mod ambient;
pub mod cli;
pub mod cost_caps;
pub mod findings;
pub mod installed_cli;
pub mod preview;
pub mod prompt;
pub mod provider;
pub mod replay;
pub mod summary_cache;
pub mod tools;
pub mod turn_loop;
pub mod turn_plan;

use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::chat::findings::ChatFinding;
use crate::chat::provider::ProviderKind;
use crate::chat::replay::ReplayStep;
use crate::git::read_project_status;

pub use crate::chat::cost_caps::CostCaps;
pub use crate::chat::preview::{preview_turn, ChatPreview};

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
    /// Answered from the summary cache instead of the provider.
    #[serde(default)]
    pub cached: bool,
    /// Findings that fall inside a changed hunk of the file they name.
    #[serde(default)]
    pub findings: Vec<ChatFinding>,
    /// Findings the model emitted that could not be tied to a hunk.
    #[serde(default)]
    pub dropped_findings: u32,
    /// The assistant's tool rounds, kept on disk so a later turn can replay them
    /// in provider format. Never sent to the webview (see `for_webview`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replay: Vec<ReplayStep>,
}

impl ChatMessage {
    /// The message as the panel sees it: tool payloads stay on disk.
    pub fn for_webview(mut self) -> Self {
        self.replay = Vec::new();
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKindWire {
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    Anthropic,
    /// A locally installed agent CLI (`claude` or `codex`) that answers with its
    /// own authentication; Grove's tool loop is off for it.
    Cli,
}

/// The HTTP wire protocol for a provider; `None` for a delegated CLI.
pub fn provider_kind(provider: ProviderKindWire) -> Option<ProviderKind> {
    match provider {
        ProviderKindWire::OpenAiCompatible => Some(ProviderKind::OpenAiCompatible),
        ProviderKindWire::Anthropic => Some(ProviderKind::Anthropic),
        ProviderKindWire::Cli => None,
    }
}

/// Which installed CLI a `cli` provider delegates to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CliCommand {
    #[default]
    Claude,
    Codex,
}

/// A local model server `codex --oss` can use; with one set the CLI never
/// leaves the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalModelServer {
    Ollama,
    Lmstudio,
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
    pub cli_command: CliCommand,
    pub cli_local_server: Option<LocalModelServer>,
    /// Projects that never reach a cloud provider: a turn about one is refused
    /// and they are left out of the manifest and the tools.
    pub never_send: Vec<String>,
    /// Show the pre-send sheet before a turn leaves the machine.
    pub preview_before_send: bool,
    pub caps: CostCaps,
    /// Reuse the stored answer for a byte-identical request.
    pub summary_cache: bool,
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
            cli_command: CliCommand::default(),
            cli_local_server: None,
            never_send: Vec::new(),
            preview_before_send: true,
            caps: CostCaps::default(),
            summary_cache: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    pub project_path: Option<String>,
    pub file_path: Option<String>,
    /// Files a quick action names explicitly (e.g. changed since last viewed).
    #[serde(default)]
    pub files: Vec<String>,
}

/// A templated turn from the panel's quick-action row. The user text is the
/// template; the action decides what ambient snapshot travels with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuickAction {
    ExplainFile,
    ExplainRepo,
    SinceLastViewed,
    DraftCommitMessage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    pub turn_id: String,
    pub text: String,
    #[serde(default)]
    pub context: ChatContext,
    #[serde(default)]
    pub action: Option<QuickAction>,
}

/// The one sink both frontends implement.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ChatEvent {
    /// One request is about to leave: its size and the running total this turn.
    Egress {
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "requestBytes")]
        request_bytes: u64,
        #[serde(rename = "sentBytes")]
        sent_bytes: u64,
        #[serde(rename = "estimatedTokens")]
        estimated_tokens: u64,
        loopback: bool,
    },
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

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn write_json(path: &std::path::Path, value: &impl Serialize) -> Result<(), String> {
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
    if !path.exists() {
        return Ok(Vec::new());
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
/// The key never reaches a log or a command result. A delegated CLI uses its
/// own login and gets "". A loopback server needs no key: it gets an env key
/// when one is set, else "", and the Keychain (holding cloud keys) is never read
/// for it.
pub fn resolve_api_key(provider: ProviderKindWire, base_url: &str) -> Result<String, String> {
    if provider == ProviderKindWire::Cli {
        return Ok(String::new());
    }
    let env_name = provider_env_var(provider, base_url);
    if let Some(key) = env_api_key(env_name) {
        return Ok(key);
    }
    if turn_plan::is_loopback_url(base_url) {
        return Ok(String::new());
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

fn env_api_key(env_name: &str) -> Option<String> {
    ["GROVE_CHAT_KEY", env_name]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|key| !key.trim().is_empty())
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
        ProviderKindWire::Cli => "cli",
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

pub(crate) fn register_turn(turn_id: &str) -> Arc<AtomicBool> {
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
    let result = turn_loop::run_turn(Arc::clone(&sink), settings, projects_override, request).await;
    if let Err(error) = &result {
        sink.emit(&ChatEvent::Error {
            turn_id,
            message: error.clone(),
            retryable: false,
        });
    }
    result
}

/// One row per distinct repository: deduplicated by canonical path so a store
/// holding both spellings of a symlinked directory (`/tmp` vs `/private/tmp`)
/// yields one entry. The first stored spelling is kept as the identity the
/// model and the CLI/GUI see.
pub(crate) fn dedupe_projects(projects: &[String]) -> Vec<String> {
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
pub(crate) fn build_manifest(projects: &[String]) -> String {
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

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
