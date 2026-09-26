//! The smoke fixture the verification plan describes: one temp parent holding three
//! repositories, registered through the real commands.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use git2::{IndexAddOption, Repository, Signature};
use grove_lib::commands::{
    blame_file, ensure_registered_project_path, file_history, get_file_diff, list_changes,
    open_path, read_registered_projects, replace_registered_projects, reveal_in_finder,
    scan_for_repos,
};
use grove_lib::discovery::find_repositories;
use grove_lib::error::GroveError;
use grove_lib::git::{
    DiffContext, DiffLineKind, DiffView, FileChangeStatus, FileDiff, ProjectChanges, ProjectState,
};
use grove_lib::repo_cache::RepoCache;
use grove_lib::watch::{
    rebuild_project_watchers, watching_paths, ProjectWatcher, ProjectsChanged,
    PROJECTS_CHANGED_EVENT,
};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Listener, Manager};

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
        .manage(RepoCache::default())
        .build(mock_context(noop_assets()))
        .expect("build test app")
}

/// The commands are async so they never run on the main thread; the tests drive them
/// through the same runtime the app uses.
fn ready<T>(work: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(work)
}

/// `list_changes` through the command, with the app's managed watcher and cache.
fn changes_of(app: &App<MockRuntime>, path: &str) -> Result<ProjectChanges, GroveError> {
    ready(list_changes(
        app.handle().clone(),
        app.state(),
        app.state(),
        path.to_string(),
        false,
    ))
}

/// `get_file_diff` through the command.
fn diff_of(
    app: &App<MockRuntime>,
    path: &str,
    file: &str,
    view: DiffView,
    context: Option<DiffContext>,
) -> Result<FileDiff, GroveError> {
    ready(get_file_diff(
        app.handle().clone(),
        app.state(),
        app.state(),
        path.to_string(),
        file.to_string(),
        view,
        false,
        context,
    ))
}

/// Registers `paths` through the single writer, arming the app's managed watcher.
fn register(app: &App<MockRuntime>, paths: Vec<String>) {
    let watcher = app.state::<Mutex<ProjectWatcher>>();
    replace_registered_projects(app.handle(), paths, watcher.inner()).expect("set projects");
}

#[test]
fn registered_projects_report_sidebar_counts() {
    let _store = exclusive_store();
    let fixture = Fixture::new("registered");
    let paths = fixture.project_paths();

    let app = test_app();
    register(&app, paths.clone());
    let watching = watching_paths(app.state::<Mutex<ProjectWatcher>>().inner());
    let cache = app.state::<RepoCache>().inner().clone();
    let rows =
        ready(read_registered_projects(app.handle(), &watching, &cache)).expect("list projects");

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

    let changes = changes_of(&app, &dirty.path).expect("dirty changes");
    assert_eq!(changes.path, dirty.path);
    assert_eq!(changes.files.len(), 2);

    let renamed_changes = changes_of(&app, &renamed.path).expect("renamed changes");
    assert_eq!(renamed_changes.files.len(), 1);
    let rename = &renamed_changes.files[0];
    assert_eq!(rename.status, FileChangeStatus::Renamed);
    assert_eq!(rename.path, "new.txt");
    assert_eq!(rename.old_path.as_deref(), Some("old.txt"));
    assert!(rename.staged);

    let renamed_diff =
        diff_of(&app, &renamed.path, "new.txt", DiffView::Staged, None).expect("renamed diff");
    assert_eq!(renamed_diff.status, FileChangeStatus::Renamed);
    assert_eq!(renamed_diff.old_path.as_deref(), Some("old.txt"));
    assert_eq!(renamed_diff.view, DiffView::Staged);

    // The store survives a restart: a second app reads the same three paths in order.
    let restarted = test_app();
    let reloaded = ready(read_registered_projects(
        restarted.handle(),
        &watching,
        &RepoCache::default(),
    ))
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
fn scan_for_repos_finds_repositories_nested_inside_repositories() {
    let fixture = Fixture::new("scan");
    let parent = fixture.canonical("");

    // Independent repositories inside an umbrella repository are projects too; a
    // vendored dependency with its own `.git` is not.
    std::fs::create_dir_all(fixture.path("dirty/packages")).expect("packages dir");
    fixture.init("dirty/packages/nested");
    fixture.write("dirty/packages/nested/lib.txt", "nested\n");
    fixture.commit_all("dirty/packages/nested", "initial");
    std::fs::create_dir_all(fixture.path("dirty/node_modules")).expect("node_modules dir");
    fixture.init("dirty/node_modules/vendored");

    let mut expected = fixture.project_paths();
    expected.push(fixture.canonical("dirty/packages/nested"));
    expected.sort();

    let found = ready(scan_for_repos(parent.clone())).expect("scan");
    assert_eq!(found, expected);
    assert_eq!(
        find_repositories(Path::new(&parent), 6).expect("scan"),
        found
    );

    // Scanning a repository lists it and keeps looking inside it.
    let dirty = fixture.canonical("dirty");
    assert_eq!(
        find_repositories(Path::new(&dirty), 6).expect("scan inside a repository"),
        vec![dirty.clone(), fixture.canonical("dirty/packages/nested")]
    );
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
    register(&app, fixture.project_paths());

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
            .is_err_and(|error| error.code() == "outside_registered_projects"),
        "{revealed:?}"
    );
    let opened = ready(open_path(app.handle().clone(), outside));
    assert!(
        opened
            .as_ref()
            .is_err_and(|error| error.code() == "outside_registered_projects"),
        "{opened:?}"
    );

    let inside = fixture.canonical("dirty/tracked.txt");
    assert!(ensure_registered_project_path(app.handle(), &inside).is_ok());
    let parent = fixture.canonical("");
    assert!(ensure_registered_project_path(app.handle(), &parent).is_err());
}

/// Twenty numbered lines, the tenth replaced: a known edit with known hunks.
fn numbered_lines(edited: Option<&str>) -> String {
    (1..=20)
        .map(|line| match (line, edited) {
            (10, Some(text)) => format!("{text}\n"),
            _ => format!("line {line}\n"),
        })
        .collect()
}

#[test]
fn file_diff_carries_structured_hunks_for_each_context() {
    let _store = exclusive_store();
    let fixture = Fixture::new("hunks");
    fixture.init("edited");
    fixture.write("edited/numbers.txt", &numbered_lines(None));
    fixture.commit_all("edited", "initial");
    fixture.write("edited/numbers.txt", &numbered_lines(Some("line ten")));
    let project = fixture.canonical("edited");
    let app = test_app();
    register(&app, vec![project.clone()]);

    let default = diff_of(&app, &project, "numbers.txt", DiffView::Head, None).expect("diff");
    assert_eq!(default.hunks.len(), 1);
    let hunk = &default.hunks[0];
    assert!(
        hunk.header.starts_with("@@ -7,7 +7,7 @@"),
        "{}",
        hunk.header
    );
    assert_eq!(
        (
            hunk.old_start,
            hunk.old_lines,
            hunk.new_start,
            hunk.new_lines
        ),
        (7, 7, 7, 7)
    );
    let kinds: Vec<DiffLineKind> = hunk.lines.iter().map(|line| line.kind).collect();
    use DiffLineKind::{Add, Context, Del};
    assert_eq!(
        kinds,
        vec![Context, Context, Context, Del, Add, Context, Context, Context]
    );
    let deleted = &hunk.lines[3];
    assert_eq!((deleted.old_no, deleted.new_no), (Some(10), None));
    assert_eq!(deleted.text, "line 10");
    let added = &hunk.lines[4];
    assert_eq!((added.old_no, added.new_no), (None, Some(10)));
    assert_eq!(added.text, "line ten");
    assert!(default.patch.contains(&format!("{}\n", hunk.header)));
    assert!(default.patch.contains("-line 10\n+line ten\n"));

    let wire = serde_json::to_value(&default).expect("diff json");
    assert_eq!(wire["hunks"][0]["oldStart"], 7);
    assert_eq!(wire["hunks"][0]["lines"][3]["kind"], "del");
    assert!(wire["hunks"][0]["lines"][3]["newNo"].is_null());

    let bare = diff_of(
        &app,
        &project,
        "numbers.txt",
        DiffView::Head,
        Some(DiffContext::Lines(0)),
    )
    .expect("zero-context diff");
    assert_eq!(bare.hunks[0].lines.len(), 2);

    let whole = diff_of(
        &app,
        &project,
        "numbers.txt",
        DiffView::Head,
        Some(DiffContext::All),
    )
    .expect("whole-file diff");
    assert_eq!(whole.hunks.len(), 1);
    let hunk = &whole.hunks[0];
    assert_eq!(
        (hunk.old_start, hunk.old_lines, hunk.new_lines),
        (1, 20, 20)
    );
    assert_eq!(hunk.lines.len(), 21);
    assert_eq!(
        hunk.lines.first().map(|line| line.text.as_str()),
        Some("line 1")
    );
    assert_eq!(hunk.lines.last().map(|line| line.new_no), Some(Some(20)));

    let rejected = serde_json::from_value::<DiffContext>(serde_json::json!(11));
    assert!(rejected.is_err());
    assert_eq!(
        serde_json::from_value::<DiffContext>(serde_json::json!("all")).expect("all"),
        DiffContext::All
    );
}

#[test]
fn unregistered_project_is_a_typed_error() {
    let _store = exclusive_store();
    let fixture = Fixture::new("unregistered");
    let app = test_app();
    register(&app, vec![fixture.canonical("clean")]);
    let outside = fixture.canonical("dirty");

    let error = changes_of(&app, &outside).expect_err("dirty is not registered");
    assert_eq!(error.code(), "outside_registered_projects");
    let wire = serde_json::to_value(&error).expect("error json");
    assert_eq!(wire["code"], "outside_registered_projects");
    assert_eq!(wire["path"], outside.as_str());
    assert_eq!(
        wire["message"],
        format!("{outside}: not inside a registered project")
    );

    let diff = diff_of(&app, &outside, "tracked.txt", DiffView::Head, None);
    assert_eq!(
        diff.map_err(|error| error.code()).err(),
        Some("outside_registered_projects")
    );
}

#[test]
fn change_list_is_cached_until_the_watcher_reports_an_edit() {
    let _store = exclusive_store();
    let fixture = Fixture::new("cache");
    let dirty = fixture.canonical("dirty");
    let app = test_app();
    let (sender, receiver) = mpsc::channel::<Vec<String>>();
    app.handle().listen(PROJECTS_CHANGED_EVENT, move |event| {
        if let Ok(payload) = serde_json::from_str::<ProjectsChanged>(event.payload()) {
            let _ = sender.send(payload.paths);
        }
    });
    register(&app, vec![dirty.clone()]);
    let cache = app.state::<RepoCache>().inner().clone();

    let first = changes_of(&app, &dirty).expect("first read");
    let before = cache.counters();
    let second = changes_of(&app, &dirty).expect("second read");
    let after = cache.counters();
    assert_eq!(first, second);
    assert_eq!(
        after.hits,
        before.hits + 1,
        "an unchanged second read is a hit"
    );
    assert_eq!(after.misses, before.misses);

    // A worktree-only edit moves neither the index nor HEAD: only the watcher's
    // tick can make the entry stale.
    fixture.write("dirty/tracked.txt", "one\ntwo\nthree\n");
    let changed = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("an event after the edit");
    assert_eq!(changed, vec![dirty.clone()]);

    let third = changes_of(&app, &dirty).expect("read after the edit");
    let tracked = third
        .files
        .iter()
        .find(|file| file.path == "tracked.txt")
        .expect("tracked.txt");
    assert_eq!(tracked.additions, 2);
    assert_eq!(cache.counters().misses, after.misses + 1);
}

/// libgit2 marks a delta binary only after loading its content; a modified binary
/// file must still be a row, and its diff must say binary with no hunks.
#[test]
fn modified_binary_file_is_listed_and_diffed_as_binary() {
    let _store = exclusive_store();
    let fixture = Fixture::new("binary");
    fixture.init("assets");
    std::fs::write(
        fixture.path("assets/data.bin"),
        [0u8, 1, 2, 3, 0, 0xff, 0xfe, 0],
    )
    .expect("write binary");
    fixture.commit_all("assets", "initial");
    std::fs::write(fixture.path("assets/data.bin"), [9u8, 0, 8, 0, 7, 0xff])
        .expect("rewrite binary");
    let project = fixture.canonical("assets");
    let app = test_app();
    register(&app, vec![project.clone()]);

    let changes = changes_of(&app, &project).expect("changes");
    let row = changes
        .files
        .iter()
        .find(|file| file.path == "data.bin")
        .expect("the modified binary file is listed");
    assert!(row.binary);
    assert!(row.unstaged);

    let diff = diff_of(&app, &project, "data.bin", DiffView::Head, None).expect("binary diff");
    assert!(diff.binary);
    assert!(diff.hunks.is_empty());
    assert_eq!(diff.patch, "Binary files differ\n");
    assert!(diff.old_contents.is_none() && diff.new_contents.is_none());
}

/// Commits the index as it stands onto HEAD, with HEAD (when born) as the parent.
fn commit_index(repository: &Repository, message: &str) -> git2::Oid {
    let mut index = repository.index().expect("index");
    let tree_id = index.write_tree().expect("write tree");
    let tree = repository.find_tree(tree_id).expect("find tree");
    let signature = Signature::now("Grove test", "grove@example.com").expect("signature");
    let parent = repository
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok());
    let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .expect("commit")
}

fn stage_file(repository: &Repository, relative: &str, contents: &str) {
    let root = repository.workdir().expect("workdir");
    std::fs::write(root.join(relative), contents).expect("write file");
    let mut index = repository.index().expect("index");
    index.add_path(Path::new(relative)).expect("stage file");
    index.write().expect("write index");
}

/// A real merge conflict: base, then `theirs` and HEAD each change the same line,
/// then HEAD merges `theirs`. The index holds stages 1–3 and the worktree markers.
#[test]
fn conflicted_file_reports_its_three_index_stages() {
    let _store = exclusive_store();
    let fixture = Fixture::new("conflict");
    fixture.init("merge");
    let repository = Repository::open(fixture.path("merge")).expect("open repository");
    stage_file(
        &repository,
        "store.rs",
        "struct Store {\n    version: u32,\n}\n",
    );
    let base = commit_index(&repository, "base");
    let base_commit = repository.find_commit(base).expect("base commit");
    repository
        .branch("theirs", &base_commit, false)
        .expect("theirs branch");
    stage_file(
        &repository,
        "store.rs",
        "struct Store {\n    version: u64,\n}\n",
    );
    commit_index(&repository, "ours");

    let signature = Signature::now("Grove test", "grove@example.com").expect("signature");
    let theirs_blob = repository
        .blob(b"struct Store {\n    version: u8,\n}\n")
        .expect("theirs blob");
    let mut builder = repository
        .treebuilder(Some(&base_commit.tree().expect("base tree")))
        .expect("tree builder");
    builder
        .insert("store.rs", theirs_blob, 0o100644)
        .expect("theirs entry");
    let theirs_tree = repository
        .find_tree(builder.write().expect("theirs tree"))
        .expect("find theirs tree");
    let theirs = repository
        .commit(
            Some("refs/heads/theirs"),
            &signature,
            &signature,
            "theirs",
            &theirs_tree,
            &[&base_commit],
        )
        .expect("theirs commit");
    let incoming = repository
        .find_annotated_commit(theirs)
        .expect("annotated theirs");
    repository
        .merge(&[&incoming], None, None)
        .expect("merge leaves a conflict");
    assert!(repository.index().expect("index").has_conflicts());

    let project = fixture.canonical("merge");
    let app = test_app();
    register(&app, vec![project.clone()]);

    let changes = changes_of(&app, &project).expect("changes");
    let row = changes
        .files
        .iter()
        .find(|file| file.path == "store.rs")
        .expect("the conflicted file is listed");
    assert_eq!(row.status, FileChangeStatus::Conflicted);

    let diff = diff_of(&app, &project, "store.rs", DiffView::Head, None).expect("conflict diff");
    assert_eq!(diff.status, FileChangeStatus::Conflicted);
    assert!(diff.submodule.is_none());
    let conflict = diff.conflict.expect("conflict sides");
    assert_eq!(
        conflict.base.as_deref(),
        Some("struct Store {\n    version: u32,\n}\n")
    );
    assert_eq!(
        conflict.ours.as_deref(),
        Some("struct Store {\n    version: u64,\n}\n")
    );
    assert_eq!(
        conflict.theirs.as_deref(),
        Some("struct Store {\n    version: u8,\n}\n")
    );
    let merged = conflict.merged.expect("merged text");
    assert_eq!(
        merged,
        "struct Store {\n<<<<<<< ours\n    version: u64,\n||||||| base\n    version: u32,\n=======\n    version: u8,\n>>>>>>> theirs\n}\n"
    );
}

/// A gitlink whose submodule checkout moved to a newer commit is one `submodule`
/// row naming both commits, and its diff carries no content sides.
#[test]
fn submodule_pointer_change_is_a_submodule_row() {
    let _store = exclusive_store();
    let fixture = Fixture::new("submodule");
    fixture.init("outer");
    let outer = Repository::open(fixture.path("outer")).expect("open outer");
    let library = Repository::init(fixture.path("outer/vendor/lib")).expect("init library");
    stage_file(&library, "lib.rs", "pub fn one() {}\n");
    let first = commit_index(&library, "library one");

    let gitmodules = "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = ./vendor/lib\n";
    stage_file(&outer, ".gitmodules", gitmodules);
    let mut index = outer.index().expect("outer index");
    index
        .add(&gitlink_entry("vendor/lib", first))
        .expect("stage gitlink");
    index.write().expect("write outer index");
    commit_index(&outer, "add library");

    stage_file(&library, "lib.rs", "pub fn one() {}\npub fn two() {}\n");
    let second = commit_index(&library, "library two");

    let project = fixture.canonical("outer");
    let app = test_app();
    register(&app, vec![project.clone()]);

    let changes = changes_of(&app, &project).expect("changes");
    let row = changes
        .files
        .iter()
        .find(|file| file.path == "vendor/lib")
        .expect("the moved submodule is listed");
    assert_eq!(row.status, FileChangeStatus::Submodule);
    let pointer = row.submodule.as_ref().expect("row pointer");
    assert_eq!(pointer.old_commit, Some(first.to_string()));
    assert_eq!(pointer.new_commit, Some(second.to_string()));

    let diff = diff_of(&app, &project, "vendor/lib", DiffView::Head, None).expect("gitlink diff");
    assert_eq!(diff.status, FileChangeStatus::Submodule);
    let pointer = diff.submodule.expect("diff pointer");
    assert_eq!(pointer.old_commit, Some(first.to_string()));
    assert_eq!(pointer.new_commit, Some(second.to_string()));
    assert!(diff.old_contents.is_none() && diff.new_contents.is_none());
    assert!(diff.image.is_none() && diff.conflict.is_none());
}

fn gitlink_entry(path: &str, commit: git2::Oid) -> git2::IndexEntry {
    let zero = git2::IndexTime::new(0, 0);
    git2::IndexEntry {
        ctime: zero,
        mtime: zero,
        dev: 0,
        ino: 0,
        mode: 0o160000,
        uid: 0,
        gid: 0,
        file_size: 0,
        id: commit,
        flags: path.len() as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// Blame of a file committed twice and then edited: each line names the commit that
/// last touched it, the uncommitted line names none, and history lists both commits.
#[test]
fn blame_and_history_follow_a_two_commit_file() {
    let _store = exclusive_store();
    let fixture = Fixture::new("blame");
    fixture.init("notes");
    let repository = Repository::open(fixture.path("notes")).expect("open repository");
    stage_file(&repository, "notes.txt", "alpha\nbeta\n");
    let first = commit_index(&repository, "write alpha and beta");
    stage_file(&repository, "notes.txt", "alpha\nBETA\ngamma\n");
    let second = commit_index(&repository, "shout beta, add gamma");
    fixture.write("notes/notes.txt", "alpha\nBETA\ngamma\ndelta\n");

    let project = fixture.canonical("notes");
    let app = test_app();
    register(&app, vec![project.clone()]);

    let blame = ready(blame_file(
        app.handle().clone(),
        project.clone(),
        "notes.txt".to_string(),
    ))
    .expect("blame");
    let rows: Vec<(u32, &str, Option<String>)> = blame
        .lines
        .iter()
        .map(|line| (line.line, line.text.as_str(), line.commit.clone()))
        .collect();
    assert_eq!(
        rows,
        vec![
            (1, "alpha", Some(first.to_string())),
            (2, "BETA", Some(second.to_string())),
            (3, "gamma", Some(second.to_string())),
            (4, "delta", None),
        ]
    );
    assert!(!blame.truncated);
    let subjects: Vec<&str> = blame.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(
        subjects,
        vec!["write alpha and beta", "shout beta, add gamma"]
    );

    let history = ready(file_history(
        app.handle().clone(),
        project.clone(),
        "notes.txt".to_string(),
        10,
    ))
    .expect("history");
    let ids: Vec<&str> = history.iter().map(|commit| commit.id.as_str()).collect();
    assert_eq!(ids, vec![second.to_string(), first.to_string()]);

    let untracked = ready(blame_file(
        app.handle().clone(),
        project,
        "../outside".into(),
    ));
    assert!(
        untracked.is_err(),
        "a path outside the repository has no blame"
    );
}

/// Risk signals of one file in a fresh change list.
fn file_risk(project: &str, file: &str) -> Vec<grove_lib::git::RiskSignal> {
    let changes = grove_lib::git::read_project_changes(project, false).expect("changes");
    changes
        .files
        .into_iter()
        .find(|summary| summary.path == file)
        .map(|summary| summary.risk)
        .unwrap_or_else(|| panic!("{file} is not in the change list"))
}

#[test]
fn triage_flags_env_secret_lockfile_migration_and_untested_source() {
    use grove_lib::git::RiskSignal;

    let fixture = Fixture::new("triage");
    for dir in ["dirty/db/migrations", "dirty/src/auth", "dirty/.claude"] {
        std::fs::create_dir_all(fixture.path(dir)).expect("fixture directory");
    }
    fixture.write(
        "dirty/.env",
        "OPENAI_API_KEY=sk-fixture0123456789abcdefghijkl\n",
    );
    fixture.write("dirty/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    fixture.write(
        "dirty/db/migrations/0001_init.sql",
        "create table t (id int);\n",
    );
    fixture.write("dirty/src/auth/session.ts", "export const ttl = 60;\n");
    fixture.write("dirty/big.txt", &"line\n".repeat(401));
    let project = fixture.canonical("dirty");

    let secret = [RiskSignal::Secret, RiskSignal::Env];
    assert_eq!(file_risk(&project, ".env"), secret);
    assert_eq!(
        file_risk(&project, "pnpm-lock.yaml"),
        [RiskSignal::Lockfile]
    );
    let migration = file_risk(&project, "db/migrations/0001_init.sql");
    assert_eq!(migration, [RiskSignal::Migration]);
    let untested = [RiskSignal::Auth, RiskSignal::NoTests];
    assert_eq!(file_risk(&project, "src/auth/session.ts"), untested);
    assert_eq!(file_risk(&project, "big.txt"), [RiskSignal::Large]);
    assert!(file_risk(&project, "tracked.txt").is_empty());

    // A changed test anywhere in the project clears `no-tests`.
    fixture.write("dirty/src/auth/session.test.ts", "test('ttl', () => {});\n");
    assert_eq!(
        file_risk(&project, "src/auth/session.ts"),
        [RiskSignal::Auth]
    );

    let status = grove_lib::git::read_project_status(&project);
    assert_eq!(status.agent.as_deref(), Some("claude"));
    assert!(
        status.dirty_age_seconds.is_some(),
        "a dirty project has an age"
    );
    let clean = grove_lib::git::read_project_status(&fixture.canonical("clean"));
    assert_eq!((clean.dirty_age_seconds, clean.agent), (None, None));
}

#[test]
fn review_mark_resets_when_the_file_changes() {
    use grove_lib::review::{list_reviewed, set_reviewed, ReviewMark};

    let fixture = Fixture::new("review");
    let project = fixture.canonical("dirty");
    let store = fixture.path("app-data/review-state.json");
    let current_hash = || {
        let changes = grove_lib::git::read_project_changes(&project, false).expect("changes");
        let file = changes.files.into_iter().find(|f| f.path == "tracked.txt");
        file.expect("tracked.txt changed").content_hash
    };
    let viewed = |hash: &str| {
        let marks = list_reviewed(&store, &project).expect("list marks");
        marks
            .iter()
            .any(|mark| mark.file_path == "tracked.txt" && mark.content_hash == hash)
    };

    let marked_hash = current_hash();
    let blob = git2::Oid::hash_file(git2::ObjectType::Blob, fixture.path("dirty/tracked.txt"));
    assert_eq!(marked_hash, blob.expect("hash").to_string());
    assert!(!viewed(&marked_hash), "nothing is viewed before a mark");
    let mark = ReviewMark {
        project_path: project.clone(),
        file_path: "tracked.txt".to_string(),
        content_hash: marked_hash.clone(),
    };
    set_reviewed(&store, mark.clone(), true).expect("mark viewed");
    set_reviewed(&store, mark.clone(), true).expect("mark again");
    assert_eq!(list_reviewed(&store, &project).expect("list").len(), 1);
    assert!(viewed(&current_hash()), "an unchanged file stays viewed");

    fixture.write("dirty/tracked.txt", "one\ntwo\nthree\n");
    let edited_hash = current_hash();
    assert_ne!(edited_hash, marked_hash);
    assert!(!viewed(&edited_hash), "an edit resets the mark");

    set_reviewed(&store, mark, false).expect("unmark");
    assert!(list_reviewed(&store, &project).expect("list").is_empty());
}
