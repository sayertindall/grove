use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Runtime, State};

use crate::config::{canonicalize_project_paths, load_project_paths, save_project_paths};
use crate::discovery::{find_repositories, REPOSITORY_SCAN_MAX_DEPTH};
use crate::git::{read_project_diff, read_project_status, ProjectDiff, ProjectStatus};
use crate::watch::{rebuild_project_watchers, ProjectWatcher};

/// Reads every registered project, in stored order. A project that is gone or
/// unreadable is a row, not a failure.
pub fn read_registered_projects<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<ProjectStatus>, String> {
    let paths = load_project_paths(app)?;
    Ok(paths.iter().map(|path| read_project_status(path)).collect())
}

/// Replaces the whole project list, then rewrites the watcher. The single writer of
/// both the store and the watcher.
pub fn replace_registered_projects<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<String>,
    watcher: &Mutex<ProjectWatcher>,
) -> Result<(), String> {
    let paths = canonicalize_project_paths(paths)?;
    save_project_paths(app, &paths)?;
    rebuild_project_watchers(app, watcher, &paths)
}

// Every command below is async: a synchronous command body runs on the main thread,
// and reading eleven repositories takes long enough that the window would stop
// drawing. The reads themselves run on the blocking pool, so they never park a
// runtime worker either.

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_for_repos(dir: String) -> Result<Vec<String>, String> {
    blocking(move || find_repositories(Path::new(&dir), REPOSITORY_SCAN_MAX_DEPTH)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_projects(app: AppHandle) -> Result<Vec<ProjectStatus>, String> {
    blocking(move || read_registered_projects(&app)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_projects(
    app: AppHandle,
    paths: Vec<String>,
    watcher: State<'_, Mutex<ProjectWatcher>>,
) -> Result<(), String> {
    let paths = canonicalize_project_paths(paths)?;
    save_project_paths(&app, &paths)?;
    rebuild_project_watchers(&app, watcher.inner(), &paths)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_diff(project_path: String) -> Result<ProjectDiff, String> {
    blocking(move || read_project_diff(&project_path)).await
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("the read task did not finish: {error}"))?
}
