use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::task::JoinSet;

use crate::config::{
    canonicalize_project_paths, load_project_paths, registered_path, save_project_paths,
};
use crate::discovery::{find_repositories, REPOSITORY_SCAN_MAX_DEPTH};
use crate::error::GroveError;
use crate::git::{
    read_blame_view, read_file_diff, read_file_history, BlameView, CommitInfo, DiffContext,
    DiffView, FileDiff, ProjectChanges, ProjectStatus,
};
use crate::repo_cache::RepoCache;
use crate::watch::{rebuild_project_watchers, watching_paths, ProjectWatcher};

/// Reads every registered project, in stored order. A project that is gone or
/// unreadable is a row, not a failure. The reads run on the blocking pool, at most
/// one per core at a time; the result stays in stored order.
pub async fn read_registered_projects<R: Runtime>(
    app: &AppHandle<R>,
    watching: &HashSet<String>,
    cache: &RepoCache,
) -> Result<Vec<ProjectStatus>, GroveError> {
    let paths = load_project_paths(app)?;
    let mut rows = read_project_statuses(paths, watching, cache).await?;
    for row in &mut rows {
        row.watching = watching.contains(&row.path);
    }
    Ok(rows)
}

/// Replaces the whole project list, then rewrites the watcher. The single writer of
/// both the store and the watcher; `set_projects` and startup both call it.
pub fn replace_registered_projects<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<String>,
    watcher: &Mutex<ProjectWatcher>,
) -> Result<(), GroveError> {
    let paths = canonicalize_project_paths(paths)?;
    save_project_paths(app, &paths)?;
    rebuild_project_watchers(app, watcher, &paths)
}

/// Canonicalizes `path` and accepts it only when it is a registered project or a
/// descendant of one, matched on a path-component boundary.
pub fn ensure_registered_project_path<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<String, GroveError> {
    let registered = load_project_paths(app)?;
    Ok(registered_path(&registered, path)?.canonical)
}

async fn read_project_statuses(
    paths: Vec<String>,
    watching: &HashSet<String>,
    cache: &RepoCache,
) -> Result<Vec<ProjectStatus>, GroveError> {
    let limit = std::thread::available_parallelism().map_or(4, |cores| cores.get());
    let mut slots: Vec<Option<ProjectStatus>> = vec![None; paths.len()];
    let mut reads = JoinSet::new();
    for (index, path) in paths.into_iter().enumerate() {
        if reads.len() >= limit {
            settle_one(&mut reads, &mut slots).await?;
        }
        let cache = cache.clone();
        let watched = watching.contains(&path);
        reads.spawn_blocking(move || (index, cache.project_status(&path, watched)));
    }
    while settle_one(&mut reads, &mut slots).await? {}
    slots
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| GroveError::Task {
            message: "a project read produced no row".to_string(),
        })
}

/// Waits for one read and files its row. `false` once nothing is left to wait for.
async fn settle_one(
    reads: &mut JoinSet<(usize, ProjectStatus)>,
    slots: &mut [Option<ProjectStatus>],
) -> Result<bool, GroveError> {
    let Some(joined) = reads.join_next().await else {
        return Ok(false);
    };
    let (index, row) = joined.map_err(|error| GroveError::Task {
        message: error.to_string(),
    })?;
    slots[index] = Some(row);
    Ok(true)
}

fn run_open(args: &[&str]) -> Result<(), GroveError> {
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|error| GroveError::io("open", error))?;
    if status.success() {
        Ok(())
    } else {
        Err(GroveError::Io {
            context: "open".to_string(),
            source: std::io::Error::other(format!("exited with {status}")),
        })
    }
}

// Every command below is async: a synchronous command body runs on the main thread,
// and reading eleven repositories takes long enough that the window would stop
// drawing. The reads themselves run on the blocking pool, so they never park a
// runtime worker either.

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_for_repos(dir: String) -> Result<Vec<String>, GroveError> {
    blocking(move || find_repositories(Path::new(&dir), REPOSITORY_SCAN_MAX_DEPTH)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_projects<R: Runtime>(
    app: AppHandle<R>,
    watcher: State<'_, Mutex<ProjectWatcher>>,
    cache: State<'_, RepoCache>,
) -> Result<Vec<ProjectStatus>, GroveError> {
    let watching = watching_paths(watcher.inner());
    read_registered_projects(&app, &watching, cache.inner()).await
}

/// One stored project's row. The path must be on the list exactly as stored, so a
/// project whose directory is gone still gets its missing row.
#[tauri::command(rename_all = "camelCase")]
pub async fn get_project_status<R: Runtime>(
    app: AppHandle<R>,
    project_path: String,
    watcher: State<'_, Mutex<ProjectWatcher>>,
    cache: State<'_, RepoCache>,
) -> Result<ProjectStatus, GroveError> {
    let watching = watching_paths(watcher.inner()).contains(&project_path);
    let cache = cache.inner().clone();
    blocking(move || {
        if !load_project_paths(&app)?.contains(&project_path) {
            return Err(GroveError::OutsideRegisteredProjects { path: project_path });
        }
        let mut status = cache.project_status(&project_path, watching);
        status.watching = watching;
        Ok(status)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_projects<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
    watcher: State<'_, Mutex<ProjectWatcher>>,
) -> Result<(), GroveError> {
    replace_registered_projects(&app, paths, watcher.inner())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_changes<R: Runtime>(
    app: AppHandle<R>,
    watcher: State<'_, Mutex<ProjectWatcher>>,
    cache: State<'_, RepoCache>,
    project_path: String,
    ignore_whitespace: bool,
) -> Result<ProjectChanges, GroveError> {
    let watching = watching_paths(watcher.inner());
    let cache = cache.inner().clone();
    blocking(move || {
        let path = ensure_registered_project_path(&app, &project_path)?;
        cache.project_changes(&path, ignore_whitespace, watching.contains(&path))
    })
    .await
}

/// One file of one registered project. `context` defaults to three lines. Rename
/// partners come from the project's (cached) change list, never a status scan.
#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)] // Each argument is one key of the invoke payload.
pub async fn get_file_diff<R: Runtime>(
    app: AppHandle<R>,
    watcher: State<'_, Mutex<ProjectWatcher>>,
    cache: State<'_, RepoCache>,
    project_path: String,
    file_path: String,
    view: DiffView,
    ignore_whitespace: bool,
    context: Option<DiffContext>,
) -> Result<FileDiff, GroveError> {
    let watching = watching_paths(watcher.inner());
    let cache = cache.inner().clone();
    blocking(move || {
        let path = ensure_registered_project_path(&app, &project_path)?;
        let changes = cache.project_changes(&path, false, watching.contains(&path))?;
        let context = context.unwrap_or_default();
        let known = Some(changes.files.as_slice());
        read_file_diff(&path, &file_path, view, ignore_whitespace, context, known)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reveal_in_finder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), GroveError> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &path)?;
        run_open(&["-R", &path])
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_path<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), GroveError> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &path)?;
        run_open(&[&path])
    })
    .await
}

/// The files of one registered project the user marked viewed, with the content
/// hash each mark was made at.
#[tauri::command(rename_all = "camelCase")]
pub async fn list_reviewed<R: Runtime>(
    app: AppHandle<R>,
    project_path: String,
) -> Result<Vec<crate::review::ReviewedFile>, GroveError> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &project_path)?;
        crate::review::list_reviewed(&crate::review::review_state_path()?, &path)
    })
    .await
}

/// Marks (or unmarks) one file viewed at `content_hash`. Writes only Grove's own
/// review state, never the repository.
#[tauri::command(rename_all = "camelCase")]
pub async fn set_reviewed<R: Runtime>(
    app: AppHandle<R>,
    project_path: String,
    file_path: String,
    content_hash: String,
    reviewed: bool,
) -> Result<(), GroveError> {
    blocking(move || {
        let mark = crate::review::ReviewMark {
            project_path: ensure_registered_project_path(&app, &project_path)?,
            file_path,
            content_hash,
        };
        crate::review::set_reviewed(&crate::review::review_state_path()?, mark, reviewed)
    })
    .await
}

/// The selected file's current text beside the commit that last touched each line
/// (first `MAX_BLAME_LINES` lines).
#[tauri::command(rename_all = "camelCase")]
pub async fn blame_file<R: Runtime>(
    app: AppHandle<R>,
    project_path: String,
    file_path: String,
) -> Result<BlameView, GroveError> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &project_path)?;
        read_blame_view(&path, &file_path)
    })
    .await
}

/// Commits that touched one file, newest first, at most `MAX_COMMIT_LIMIT`.
#[tauri::command(rename_all = "camelCase")]
pub async fn file_history<R: Runtime>(
    app: AppHandle<R>,
    project_path: String,
    file_path: String,
    limit: usize,
) -> Result<Vec<CommitInfo>, GroveError> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &project_path)?;
        read_file_history(&path, &file_path, limit)
    })
    .await
}

/// Runs `work` on the blocking pool. A task that panics or is cancelled becomes a
/// `task` error in the caller's error type.
pub(crate) async fn blocking<T, E, F>(work: F) -> Result<T, E>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: From<GroveError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            E::from(GroveError::Task {
                message: error.to_string(),
            })
        })?
}

// --- Chat commands ---------------------------------------------------------------
// Settings/history/keys live in files under the app-data dir so the CLI reads the
// same ones without an AppHandle. chat_send streams by event, not by return value.

#[tauri::command(rename_all = "camelCase")]
pub async fn chat_settings() -> Result<crate::chat::ChatSettings, GroveError> {
    blocking(|| crate::chat::load_chat_settings().map_err(GroveError::chat)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_chat_settings(
    settings: crate::chat::ChatSettings,
) -> Result<crate::chat::ChatSettings, GroveError> {
    blocking(move || crate::chat::save_chat_settings(&settings).map_err(GroveError::chat)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chat_key_status(provider: String) -> Result<bool, GroveError> {
    blocking(move || {
        let (provider, base_url) = provider_and_base_url(&provider)?;
        Ok(crate::chat::chat_key_status(provider, &base_url))
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_chat_key(provider: String, key: String) -> Result<(), GroveError> {
    blocking(move || {
        let (provider, _) = provider_and_base_url(&provider)?;
        crate::chat::store_chat_key(provider, &key).map_err(GroveError::chat)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn clear_chat_key(provider: String) -> Result<(), GroveError> {
    blocking(move || {
        let (provider, _) = provider_and_base_url(&provider)?;
        crate::chat::clear_chat_key(provider).map_err(GroveError::chat)
    })
    .await
}

#[tauri::command()]
pub async fn chat_history() -> Result<Vec<crate::chat::ChatMessage>, GroveError> {
    blocking(|| {
        crate::chat::load_chat_history()
            .map(|messages| {
                messages
                    .into_iter()
                    .map(|message| message.for_webview())
                    .collect()
            })
            .map_err(GroveError::chat)
    })
    .await
}

/// What the next turn would send, measured without sending it (the pre-send sheet).
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_preview(
    request: crate::chat::ChatSendRequest,
) -> Result<crate::chat::ChatPreview, GroveError> {
    blocking(move || {
        let settings = crate::chat::load_chat_settings().map_err(GroveError::chat)?;
        crate::chat::preview_turn(&settings, &request).map_err(GroveError::chat)
    })
    .await
}

/// Tokens spent this session and this month, for the cost-cap meter.
#[tauri::command()]
pub async fn chat_usage() -> Result<crate::chat::cost_caps::ChatUsage, GroveError> {
    blocking(|| Ok(crate::chat::cost_caps::load_usage())).await
}

/// Whether an agent CLI (`claude` / `codex`) is installed, and its version.
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_cli_status(
    command: crate::chat::CliCommand,
) -> Result<crate::chat::installed_cli::CliStatus, GroveError> {
    blocking(move || Ok(crate::chat::installed_cli::cli_status(command))).await
}

#[tauri::command()]
pub async fn chat_clear() -> Result<(), GroveError> {
    blocking(|| crate::chat::clear_chat_history().map_err(GroveError::chat)).await
}

/// Starts one turn; results arrive as `grove://chat-*` events on the turn id.
#[tauri::command(rename_all = "camelCase")]
pub async fn chat_send<R: tauri::Runtime>(
    app: AppHandle<R>,
    request: crate::chat::ChatSendRequest,
) -> Result<(), GroveError> {
    let settings = crate::chat::load_chat_settings().map_err(GroveError::chat)?;
    let sink = Arc::new(EventSink { app });
    tauri::async_runtime::spawn(async move {
        let _ = crate::chat::send_turn(sink, settings, request).await;
    });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chat_cancel(turn_id: String) -> Result<(), GroveError> {
    crate::chat::cancel_turn(&turn_id);
    Ok(())
}

/// Emits the turn's events on the `grove://chat-*` channels the frontend
/// subscribes to once for the app's lifetime.
struct EventSink<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> crate::chat::ChatSink for EventSink<R> {
    fn emit(&self, event: &crate::chat::ChatEvent) {
        use crate::chat::ChatEvent;

        let channel = match event {
            ChatEvent::Egress { .. } => "grove://chat-egress",
            ChatEvent::Delta { .. } => "grove://chat-delta",
            ChatEvent::Reasoning { .. } => "grove://chat-reasoning",
            ChatEvent::Tool { .. } => "grove://chat-tool",
            ChatEvent::Done { .. } => "grove://chat-done",
            ChatEvent::Error { .. } => "grove://chat-error",
        };
        if let Err(error) = self.app.emit(channel, event) {
            eprintln!("{channel}: {error}");
        }
    }
}

/// The provider id comes from the frontend as a plain string; validate it and pair
/// it with the currently stored base URL so env-var matching sees the right host.
fn provider_and_base_url(
    provider: &str,
) -> Result<(crate::chat::ProviderKindWire, String), GroveError> {
    let provider = match provider {
        "openai-compatible" => crate::chat::ProviderKindWire::OpenAiCompatible,
        "anthropic" => crate::chat::ProviderKindWire::Anthropic,
        "cli" => crate::chat::ProviderKindWire::Cli,
        other => return Err(GroveError::usage(format!("{other}: unknown provider"))),
    };
    let base_url = crate::chat::load_chat_settings()
        .map_err(GroveError::chat)?
        .base_url;
    Ok((provider, base_url))
}
