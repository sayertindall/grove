//! The smoke fixture the verification plan describes: one temp parent holding three
//! repositories, registered through the real commands.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use git2::{IndexAddOption, Repository, Signature};
use grove_lib::commands::{
    ensure_registered_project_path, list_changes, open_path, read_registered_projects,
    replace_registered_projects, reveal_in_finder, scan_for_repos,
};
use grove_lib::discovery::find_repositories;
use grove_lib::git::{DiffView, FileChangeStatus, ProjectState};
use grove_lib::watch::{
    rebuild_project_watchers, watching_paths, ProjectWatcher, ProjectsChanged,
    PROJECTS_CHANGED_EVENT,
};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Listener};

static FIXTURE_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Every mock app shares one app-data store file, so tests that write it take turns.
static STORE_WRITERS: Mutex<()> = Mutex::new(());

fn exclusive_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_WRITERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    /// A temp parent with `clean/`, `dirty/`, and `renamed/` repositories.
    fn new(name: &str) -> Fixture {
        let unique = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "grove-smoke-{}-{unique}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture root");
        let fixture = Fixture { root };

        fixture.init("clean");
        fixture.write("clean/README.md", "clean\n");
        fixture.commit_all("clean", "initial");

        fixture.init("dirty");
        fixture.write("dirty/tracked.txt", "one\n");
        fixture.commit_all("dirty", "initial");
        fixture.write("dirty/tracked.txt", "one\ntwo\n");
        fixture.write("dirty/extra.txt", "x\n");

        fixture.init("renamed");
        fixture.write("renamed/old.txt", "same\n");
        fixture.commit_all("renamed", "initial");
        fixture.stage_rename("renamed", "old.txt", "new.txt");

        fixture
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn canonical(&self, relative: &str) -> String {
        std::fs::canonicalize(self.path(relative))
            .expect("canonical path")
            .to_string_lossy()
            .into_owned()
    }

    fn project_paths(&self) -> Vec<String> {
        vec![
            self.canonical("clean"),
            self.canonical("dirty"),
            self.canonical("renamed"),
        ]
    }

    fn init(&self, name: &str) {
        Repository::init(self.path(name)).expect("repository init");
    }

    fn write(&self, relative: &str, contents: &str) {
        std::fs::write(self.path(relative), contents).expect("write fixture file");
    }

    fn commit_all(&self, name: &str, message: &str) {
        let repository = Repository::open(self.path(name)).expect("open repository");
        let mut index = repository.index().expect("index");
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .expect("stage everything");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repository.find_tree(tree_id).expect("find tree");
        let signature = Signature::now("Grove test", "grove@example.com").expect("signature");
        repository
            .commit(Some("HEAD"), &signature, &signature, message, &tree, &[])
            .expect("commit");
    }

    fn stage_rename(&self, name: &str, from: &str, to: &str) {
        std::fs::rename(self.path(name).join(from), self.path(name).join(to)).expect("rename file");
        let repository = Repository::open(self.path(name)).expect("open repository");
        let mut index = repository.index().expect("index");
        index.remove_path(Path::new(from)).expect("drop old path");
        index.add_path(Path::new(to)).expect("add new path");
        index.write().expect("write index");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The app the commands run against, with the store plugin and the managed watcher.
fn test_app() -> App<MockRuntime> {
    mock_builder()
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(Mutex::new(ProjectWatcher::default()))
        .build(mock_context(noop_assets()))
        .expect("build test app")
}

/// The commands are async so they never run on the main thread; the tests drive them
/// through the same runtime the app uses.
fn ready<T>(work: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(work)
}

#[test]
fn registered_projects_report_sidebar_counts() {
    let _store = exclusive_store();
    let fixture = Fixture::new("registered");
    let paths = fixture.project_paths();

    let app = test_app();
    let watcher = Mutex::new(ProjectWatcher::default());
    replace_registered_projects(app.handle(), paths.clone(), &watcher).expect("set projects");
    let watching = watching_paths(&watcher);
    let rows = read_registered_projects(app.handle(), &watching).expect("list projects");

    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter().map(|row| row.path.clone()).collect::<Vec<_>>(),
        paths
    );

    let clean = rows
        .iter()
        .find(|row| row.display_name == "clean")
        .expect("clean row");
    assert_eq!(clean.state, ProjectState::Clean);
    assert_eq!(
        (
            clean.staged_count,
            clean.unstaged_count,
            clean.untracked_count
        ),
        (0, 0, 0)
    );
    assert_eq!((clean.additions, clean.deletions), (0, 0));
    assert!(clean.watching);
    assert!(clean.branch.is_some());
    assert!(clean.reason.is_none());

    let dirty = rows
        .iter()
        .find(|row| row.display_name == "dirty")
        .expect("dirty row");
    assert_eq!(dirty.state, ProjectState::Dirty);
    assert_eq!(
        (
            dirty.staged_count,
            dirty.unstaged_count,
            dirty.untracked_count
        ),
        (0, 1, 1)
    );
    assert_eq!((dirty.additions, dirty.deletions), (2, 0));

    let renamed = rows
        .iter()
        .find(|row| row.display_name == "renamed")
        .expect("renamed row");
    assert_eq!(renamed.state, ProjectState::Dirty);

    let changes = ready(list_changes(dirty.path.clone(), false)).expect("dirty changes");
    assert_eq!(changes.path, dirty.path);
    assert_eq!(changes.files.len(), 2);

    let renamed_changes =
        ready(list_changes(renamed.path.clone(), false)).expect("renamed changes");
    assert_eq!(renamed_changes.files.len(), 1);
    let rename = &renamed_changes.files[0];
    assert_eq!(rename.status, FileChangeStatus::Renamed);
    assert_eq!(rename.path, "new.txt");
    assert_eq!(rename.old_path.as_deref(), Some("old.txt"));
    assert!(rename.staged);

    let renamed_diff = ready(grove_lib::commands::get_file_diff(
        renamed.path.clone(),
        "new.txt".to_string(),
        DiffView::Staged,
        false,
    ))
    .expect("renamed file diff");
    assert_eq!(renamed_diff.status, FileChangeStatus::Renamed);
    assert_eq!(renamed_diff.old_path.as_deref(), Some("old.txt"));
    assert_eq!(renamed_diff.view, DiffView::Staged);

    // The store survives a restart: a second app reads the same three paths in order.
    let restarted = test_app();
    let reloaded = read_registered_projects(restarted.handle(), &watching)
        .expect("list projects after reload");
    assert_eq!(
        reloaded
            .iter()
            .map(|row| row.path.clone())
            .collect::<Vec<_>>(),
        paths
    );
}

#[test]
fn scan_for_repos_lists_fixture_roots_only() {
    let fixture = Fixture::new("scan");
    let parent = fixture.canonical("");

    let found = ready(scan_for_repos(parent.clone())).expect("scan");
    assert_eq!(found, fixture.project_paths());
    assert_eq!(
        find_repositories(Path::new(&parent), 6).expect("scan"),
        found
    );

    // A repository is listed at whatever depth it sits at, including depth 0, and the
    // walk never descends into one it already listed.
    assert_eq!(
        find_repositories(Path::new(&found[0]), 6).expect("scan inside a repository"),
        vec![found[0].clone()]
    );
    for path in &found {
        for other in &found {
            assert!(
                path == other || !path.starts_with(&format!("{other}/")),
                "{path} was listed inside {other}"
            );
        }
    }
}

#[test]
fn project_watcher_emits_after_workdir_edit() {
    let fixture = Fixture::new("watcher");
    let dirty = fixture.canonical("dirty");
    let app = test_app();
    let (sender, receiver) = mpsc::channel::<Vec<String>>();

    app.handle().listen(PROJECTS_CHANGED_EVENT, move |event| {
        if let Ok(payload) = serde_json::from_str::<ProjectsChanged>(event.payload()) {
            let _ = sender.send(payload.paths);
        }
    });

    let watcher = Mutex::new(ProjectWatcher::default());
    rebuild_project_watchers(app.handle(), &watcher, std::slice::from_ref(&dirty))
        .expect("watch the project");

    fixture.write("dirty/tracked.txt", "one\ntwo\nthree\n");

    let changed = receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("an event within a second of the edit");
    assert_eq!(changed, vec![dirty]);
}

#[test]
fn path_guard_rejects_paths_outside_registered_projects() {
    let _store = exclusive_store();
    let fixture = Fixture::new("guard");
    let app = test_app();
    let watcher = Mutex::new(ProjectWatcher::default());
    replace_registered_projects(app.handle(), fixture.project_paths(), &watcher)
        .expect("set projects");

    let outside = fixture.path("dirty-extra");
    std::fs::create_dir_all(&outside).expect("sibling directory");
    let outside = std::fs::canonicalize(&outside)
        .expect("canonical sibling")
        .to_string_lossy()
        .into_owned();

    let revealed = ready(reveal_in_finder(app.handle().clone(), outside.clone()));
    assert!(
        revealed
            .as_ref()
            .is_err_and(|error| error.contains("not inside a registered project")),
        "{revealed:?}"
    );
    let opened = ready(open_path(app.handle().clone(), outside));
    assert!(
        opened
            .as_ref()
            .is_err_and(|error| error.contains("not inside a registered project")),
        "{opened:?}"
    );

    let inside = fixture.canonical("dirty/tracked.txt");
    assert!(ensure_registered_project_path(app.handle(), &inside).is_ok());
    let parent = fixture.canonical("");
    assert!(ensure_registered_project_path(app.handle(), &parent).is_err());
}
