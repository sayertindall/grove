use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine as _;
use git2::{IndexAddOption, Repository, Signature};

use super::*;

static FIXTURE_COUNTER: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let unique = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("grove-unit-{}-{unique}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let fixture = Fixture { root };
        Repository::init(fixture.path("")).expect("repository init");
        fixture
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    fn canonical(&self) -> String {
        std::fs::canonicalize(&self.root)
            .expect("canonical root")
            .to_string_lossy()
            .into_owned()
    }

    fn write(&self, relative: &str, contents: &str) {
        self.write_bytes(relative, contents.as_bytes());
    }

    fn write_bytes(&self, relative: &str, contents: &[u8]) {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent directory");
        }
        std::fs::write(path, contents).expect("write file");
    }

    fn commit_all(&self, message: &str) {
        let repository = Repository::open(&self.root).expect("open repository");
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

    fn stage_file(&self, relative: &str) {
        let repository = Repository::open(&self.root).expect("open repository");
        let mut index = repository.index().expect("index");
        index.add_path(Path::new(relative)).expect("stage file");
        index.write().expect("write index");
    }

    fn stage_rename(&self, from: &str, to: &str) {
        std::fs::rename(self.path(from), self.path(to)).expect("rename file");
        let repository = Repository::open(&self.root).expect("open repository");
        let mut index = repository.index().expect("index");
        index
            .remove_path(Path::new(from))
            .expect("drop the old path");
        index.add_path(Path::new(to)).expect("add the new path");
        index.write().expect("write index");
    }

    fn stage_mode(&self, relative: &str, mode: u32) {
        let repository = Repository::open(&self.root).expect("open repository");
        let mut index = repository.index().expect("index");
        let mut entry = index.get_path(Path::new(relative), 0).expect("index entry");
        entry.mode = mode;
        index.add(&entry).expect("update mode");
        index.write().expect("write index");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn read_project_status_reports_clean_tree() {
    let fixture = Fixture::new("clean");
    fixture.write("README.md", "clean\n");
    fixture.commit_all("initial");

    let status = read_project_status(&fixture.canonical());

    assert_eq!(status.state, ProjectState::Clean);
    assert_eq!(
        status.display_name,
        fixture
            .root
            .file_name()
            .expect("fixture directory name")
            .to_string_lossy()
            .to_string()
    );
    assert_eq!(status.staged_count, 0);
    assert_eq!(status.unstaged_count, 0);
    assert_eq!(status.untracked_count, 0);
    assert_eq!(status.additions, 0);
    assert_eq!(status.deletions, 0);
    assert!(!status.watching);
    assert!(status.reason.is_none());
    assert!(status.worktree_of.is_none());
    let branch = status.branch.as_ref().expect("branch");
    assert!(branch.name.is_some());
    assert!(branch.head_short.is_some());
    assert_eq!(branch.upstream, None);
    assert_eq!((branch.ahead, branch.behind), (0, 0));

    let json = serde_json::to_value(&status).expect("status json");
    assert!(json.get("headShort").is_none());
    assert!(json["branch"].get("headShort").is_some());
    assert!(json.get("worktreeOf").is_some());
}

#[test]
fn read_project_status_counts_dirty_tree() {
    let fixture = Fixture::new("dirty");
    fixture.write("tracked.txt", "one\n");
    fixture.commit_all("initial");
    fixture.write("tracked.txt", "one\ntwo\n");
    fixture.write("extra.txt", "x\n");

    let status = read_project_status(&fixture.canonical());

    assert_eq!(status.state, ProjectState::Dirty);
    assert_eq!(status.staged_count, 0);
    assert_eq!(status.unstaged_count, 1);
    assert_eq!(status.untracked_count, 1);
    assert_eq!(status.additions, 2);
    assert_eq!(status.deletions, 0);
}

#[test]
fn missing_and_unreadable_projects_carry_a_reason() {
    let missing = read_project_status("/tmp/grove-missing-project-does-not-exist");
    assert_eq!(missing.state, ProjectState::Missing);
    assert_eq!(missing.reason.as_deref(), Some("the directory is gone"));
    assert!(missing.branch.is_none());

    let unique = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("grove-unit-unreadable-{unique}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("unreadable root");
    std::fs::write(root.join(".git"), "not a gitdir").expect("fake git file");
    let unreadable = read_project_status(&root.to_string_lossy());
    assert_eq!(unreadable.state, ProjectState::Unreadable);
    assert!(unreadable.reason.is_some());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn list_changes_reports_rename() {
    let fixture = Fixture::new("renamed");
    fixture.write("old.txt", "same\n");
    fixture.commit_all("initial");
    fixture.stage_rename("old.txt", "new.txt");

    let changes = read_project_changes(&fixture.canonical(), false).expect("changes");

    assert_eq!(changes.files.len(), 1);
    let change = &changes.files[0];
    assert_eq!(change.path, "new.txt");
    assert_eq!(change.old_path.as_deref(), Some("old.txt"));
    assert_eq!(change.status, FileChangeStatus::Renamed);
    assert!(change.staged);
    assert!(!change.unstaged);
    assert!(!change.binary);
    assert_eq!(change.old_mode, Some(0o100644));
    assert_eq!(change.new_mode, Some(0o100644));
}

#[test]
fn list_changes_lists_untracked_files_when_head_missing() {
    let fixture = Fixture::new("unborn");
    fixture.write("untracked.txt", "hello\n");

    let changes = read_project_changes(&fixture.canonical(), false).expect("changes");

    assert_eq!(changes.files.len(), 1);
    let change = &changes.files[0];
    assert_eq!(change.path, "untracked.txt");
    assert_eq!(change.old_path, None);
    assert_eq!(change.status, FileChangeStatus::Untracked);
    assert!(!change.staged);
    assert!(change.unstaged);
    assert_eq!(change.additions, 1);

    let diff = read_file_diff(
        &fixture.canonical(),
        "untracked.txt",
        DiffView::Head,
        false,
        DiffContext::Default,
        None,
    )
    .expect("file diff");
    assert_eq!(diff.old_contents, None);
    assert_eq!(diff.new_contents.as_deref(), Some("hello\n"));
    assert!(diff.patch.contains("+hello"));
    assert!(diff.image.is_none());
}

#[test]
fn file_diff_views_differ_for_a_partially_staged_file() {
    let fixture = Fixture::new("partial");
    fixture.write("note.txt", "base\n");
    fixture.commit_all("initial");
    fixture.write("note.txt", "base\nstaged\n");
    fixture.stage_file("note.txt");
    fixture.write("note.txt", "base\nstaged\nunstaged\n");

    let root = fixture.canonical();
    let changes = read_project_changes(&root, false).expect("changes");
    let summary = changes
        .files
        .iter()
        .find(|file| file.path == "note.txt")
        .expect("note.txt");
    assert!(summary.staged && summary.unstaged);
    assert_eq!(summary.status, FileChangeStatus::Modified);
    assert_eq!((summary.additions, summary.deletions), (2, 0));

    let head = read_file_diff(
        &root,
        "note.txt",
        DiffView::Head,
        false,
        DiffContext::Default,
        None,
    )
    .expect("head");
    let staged = read_file_diff(
        &root,
        "note.txt",
        DiffView::Staged,
        false,
        DiffContext::Default,
        None,
    )
    .expect("staged");
    let unstaged = read_file_diff(
        &root,
        "note.txt",
        DiffView::Unstaged,
        false,
        DiffContext::Default,
        None,
    )
    .expect("unstaged");

    assert_eq!(head.view, DiffView::Head);
    assert_eq!(head.old_contents.as_deref(), Some("base\n"));
    assert_eq!(
        head.new_contents.as_deref(),
        Some("base\nstaged\nunstaged\n")
    );

    assert_eq!(staged.view, DiffView::Staged);
    assert_eq!(staged.old_contents.as_deref(), Some("base\n"));
    assert_eq!(staged.new_contents.as_deref(), Some("base\nstaged\n"));

    assert_eq!(unstaged.view, DiffView::Unstaged);
    assert_eq!(unstaged.old_contents.as_deref(), Some("base\nstaged\n"));
    assert_eq!(
        unstaged.new_contents.as_deref(),
        Some("base\nstaged\nunstaged\n")
    );

    assert_ne!(staged.new_contents, unstaged.new_contents);
    assert_ne!(head.new_contents, staged.new_contents);
    assert_ne!(head.old_contents, unstaged.old_contents);

    let json = serde_json::to_value(&head).expect("diff json");
    assert_eq!(json["view"], "head");
    assert!(json.get("oldContents").is_some());
    assert!(json.get("oldMode").is_some());
    assert_eq!(
        serde_json::from_value::<DiffView>(json["view"].clone()).expect("view"),
        DiffView::Head
    );
}

#[test]
fn ignore_whitespace_hides_a_whitespace_only_change() {
    let fixture = Fixture::new("whitespace");
    fixture.write("space.txt", "hello\n");
    fixture.commit_all("initial");
    fixture.write("space.txt", "hello \n");

    let root = fixture.canonical();
    let shown = read_project_changes(&root, false).expect("changes");
    assert!(shown.files.iter().any(|file| file.path == "space.txt"));

    let hidden = read_project_changes(&root, true).expect("ignored changes");
    assert!(hidden.files.iter().all(|file| file.path != "space.txt"));
}

#[test]
fn mode_only_change_reports_modes_and_no_hunks() {
    let fixture = Fixture::new("mode");
    fixture.write("script.sh", "#!/bin/sh\n");
    fixture.commit_all("initial");
    fixture.stage_mode("script.sh", 0o100755);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = fixture.path("script.sh");
        let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("chmod");
    }

    let root = fixture.canonical();
    let diff = read_file_diff(
        &root,
        "script.sh",
        DiffView::Staged,
        false,
        DiffContext::Default,
        None,
    )
    .expect("mode diff");
    assert_eq!(diff.old_mode, Some(0o100644));
    assert_eq!(diff.new_mode, Some(0o100755));
    assert!(!diff.patch.contains("@@"));
    assert_eq!(diff.old_contents, diff.new_contents);

    let changes = read_project_changes(&root, false).expect("changes");
    let summary = changes
        .files
        .iter()
        .find(|file| file.path == "script.sh")
        .expect("script.sh");
    assert_eq!(summary.old_mode, Some(0o100644));
    assert_eq!(summary.new_mode, Some(0o100755));
    assert_eq!((summary.additions, summary.deletions), (0, 0));
}

#[test]
fn image_preview_is_a_base64_data_url() {
    let fixture = Fixture::new("image");
    fixture.write("README.md", "clean\n");
    fixture.commit_all("initial");
    let png = b"\x89PNG\r\n\x1a\nfake";
    fixture.write_bytes("photo.png", png);

    let diff = read_file_diff(
        &fixture.canonical(),
        "photo.png",
        DiffView::Head,
        false,
        DiffContext::Default,
        None,
    )
    .expect("image diff");
    let image = diff.image.expect("image preview");
    assert!(image.old_data_url.is_none());
    let url = image.new_data_url.expect("new data url");
    assert!(url.starts_with("data:image/png;base64,"));
    let encoded = url.trim_start_matches("data:image/png;base64,");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("decode");
    assert_eq!(decoded, png);
    assert!(diff.old_contents.is_none());
    assert!(diff.new_contents.is_none());
}

/// Manual large-repository check: run with GROVE_LARGE_REPO set to a path.
#[test]
#[ignore = "manual: needs GROVE_LARGE_REPO and a warm file cache"]
fn read_project_status_warm_latency() {
    let path = std::env::var("GROVE_LARGE_REPO").expect("GROVE_LARGE_REPO");
    let _ = read_project_status(&path);
    let start = std::time::Instant::now();
    let status = read_project_status(&path);
    let elapsed = start.elapsed();

    println!(
        "{}: {:?} ({:?})",
        status.display_name, elapsed, status.state
    );
    assert!(elapsed.as_millis() < 500, "warm read took {elapsed:?}");
}
