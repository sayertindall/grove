use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::error::GroveError;

/// The store file the project list lives in, relative to the app data directory.
pub const PROJECTS_STORE_FILE: &str = "projects.json";
/// The single key Grove persists.
pub const PROJECTS_KEY: &str = "projects";

/// The store the GUI opens. `GROVE_DATA_DIR` points it at the same file the CLI
/// reads, so a throwaway store isolates the desktop app too; otherwise the store
/// plugin resolves the file name against the app data directory.
fn projects_store_path() -> PathBuf {
    store_file_path(PROJECTS_STORE_FILE)
}

/// Where a store-plugin file named `file` lives: under `GROVE_DATA_DIR` when it is
/// set, otherwise relative, which the store plugin resolves against app data.
pub fn store_file_path(file: &str) -> PathBuf {
    match std::env::var_os("GROVE_DATA_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir).join(file),
        None => PathBuf::from(file),
    }
}

/// Loads the stored project paths. A missing store file or a missing key is an empty
/// list, not an error: the app starts with no projects and that is a valid state.
pub fn load_project_paths<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, GroveError> {
    let store = app
        .store(projects_store_path())
        .map_err(|error| GroveError::store(format!("{PROJECTS_STORE_FILE}: {error}")))?;

    let Some(value) = store.get(PROJECTS_KEY) else {
        return Ok(Vec::new());
    };

    serde_json::from_value::<Vec<String>>(value).map_err(|error| {
        GroveError::store(format!("{PROJECTS_STORE_FILE}: {PROJECTS_KEY}: {error}"))
    })
}

/// Loads the stored project paths without an AppHandle, for the CLI. This is
/// the chat module's store reader, not a second implementation: both the GUI
/// (`load_project_paths`) and the CLI read the same file. A missing store file
/// is an empty list, so `status` on a fresh machine still works.
pub fn load_registered_paths() -> Result<Vec<String>, GroveError> {
    crate::chat::load_registered_projects().map_err(GroveError::store)
}

/// Writes the list and flushes it, so the next launch reads exactly what the sidebar
/// shows now.
pub fn save_project_paths<R: Runtime>(
    app: &AppHandle<R>,
    paths: &[String],
) -> Result<(), GroveError> {
    let store = app
        .store(projects_store_path())
        .map_err(|error| GroveError::store(format!("{PROJECTS_STORE_FILE}: {error}")))?;

    store.set(PROJECTS_KEY, json!(paths));
    store
        .save()
        .map_err(|error| GroveError::store(format!("{PROJECTS_STORE_FILE}: {error}")))
}

/// Resolves each path to an absolute one. An existing directory goes through
/// `canonicalize`; a path that is gone falls back to `absolute` so a deleted
/// repository can stay on the list and render as missing. First occurrence wins.
pub fn canonicalize_project_paths(paths: Vec<String>) -> Result<Vec<String>, GroveError> {
    let mut canonical: Vec<String> = Vec::with_capacity(paths.len());

    for path in paths {
        if path.is_empty() {
            return Err(GroveError::usage("a project path was empty"));
        }

        let candidate = PathBuf::from(&path);
        let resolved = std::fs::canonicalize(&candidate)
            .or_else(|_| std::path::absolute(&candidate))
            .map_err(|error| GroveError::io(&path, error))?;
        let text = resolved.to_string_lossy().into_owned();

        if !canonical.contains(&text) {
            canonical.push(text);
        }
    }

    Ok(canonical)
}

/// A path accepted by the registration guard: the stored project that contains it,
/// and the canonical form of the path itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredPath {
    pub project: String,
    pub canonical: String,
}

/// Canonicalizes `path` and accepts it only when it is a registered project or a
/// descendant of one, matched on a path-component boundary. A stored project that
/// is itself not canonical (a symlinked `/tmp`) is compared in both forms. The
/// innermost containing project wins.
pub fn registered_path(registered: &[String], path: &str) -> Result<RegisteredPath, GroveError> {
    if path.is_empty() {
        return Err(GroveError::usage("a path was empty"));
    }
    let resolved =
        std::fs::canonicalize(Path::new(path)).map_err(|error| GroveError::io(path, error))?;
    let canonical = resolved.to_string_lossy().into_owned();
    let project = registered
        .iter()
        .filter(|project| project_contains(project, &canonical))
        .max_by_key(|project| project.len())
        .ok_or_else(|| GroveError::OutsideRegisteredProjects {
            path: path.to_string(),
        })?;
    Ok(RegisteredPath {
        project: project.clone(),
        canonical,
    })
}

fn project_contains(project: &str, canonical: &str) -> bool {
    path_is_inside_project(project, canonical)
        || std::fs::canonicalize(Path::new(project))
            .is_ok_and(|resolved| path_is_inside_project(&resolved.to_string_lossy(), canonical))
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
