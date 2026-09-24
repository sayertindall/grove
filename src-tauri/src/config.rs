use std::path::PathBuf;

use serde_json::json;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

/// The store file the project list lives in, relative to the app data directory.
pub const PROJECTS_STORE_FILE: &str = "projects.json";
/// The single key Grove persists.
pub const PROJECTS_KEY: &str = "projects";

/// Loads the stored project paths. A missing store file or a missing key is an empty
/// list, not an error: the app starts with no projects and that is a valid state.
pub fn load_project_paths<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    let store = app
        .store(PROJECTS_STORE_FILE)
        .map_err(|error| format!("{PROJECTS_STORE_FILE}: {error}"))?;

    let Some(value) = store.get(PROJECTS_KEY) else {
        return Ok(Vec::new());
    };

    serde_json::from_value::<Vec<String>>(value)
        .map_err(|error| format!("{PROJECTS_STORE_FILE}: {PROJECTS_KEY}: {error}"))
}

/// Writes the list and flushes it, so the next launch reads exactly what the sidebar
/// shows now.
pub fn save_project_paths<R: Runtime>(app: &AppHandle<R>, paths: &[String]) -> Result<(), String> {
    let store = app
        .store(PROJECTS_STORE_FILE)
        .map_err(|error| format!("{PROJECTS_STORE_FILE}: {error}"))?;

    store.set(PROJECTS_KEY, json!(paths));
    store
        .save()
        .map_err(|error| format!("{PROJECTS_STORE_FILE}: {error}"))
}

/// Resolves each path to an absolute one. An existing directory goes through
/// `canonicalize`; a path that is gone falls back to `absolute` so a deleted
/// repository can stay on the list and render as missing. First occurrence wins.
pub fn canonicalize_project_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut canonical: Vec<String> = Vec::with_capacity(paths.len());

    for path in paths {
        if path.is_empty() {
            return Err("a project path was empty".to_string());
        }

        let candidate = PathBuf::from(&path);
        let resolved = std::fs::canonicalize(&candidate)
            .or_else(|_| std::path::absolute(&candidate))
            .map_err(|error| format!("{path}: {error}"))?;
        let text = resolved.to_string_lossy().into_owned();

        if !canonical.contains(&text) {
            canonical.push(text);
        }
    }

    Ok(canonical)
}
