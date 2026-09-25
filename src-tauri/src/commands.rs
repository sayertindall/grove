use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Runtime, State};

use crate::config::{canonicalize_project_paths, load_project_paths, save_project_paths};
use crate::discovery::{find_repositories, REPOSITORY_SCAN_MAX_DEPTH};
use crate::git::{
    read_file_diff, read_project_changes, read_project_status, DiffView, FileDiff, ProjectChanges,
    ProjectStatus,
};
use crate::watch::{rebuild_project_watchers, watching_paths, ProjectWatcher};

/// Reads every registered project, in stored order. A project that is gone or
/// unreadable is a row, not a failure. The reads run in parallel; the result
/// stays in stored order.
pub fn read_registered_projects<R: Runtime>(
    app: &AppHandle<R>,
    watching: &HashSet<String>,
) -> Result<Vec<ProjectStatus>, String> {
    let paths = load_project_paths(app)?;
    let mut rows = read_project_statuses(&paths);
    for row in &mut rows {
        row.watching = watching.contains(&row.path);
    }
    Ok(rows)
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

/// Canonicalizes `path` and accepts it only when it is a registered project or a
/// descendant of one, matched on a path-component boundary.
pub fn ensure_registered_project_path<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("a path was empty".to_string());
    }

    let registered = load_project_paths(app)?;
    let resolved =
        std::fs::canonicalize(Path::new(path)).map_err(|error| format!("{path}: {error}"))?;
    let candidate = resolved.to_string_lossy().into_owned();
    if registered
        .iter()
        .any(|project| path_is_inside_project(project, &candidate))
    {
        Ok(candidate)
    } else {
        Err(format!("{path}: not inside a registered project"))
    }
}

/// `candidate` is inside `project` only when the next character is a path separator,
/// so `/a/grove-x` is not inside `/a/grove`.
pub fn path_is_inside_project(project: &str, candidate: &str) -> bool {
    if candidate == project {
        return true;
    }
    candidate
        .strip_prefix(project)
        .is_some_and(|rest| rest.starts_with('/'))
}

fn read_project_statuses(paths: &[String]) -> Vec<ProjectStatus> {
    let mut slots = vec![None; paths.len()];
    std::thread::scope(|scope| {
        for (slot, path) in slots.iter_mut().zip(paths) {
            scope.spawn(move || {
                *slot = Some(read_project_status(path));
            });
        }
    });
    slots
        .into_iter()
        .map(|slot| slot.expect("project status"))
        .collect()
}

fn run_open(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|error| format!("open: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with {status}"))
    }
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
pub async fn list_projects(
    app: AppHandle,
    watcher: State<'_, Mutex<ProjectWatcher>>,
) -> Result<Vec<ProjectStatus>, String> {
    let watching = watching_paths(watcher.inner());
    blocking(move || read_registered_projects(&app, &watching)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_project_status(
    project_path: String,
    watcher: State<'_, Mutex<ProjectWatcher>>,
) -> Result<ProjectStatus, String> {
    let watching = watching_paths(watcher.inner());
    blocking(move || {
        let mut status = read_project_status(&project_path);
        status.watching = watching.contains(&status.path) || watching.contains(&project_path);
        Ok(status)
    })
    .await
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
pub async fn list_changes(
    project_path: String,
    ignore_whitespace: bool,
) -> Result<ProjectChanges, String> {
    blocking(move || read_project_changes(&project_path, ignore_whitespace)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_file_diff(
    project_path: String,
    file_path: String,
    view: DiffView,
    ignore_whitespace: bool,
) -> Result<FileDiff, String> {
    blocking(move || read_file_diff(&project_path, &file_path, view, ignore_whitespace)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn reveal_in_finder<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &path)?;
        run_open(&["-R", &path])
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn open_path<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    blocking(move || {
        let path = ensure_registered_project_path(&app, &path)?;
        run_open(&[&path])
    })
    .await
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

#[cfg(test)]
mod tests {
    use super::path_is_inside_project;

    #[test]
    fn path_guard_matches_on_a_component_boundary() {
        assert!(path_is_inside_project("/tmp/grove", "/tmp/grove"));
        assert!(path_is_inside_project(
            "/tmp/grove",
            "/tmp/grove/src/main.rs"
        ));
        assert!(!path_is_inside_project(
            "/tmp/grove",
            "/tmp/grove-extra/file"
        ));
        assert!(!path_is_inside_project("/tmp/grove", "/tmp/other"));
    }
}
