use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use git2::Repository;
use notify_debouncer_full::notify::{
    Config, Error as WatchError, RecommendedWatcher, RecursiveMode,
};
use notify_debouncer_full::{
    new_debouncer_opt, DebounceEventResult, DebouncedEvent, Debouncer, NoCache,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::GroveError;
use crate::repo_cache::RepoCache;

/// Quiet period after the last filesystem event before one event is emitted.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// How often a root that could not be armed is tried again.
const WATCH_REARM_INTERVAL: Duration = Duration::from_secs(5);

/// The only event Grove emits.
pub const PROJECTS_CHANGED_EVENT: &str = "grove://projects-changed";

/// The registered project list uses filesystem paths, so a change matches a project
/// only at a path-component boundary.
const PATH_SEPARATOR: char = '/';

type RecommendedDebouncer = Debouncer<RecommendedWatcher, NoCache>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsChanged {
    pub paths: Vec<String>,
}

/// A git directory outside a project's tree that still decides what the project
/// shows: a linked worktree's own gitdir (its `index` and `HEAD`) and the shared
/// common dir (branch refs, `packed-refs`, `FETCH_HEAD`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDirWatch {
    pub dir: String,
    pub project: String,
}

#[derive(Default)]
struct WatchLists {
    watching: HashSet<String>,
    pending: Vec<String>,
    repos: HashMap<String, Repository>,
    git_dirs: Vec<GitDirWatch>,
}

/// The one long-lived piece of runtime state: the debouncer watching every registered
/// project root, plus the set of roots that are actually armed.
///
/// The cache is `NoCache` on purpose. The crate's recommended cache keeps a file id
/// per file under every watched root, which is unbounded here: watching eleven real
/// repositories (about 7 GB) grew the process from 77 MB to 415 MB in ten seconds and
/// to 3.2 GB while the app ran. Grove only needs to know *which project* changed, and
/// the cache exists to stitch rename pairs, so it buys nothing.
pub struct ProjectWatcher {
    debouncer: Arc<Mutex<Option<RecommendedDebouncer>>>,
    lists: Arc<Mutex<WatchLists>>,
    rearm_stop: Option<Sender<()>>,
    rearm_thread: Option<JoinHandle<()>>,
}

impl Default for ProjectWatcher {
    fn default() -> Self {
        Self {
            debouncer: Arc::new(Mutex::new(None)),
            lists: Arc::new(Mutex::new(WatchLists::default())),
            rearm_stop: None,
            rearm_thread: None,
        }
    }
}

impl Drop for ProjectWatcher {
    fn drop(&mut self) {
        self.rearm_stop.take();
        if let Some(thread) = self.rearm_thread.take() {
            let _ = thread.join();
        }
    }
}

/// Roots whose watch is currently armed. `list_projects` and `get_project_status`
/// copy this set onto each row.
pub fn watching_paths(watcher: &Mutex<ProjectWatcher>) -> HashSet<String> {
    let lists = Arc::clone(&lock_watcher(watcher).lists);
    let watching = lock_lists(&lists).watching.clone();
    watching
}

/// Drops the previous watcher and builds one for the given roots. An empty list
/// leaves no watcher at all. A root that cannot be armed stays pending and is
/// retried every five seconds; when it reappears, a change is emitted for it.
/// Cached reads are dropped: nothing watched the projects in between.
pub fn rebuild_project_watchers<R: Runtime>(
    app: &AppHandle<R>,
    watcher: &Mutex<ProjectWatcher>,
    paths: &[String],
) -> Result<(), GroveError> {
    shutdown_rearm(watcher);
    let (debouncer_slot, lists) = {
        let guard = lock_watcher(watcher);
        (Arc::clone(&guard.debouncer), Arc::clone(&guard.lists))
    };
    *lock_slot(&debouncer_slot) = None;
    *lock_lists(&lists) = WatchLists::default();
    if let Some(cache) = app.try_state::<RepoCache>() {
        cache.invalidate_all();
    }
    if paths.is_empty() {
        return Ok(());
    }

    let mut debouncer = project_debouncer(app, paths, &lists)?;
    let armed = arm_roots(&mut debouncer, paths);
    *lock_lists(&lists) = armed;
    *lock_slot(&debouncer_slot) = Some(debouncer);

    let (stop, receiver) = mpsc::channel();
    let app_for_rearm = app.clone();
    let thread = std::thread::Builder::new()
        .name("grove-watch-rearm".to_string())
        .spawn(move || rearm_loop(app_for_rearm, lists, debouncer_slot, receiver))
        .map_err(|error| GroveError::io("watch rearm", error))?;
    let mut guard = lock_watcher(watcher);
    guard.rearm_stop = Some(stop);
    guard.rearm_thread = Some(thread);
    Ok(())
}

/// Whether a filesystem event for `changed` should refresh `project`.
///
/// Events under `.git/` are dropped except the refs and files that change what
/// the sidebar shows. Gitignored paths are dropped. A linked worktree's `.git`
/// file is not a directory; its gitdir is watched separately (`GitDirWatch`).
pub fn watcher_keeps_path(project: &str, changed: &str, ignored: bool) -> bool {
    let Some(relative) = relative_to_project(project, changed) else {
        return false;
    };
    if drops_git_metadata(&relative) {
        return false;
    }
    !ignored
}

/// The registered projects whose trees received events worth refreshing, in stored
/// order. Ignored paths and git internals are dropped before a project is selected.
/// An event inside a watched git directory refreshes the project that owns it.
pub fn project_paths_for_events(
    events: &[DebouncedEvent],
    projects: &[String],
    repos: &HashMap<String, Repository>,
    git_dirs: &[GitDirWatch],
) -> Vec<String> {
    let mut matched: HashSet<&str> = HashSet::new();
    for path in events.iter().flat_map(|event| &event.event.paths) {
        let changed = path.to_string_lossy();
        matched.extend(git_dir_projects(&changed, git_dirs));
        let Some(project) = longest_project_prefix(&changed, projects) else {
            continue;
        };
        let ignored = repo_ignores_path(repos.get(project), project, &changed);
        if watcher_keeps_path(project, &changed, ignored) {
            matched.insert(project);
        }
    }

    projects
        .iter()
        .filter(|project| matched.contains(project.as_str()))
        .cloned()
        .collect()
}

/// Emits the one event the webview listens for. The named projects' cached reads
/// are invalidated first, so the refetch the event triggers reads fresh. A failure
/// is logged, never fatal: the app keeps watching.
pub fn emit_projects_changed<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if let Some(cache) = app.try_state::<RepoCache>() {
        cache.invalidate(&paths);
    }
    if let Err(error) = app.emit(PROJECTS_CHANGED_EVENT, ProjectsChanged { paths }) {
        eprintln!("{PROJECTS_CHANGED_EVENT}: {error}");
    }
}

fn project_debouncer<R: Runtime>(
    app: &AppHandle<R>,
    paths: &[String],
    lists: &Arc<Mutex<WatchLists>>,
) -> Result<RecommendedDebouncer, GroveError> {
    let app = app.clone();
    let projects = paths.to_vec();
    let lists = Arc::clone(lists);
    new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        WATCH_DEBOUNCE,
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => emit_for_events(&app, &events, &projects, &lists),
            Err(errors) => note_watch_errors(&errors, &projects, &lists),
        },
        NoCache,
        Config::default(),
    )
    .map_err(|error| GroveError::Io {
        context: "watcher".to_string(),
        source: std::io::Error::other(error.to_string()),
    })
}

/// Arms every root it can; the rest stay pending for the rearm thread.
fn arm_roots(debouncer: &mut RecommendedDebouncer, paths: &[String]) -> WatchLists {
    let mut lists = WatchLists::default();
    for path in paths {
        match debouncer.watch(PathBuf::from(path), RecursiveMode::Recursive) {
            Ok(()) => arm_project(debouncer, &mut lists, path),
            Err(error) => {
                eprintln!("{path}: {error}");
                lists.pending.push(path.clone());
            }
        }
    }
    lists
}

/// Records an armed root and watches the git directories it keeps elsewhere.
fn arm_project(debouncer: &mut RecommendedDebouncer, lists: &mut WatchLists, path: &str) {
    lists.watching.insert(path.to_string());
    lists.pending.retain(|pending| pending != path);
    cache_repository(&mut lists.repos, path);
    let Some(repository) = lists.repos.get(path) else {
        return;
    };
    for watch in external_git_dirs(repository, path) {
        arm_git_dir(debouncer, &watch);
        lists.git_dirs.push(watch);
    }
}

/// A linked worktree's gitdir and the common dir both live outside its tree. A
/// normal repository's `.git` is inside the tree and already watched.
fn external_git_dirs(repository: &Repository, project: &str) -> Vec<GitDirWatch> {
    if !repository.is_worktree() {
        return Vec::new();
    }
    [repository.path(), repository.commondir()]
        .into_iter()
        .map(|dir| std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()))
        .map(|dir| dir.to_string_lossy().trim_end_matches('/').to_string())
        .filter(|dir| relative_to_project(project, dir).is_none())
        .map(|dir| GitDirWatch {
            dir,
            project: project.to_string(),
        })
        .collect()
}

/// The directory itself for `HEAD`/`index`/`FETCH_HEAD`, and `refs/` in depth.
/// Objects and logs are never watched.
fn arm_git_dir(debouncer: &mut RecommendedDebouncer, watch: &GitDirWatch) {
    let dir = PathBuf::from(&watch.dir);
    if let Err(error) = debouncer.watch(dir.clone(), RecursiveMode::NonRecursive) {
        eprintln!("{}: {error}", watch.dir);
    }
    let refs = dir.join("refs");
    if refs.is_dir() {
        if let Err(error) = debouncer.watch(refs, RecursiveMode::Recursive) {
            eprintln!("{}/refs: {error}", watch.dir);
        }
    }
}

fn shutdown_rearm(watcher: &Mutex<ProjectWatcher>) {
    let thread = {
        let mut guard = lock_watcher(watcher);
        guard.rearm_stop.take();
        guard.rearm_thread.take()
    };
    if let Some(thread) = thread {
        let _ = thread.join();
    }
}

fn rearm_loop<R: Runtime>(
    app: AppHandle<R>,
    lists: Arc<Mutex<WatchLists>>,
    debouncer: Arc<Mutex<Option<RecommendedDebouncer>>>,
    stop: mpsc::Receiver<()>,
) {
    loop {
        match stop.recv_timeout(WATCH_REARM_INTERVAL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => rearm_missing(&app, &lists, &debouncer),
        }
    }
}

fn rearm_missing<R: Runtime>(
    app: &AppHandle<R>,
    lists: &Mutex<WatchLists>,
    debouncer: &Mutex<Option<RecommendedDebouncer>>,
) {
    let pending = lock_lists(lists).pending.clone();
    let mut appeared = Vec::new();
    for path in pending.iter().filter(|path| Path::new(path).exists()) {
        let mut slot = lock_slot(debouncer);
        let Some(debouncer) = slot.as_mut() else {
            return;
        };
        match debouncer.watch(PathBuf::from(path), RecursiveMode::Recursive) {
            Ok(()) => {
                arm_project(debouncer, &mut lock_lists(lists), path);
                appeared.push(path.clone());
            }
            Err(error) => eprintln!("{path}: {error}"),
        }
    }
    if !appeared.is_empty() {
        emit_projects_changed(app, appeared);
    }
}

fn emit_for_events<R: Runtime>(
    app: &AppHandle<R>,
    events: &[DebouncedEvent],
    projects: &[String],
    lists: &Mutex<WatchLists>,
) {
    let changed = {
        let lists = lock_lists(lists);
        project_paths_for_events(events, projects, &lists.repos, &lists.git_dirs)
    };
    if changed.is_empty() {
        return;
    }
    emit_projects_changed(app, changed);
}

fn note_watch_errors(errors: &[WatchError], projects: &[String], lists: &Mutex<WatchLists>) {
    let mut lists = lock_lists(lists);
    for error in errors {
        eprintln!("watch error: {error}");
        for path in &error.paths {
            let changed = path.to_string_lossy();
            let Some(project) = longest_project_prefix(&changed, projects) else {
                continue;
            };
            lists.watching.remove(project);
            if !lists.pending.iter().any(|pending| pending == project) {
                lists.pending.push(project.to_string());
            }
        }
    }
}

fn cache_repository(repos: &mut HashMap<String, Repository>, path: &str) {
    match Repository::open(path) {
        Ok(repository) => {
            repos.insert(path.to_string(), repository);
        }
        Err(error) => {
            eprintln!("{path}: {error}");
            repos.remove(path);
        }
    }
}

fn repo_ignores_path(repository: Option<&Repository>, project: &str, changed: &str) -> bool {
    let Some(repository) = repository else {
        return false;
    };
    let Some(relative) = relative_to_project(project, changed) else {
        return false;
    };
    if relative.is_empty() || relative == ".git" || relative.starts_with(".git/") {
        return false;
    }
    repository
        .is_path_ignored(Path::new(&relative))
        .unwrap_or(false)
}

fn relative_to_project(project: &str, changed: &str) -> Option<String> {
    if changed == project {
        return Some(String::new());
    }
    let rest = changed.strip_prefix(project)?;
    let rest = rest.strip_prefix(PATH_SEPARATOR)?;
    Some(rest.to_string())
}

fn drops_git_metadata(relative: &str) -> bool {
    relative
        .strip_prefix(".git/")
        .is_some_and(|rest| !git_dir_entry_matters(rest))
}

/// The entries of a git directory whose change can alter status, branch, or
/// ahead/behind: the index, HEAD and the refs that move it, and fetch results.
fn git_dir_entry_matters(relative: &str) -> bool {
    matches!(
        relative,
        "index" | "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "packed-refs" | "refs"
    ) || relative.starts_with("refs/")
}

/// Projects whose external git directories hold `changed` at an entry that matters.
fn git_dir_projects<'dirs>(
    changed: &str,
    git_dirs: &'dirs [GitDirWatch],
) -> impl Iterator<Item = &'dirs str> {
    let changed = changed.to_string();
    git_dirs
        .iter()
        .filter(move |watch| {
            relative_to_project(&watch.dir, &changed)
                .is_some_and(|relative| git_dir_entry_matters(&relative))
        })
        .map(|watch| watch.project.as_str())
}

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

fn lock_watcher(watcher: &Mutex<ProjectWatcher>) -> MutexGuard<'_, ProjectWatcher> {
    watcher
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_lists(lists: &Mutex<WatchLists>) -> MutexGuard<'_, WatchLists> {
    lists
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_slot(
    slot: &Mutex<Option<RecommendedDebouncer>>,
) -> MutexGuard<'_, Option<RecommendedDebouncer>> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Instant;

    use git2::{IndexAddOption, Repository, Signature};
    use notify_debouncer_full::notify::{Event, EventKind};
    use notify_debouncer_full::DebouncedEvent;

    use super::*;

    fn event_for(path: &str) -> DebouncedEvent {
        DebouncedEvent::new(
            Event::new(EventKind::Any).add_path(PathBuf::from(path)),
            Instant::now(),
        )
    }

    #[test]
    fn watcher_filter_drops_ignored_path_and_git_objects() {
        let project = "/repo";
        assert!(!watcher_keeps_path(
            project,
            "/repo/target/debug/grove",
            true
        ));
        assert!(!watcher_keeps_path(
            project,
            "/repo/.git/objects/ab/cd",
            false
        ));
        assert!(!watcher_keeps_path(project, "/repo/.git/config", false));
        assert!(watcher_keeps_path(project, "/repo/.git/index", false));
        assert!(watcher_keeps_path(project, "/repo/.git/HEAD", false));
        assert!(watcher_keeps_path(
            project,
            "/repo/.git/refs/heads/main",
            false
        ));
        assert!(watcher_keeps_path(project, "/repo/.git/packed-refs", false));
        assert!(watcher_keeps_path(project, "/repo/src/main.rs", false));
        assert!(!watcher_keeps_path(project, "/repo-other/file", false));

        let unique = std::process::id();
        let root = std::env::temp_dir().join(format!("grove-watch-filter-{unique}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("filter root");
        Repository::init(&root).expect("init");
        std::fs::write(root.join(".gitignore"), "secret.txt\n").expect("gitignore");
        let repository = Repository::open(&root).expect("open");
        let mut index = repository.index().expect("index");
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .expect("stage");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("tree");
        let tree = repository.find_tree(tree_id).expect("find tree");
        let signature = Signature::now("Grove test", "grove@example.com").expect("signature");
        repository
            .commit(Some("HEAD"), &signature, &signature, "ignore", &tree, &[])
            .expect("commit");
        drop(tree);
        std::fs::write(root.join("secret.txt"), "nope\n").expect("secret");

        let project = std::fs::canonicalize(&root)
            .expect("canonical")
            .to_string_lossy()
            .into_owned();
        let secret = format!("{project}/secret.txt");
        let ignored = repository
            .is_path_ignored("secret.txt")
            .expect("ignore check");
        assert!(ignored);
        assert!(!watcher_keeps_path(&project, &secret, ignored));
        assert!(watcher_keeps_path(
            &project,
            &format!("{project}/.git/index"),
            false
        ));
        assert!(!watcher_keeps_path(
            &project,
            &format!("{project}/.git/objects/pack/x"),
            false
        ));

        let mut repos = HashMap::new();
        repos.insert(project.clone(), repository);
        let projects = vec![project.clone()];
        let dropped = project_paths_for_events(
            &[
                event_for(&secret),
                event_for(&format!("{project}/.git/objects/aa/bb")),
            ],
            &projects,
            &repos,
            &[],
        );
        assert!(dropped.is_empty());

        let kept = project_paths_for_events(
            &[event_for(&format!("{project}/.git/index"))],
            &projects,
            &repos,
            &[],
        );
        assert_eq!(kept, vec![project]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
