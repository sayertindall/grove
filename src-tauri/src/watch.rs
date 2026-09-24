use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use notify_debouncer_full::notify::{Config, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer_opt, DebounceEventResult, DebouncedEvent, Debouncer, NoCache,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

/// Quiet period after the last filesystem event before one event is emitted.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// The only event Grove emits.
pub const PROJECTS_CHANGED_EVENT: &str = "grove://projects-changed";

/// The registered project list uses filesystem paths, so a change matches a project
/// only at a path-component boundary.
const PATH_SEPARATOR: char = '/';

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsChanged {
    pub paths: Vec<String>,
}

/// The one long-lived piece of runtime state: the debouncer watching every registered
/// project root. Replacing it is the whole of `set_projects`' watcher work.
///
/// The cache is `NoCache` on purpose. The crate's recommended cache keeps a file id
/// per file under every watched root, which is unbounded here: watching eleven real
/// repositories (about 7 GB) grew the process from 77 MB to 415 MB in ten seconds and
/// to 3.2 GB while the app ran. Grove only needs to know *which project* changed, and
/// the cache exists to stitch rename pairs, so it buys nothing.
#[derive(Default)]
pub struct ProjectWatcher {
    pub debouncer: Option<Debouncer<RecommendedWatcher, NoCache>>,
}

/// Drops the previous watcher and builds one for the given roots. An empty list
/// leaves no watcher at all.
pub fn rebuild_project_watchers<R: Runtime>(
    app: &AppHandle<R>,
    watcher: &Mutex<ProjectWatcher>,
    paths: &[String],
) -> Result<(), String> {
    drop(lock_watcher(watcher).debouncer.take());

    if paths.is_empty() {
        return Ok(());
    }

    let app = app.clone();
    let projects = Arc::new(paths.to_vec());
    let callback_projects = Arc::clone(&projects);
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        WATCH_DEBOUNCE,
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => emit_for_events(&app, &events, &callback_projects[..]),
            Err(errors) => errors
                .iter()
                .for_each(|error| eprintln!("watch error: {error}")),
        },
        NoCache,
        Config::default(),
    )
    .map_err(|error| error.to_string())?;

    for path in projects.iter() {
        // A registered path can be missing from disk; that project still has to stay
        // on the list, so a failed watch is logged and skipped.
        if let Err(error) = debouncer.watch(PathBuf::from(path), RecursiveMode::Recursive) {
            eprintln!("{path}: {error}");
        }
    }

    lock_watcher(watcher).debouncer = Some(debouncer);
    Ok(())
}

/// The registered projects whose trees received events, longest prefix first, in
/// stored order. Events that match no project are dropped.
pub fn project_paths_for_events(events: &[DebouncedEvent], projects: &[String]) -> Vec<String> {
    let mut matched: HashSet<&str> = HashSet::new();
    for event in events {
        for path in &event.event.paths {
            if let Some(project) = longest_project_prefix(&path.to_string_lossy(), projects) {
                matched.insert(project);
            }
        }
    }

    projects
        .iter()
        .filter(|project| matched.contains(project.as_str()))
        .cloned()
        .collect()
}

/// Emits the one event the webview listens for. A failure is logged, never fatal:
/// the app keeps watching.
pub fn emit_projects_changed<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if let Err(error) = app.emit(PROJECTS_CHANGED_EVENT, ProjectsChanged { paths }) {
        eprintln!("{PROJECTS_CHANGED_EVENT}: {error}");
    }
}

/// A poisoned lock must not take the process down.
fn lock_watcher(watcher: &Mutex<ProjectWatcher>) -> MutexGuard<'_, ProjectWatcher> {
    watcher
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn emit_for_events<R: Runtime>(
    app: &AppHandle<R>,
    events: &[DebouncedEvent],
    projects: &[String],
) {
    let changed = project_paths_for_events(events, projects);
    if changed.is_empty() {
        return;
    }

    emit_projects_changed(app, changed);
}

/// The project a changed path belongs to. A path inside a project matches on the
/// path-component boundary, so `/a/grove-x` is not part of `/a/grove`.
fn longest_project_prefix<'projects>(
    changed: &str,
    projects: &'projects [String],
) -> Option<&'projects str> {
    projects
        .iter()
        .filter(|project| matches_prefix(changed, project))
        .max_by_key(|project| project.len())
        .map(|project| project.as_str())
}

fn matches_prefix(changed: &str, project: &str) -> bool {
    match changed.strip_prefix(project) {
        Some(rest) => rest.is_empty() || rest.starts_with(PATH_SEPARATOR),
        None => false,
    }
}
