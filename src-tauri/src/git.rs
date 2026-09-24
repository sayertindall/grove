use std::collections::HashSet;
use std::path::Path;

use git2::{
    Delta, Diff, DiffDelta, DiffFindOptions, DiffFlags, DiffOptions, Patch, Repository, Status,
    StatusOptions, Tree,
};
use serde::Serialize;

use crate::config::canonicalize_project_paths;
use crate::discovery::directory_holds_git_metadata;

/// A content side above this size is dropped instead of hydrated, so one huge file
/// cannot push megabytes through IPC.
pub const MAX_TEXT_SIDE_BYTES: u64 = 512 * 1024;

/// The size of the patch the reader builds when the delta is not binary.
const PATCH_CONTEXT_LINES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectState {
    Clean,
    Dirty,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub path: String,
    pub display_name: String,
    pub state: ProjectState,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileChangeStatus,
    pub staged: bool,
    pub binary: bool,
    pub patch: String,
    pub old_contents: Option<String>,
    pub new_contents: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiff {
    pub path: String,
    pub files: Vec<FileChange>,
}

struct StatusCounts {
    staged: u32,
    unstaged: u32,
    untracked: u32,
    additions: u32,
    deletions: u32,
}

/// Everything one delta needs beyond the delta itself.
struct ChangeContext<'repo, 'staged> {
    repository: &'repo Repository,
    head: Option<&'repo Tree<'repo>>,
    staged: &'staged HashSet<String>,
}

/// Reads one registered project. A path that is gone or unopenable is a state, never
/// an error: the sidebar still has to render the row.
pub fn read_project_status(path: &str) -> ProjectStatus {
    if !directory_holds_git_metadata(Path::new(path)) {
        return project_status_when_closed(path, ProjectState::Missing);
    }

    let repository = match Repository::open(path) {
        Ok(repository) => repository,
        Err(error) => {
            eprintln!("{path}: {error}");
            return project_status_when_closed(path, ProjectState::Unreadable);
        }
    };

    match status_counts(&repository) {
        Ok(counts) => open_project_status(path, counts),
        Err(error) => {
            eprintln!("{path}: {error}");
            project_status_when_closed(path, ProjectState::Unreadable)
        }
    }
}

/// The row for a project that could not be read: zero counts, zero line totals.
pub fn project_status_when_closed(path: &str, state: ProjectState) -> ProjectStatus {
    ProjectStatus {
        path: path.to_string(),
        display_name: display_name(path),
        state,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        additions: 0,
        deletions: 0,
    }
}

/// Counts come from one `statuses` pass for the three path counts and from the
/// workdir diff for the line totals, so a partially staged file is not counted twice.
pub fn summarize_status_counts(statuses: &git2::Statuses<'_>) -> (u32, u32, u32) {
    let staged_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE;
    let unstaged_flags =
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE;

    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    for entry in statuses.iter() {
        let status = entry.status();
        if status.intersects(staged_flags) {
            staged += 1;
        }
        if status.intersects(unstaged_flags) {
            unstaged += 1;
        }
        if status.contains(Status::WT_NEW) {
            untracked += 1;
        }
    }

    (staged, unstaged, untracked)
}

/// Line totals of a diff. Counts saturate rather than overflow.
pub fn summarize_line_counts(diff: &Diff<'_>) -> (u32, u32) {
    match diff.stats() {
        Ok(stats) => (
            u32::try_from(stats.insertions()).unwrap_or(u32::MAX),
            u32::try_from(stats.deletions()).unwrap_or(u32::MAX),
        ),
        Err(error) => {
            eprintln!("line totals unavailable: {error}");
            (0, 0)
        }
    }
}

/// Reads every change of one project against HEAD.
pub fn read_project_diff(project_path: &str) -> Result<ProjectDiff, String> {
    let path = canonical_project_path(project_path)?;
    let repository = open_repository(&path)?;
    let head = head_tree(&repository)?;
    let staged = staged_paths(&repository, head.as_ref())?;
    let diff = workdir_diff(&repository, head.as_ref())?;

    Ok(ProjectDiff {
        path,
        files: file_changes(&repository, head.as_ref(), &staged, &diff),
    })
}

/// Peels HEAD to a tree. A repository whose branch is unborn has no HEAD to compare
/// against, so the diff runs against an empty tree.
pub fn head_tree(repository: &Repository) -> Result<Option<Tree<'_>>, String> {
    match repository.head() {
        Ok(head) => head.peel_to_tree().map(Some).map_err(|error| error.to_string()),
        Err(error) => match error.code() {
            git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound => Ok(None),
            _ => Err(error.to_string()),
        },
    }
}

/// Paths touched by the index-versus-HEAD segment, both sides of a rename included.
/// This is the membership set that marks a change as staged.
pub fn staged_paths(
    repository: &Repository,
    head: Option<&Tree<'_>>,
) -> Result<HashSet<String>, String> {
    let mut options = DiffOptions::new();
    let mut diff = repository
        .diff_tree_to_index(head, None, Some(&mut options))
        .map_err(|error| error.to_string())?;
    find_renamed(&mut diff);

    let mut paths = HashSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(path) = file.path() {
                paths.insert(path.to_string_lossy().into_owned());
            }
        }
    }
    Ok(paths)
}

/// Maps a delta to the row status Grove shows. Not a branch tree: one arm per delta.
pub fn file_change_status_from_delta(delta: &DiffDelta<'_>) -> Option<FileChangeStatus> {
    match delta.status() {
        Delta::Added => Some(FileChangeStatus::Added),
        Delta::Deleted => Some(FileChangeStatus::Deleted),
        Delta::Modified => Some(FileChangeStatus::Modified),
        Delta::Renamed | Delta::Copied => Some(FileChangeStatus::Renamed),
        Delta::Untracked => Some(FileChangeStatus::Untracked),
        Delta::Typechange | Delta::Conflicted => Some(FileChangeStatus::Modified),
        Delta::Unmodified | Delta::Ignored | Delta::Unreadable => None,
    }
}

/// The unified patch for one delta, or the literal git2 note for a binary delta.
pub fn unified_patch(diff: &Diff<'_>, delta_index: usize, binary: bool) -> String {
    if binary {
        return "Binary files differ\n".to_string();
    }

    let Ok(Some(mut patch)) = Patch::from_diff(diff, delta_index) else {
        return String::new();
    };

    match patch.to_buf() {
        Ok(buffer) => String::from_utf8_lossy(&buffer).into_owned(),
        Err(error) => {
            eprintln!("patch text unavailable: {error}");
            String::new()
        }
    }
}

/// Decodes one content side, or refuses it: a binary side is never decoded and an
/// oversized side is never hydrated. Invalid UTF-8 still hydrates, lossily.
pub fn read_text_side(bytes: &[u8], byte_len: u64, binary: bool) -> Option<String> {
    if binary || byte_len > MAX_TEXT_SIDE_BYTES {
        return None;
    }

    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn canonical_project_path(path: &str) -> Result<String, String> {
    canonicalize_project_paths(vec![path.to_string()])?
        .into_iter()
        .next()
        .ok_or_else(|| format!("{path}: no canonical path"))
}

fn open_repository(path: &str) -> Result<Repository, String> {
    if !directory_holds_git_metadata(Path::new(path)) {
        return Err(format!("{path}: not a git repository"));
    }

    Repository::open(path).map_err(|error| format!("{path}: {error}"))
}

fn status_counts(repository: &Repository) -> Result<StatusCounts, String> {
    let mut options = status_options();
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|error| error.to_string())?;
    let (staged, unstaged, untracked) = summarize_status_counts(&statuses);

    let head = head_tree(repository)?;
    let diff = workdir_diff(repository, head.as_ref())?;
    let (additions, deletions) = summarize_line_counts(&diff);

    Ok(StatusCounts {
        staged,
        unstaged,
        untracked,
        additions,
        deletions,
    })
}

fn open_project_status(path: &str, counts: StatusCounts) -> ProjectStatus {
    let state = if counts.staged + counts.unstaged + counts.untracked == 0 {
        ProjectState::Clean
    } else {
        ProjectState::Dirty
    };

    ProjectStatus {
        path: path.to_string(),
        display_name: display_name(path),
        state,
        staged_count: counts.staged,
        unstaged_count: counts.unstaged,
        untracked_count: counts.untracked,
        additions: counts.additions,
        deletions: counts.deletions,
    }
}

fn status_options() -> StatusOptions {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    options
}

fn diff_options() -> DiffOptions {
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        // Without this libgit2 never emits a typechange delta, which would leave the
        // Typechange -> Modified mapping unreachable.
        .include_typechange(true)
        .context_lines(PATCH_CONTEXT_LINES);
    options
}

fn workdir_diff<'repository>(
    repository: &'repository Repository,
    head: Option<&Tree<'_>>,
) -> Result<Diff<'repository>, String> {
    let mut options = diff_options();
    let mut diff = repository
        .diff_tree_to_workdir_with_index(head, Some(&mut options))
        .map_err(|error| error.to_string())?;
    find_renamed(&mut diff);
    Ok(diff)
}

/// Rename detection with renames explicitly on, so a rename is one row rather than a
/// delete plus an add on a repository that carries no diff config of its own.
fn find_renamed(diff: &mut Diff<'_>) {
    let mut options = DiffFindOptions::new();
    options.renames(true);
    if let Err(error) = diff.find_similar(Some(&mut options)) {
        eprintln!("rename detection skipped: {error}");
    }
}

fn file_changes(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    staged: &HashSet<String>,
    diff: &Diff<'_>,
) -> Vec<FileChange> {
    let context = ChangeContext {
        repository,
        head,
        staged,
    };

    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        match file_change_from_delta(&context, &delta, diff, index) {
            Some(change) => files.push(change),
            None => report_skipped_delta(&delta),
        }
    }
    files
}

fn file_change_from_delta(
    context: &ChangeContext<'_, '_>,
    delta: &DiffDelta<'_>,
    diff: &Diff<'_>,
    index: usize,
) -> Option<FileChange> {
    let status = file_change_status_from_delta(delta)?;
    let path = delta_path(delta)?;
    let old_path = renamed_source(delta, status);
    let binary = delta.flags().contains(DiffFlags::BINARY);
    let old_side_path = old_path.as_deref().unwrap_or(&path);
    let is_staged = context.staged.contains(&path)
        || old_path
            .as_ref()
            .is_some_and(|source| context.staged.contains(source));

    Some(FileChange {
        staged: is_staged,
        binary,
        patch: unified_patch(diff, index, binary),
        old_contents: head_side(context, old_side_path, binary),
        new_contents: worktree_side(context.repository, &path, binary),
        old_path,
        status,
        path,
    })
}

/// The repo-relative path of a delta, in git's forward-slash form.
fn delta_path(delta: &DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|path| path.to_string_lossy().into_owned())
}

/// The rename source, and only for a rename.
fn renamed_source(delta: &DiffDelta<'_>, status: FileChangeStatus) -> Option<String> {
    if status != FileChangeStatus::Renamed {
        return None;
    }

    delta
        .old_file()
        .path()
        .map(|path| path.to_string_lossy().into_owned())
}

fn report_skipped_delta(delta: &DiffDelta<'_>) {
    if delta.status() == Delta::Unreadable {
        eprintln!(
            "{}: unreadable delta, skipped",
            delta_path(delta).unwrap_or_else(|| "<unknown>".to_string())
        );
    }
}

fn head_side(context: &ChangeContext<'_, '_>, path: &str, binary: bool) -> Option<String> {
    let bytes = blob_bytes(context.repository, context.head, path)?;
    let byte_len = bytes.len() as u64;
    read_text_side(&bytes, byte_len, binary)
}

fn worktree_side(repository: &Repository, path: &str, binary: bool) -> Option<String> {
    let bytes = workdir_bytes(repository, path)?;
    let byte_len = bytes.len() as u64;
    read_text_side(&bytes, byte_len, binary)
}

/// The HEAD blob at `path`, or nothing when it is absent or over the byte cap.
fn blob_bytes(repository: &Repository, head: Option<&Tree<'_>>, path: &str) -> Option<Vec<u8>> {
    let entry = head?.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repository).ok()?.into_blob().ok()?;
    if blob.size() as u64 > MAX_TEXT_SIDE_BYTES {
        return None;
    }

    Some(blob.content().to_vec())
}

/// The worktree file at `path`. A directory (gitlink, nested repository) is not a
/// readable file and yields nothing instead of failing the command.
fn workdir_bytes(repository: &Repository, path: &str) -> Option<Vec<u8>> {
    let full = repository.workdir()?.join(path);
    let metadata = std::fs::metadata(&full).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_TEXT_SIDE_BYTES {
        return None;
    }

    std::fs::read(&full).ok()
}

/// The identity a row shows: the final path component, or the whole path when there
/// is no final component.
fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use git2::{IndexAddOption, Signature};

    use super::*;

    static FIXTURE_COUNTER: AtomicU32 = AtomicU32::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let unique = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "grove-unit-{}-{unique}-{name}",
                std::process::id()
            ));
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
            let signature =
                Signature::now("Grove test", "grove@example.com").expect("signature");
            repository
                .commit(Some("HEAD"), &signature, &signature, message, &tree, &[])
                .expect("commit");
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
    fn read_project_diff_reports_rename() {
        let fixture = Fixture::new("renamed");
        fixture.write("old.txt", "same\n");
        fixture.commit_all("initial");
        fixture.stage_rename("old.txt", "new.txt");

        let diff = read_project_diff(&fixture.canonical()).expect("diff");

        assert_eq!(diff.files.len(), 1);
        let change = &diff.files[0];
        assert_eq!(change.path, "new.txt");
        assert_eq!(change.old_path.as_deref(), Some("old.txt"));
        assert_eq!(change.status, FileChangeStatus::Renamed);
        assert!(change.staged);
        assert!(!change.binary);
        assert_eq!(change.old_contents.as_deref(), Some("same\n"));
        assert_eq!(change.new_contents.as_deref(), Some("same\n"));
        assert!(change.patch.contains("new.txt"));
    }

    #[test]
    fn read_project_diff_lists_untracked_files_when_head_missing() {
        let fixture = Fixture::new("unborn");
        fixture.write("untracked.txt", "hello\n");

        let diff = read_project_diff(&fixture.canonical()).expect("diff");

        assert_eq!(diff.files.len(), 1);
        let change = &diff.files[0];
        assert_eq!(change.path, "untracked.txt");
        assert_eq!(change.old_path, None);
        assert_eq!(change.status, FileChangeStatus::Untracked);
        assert!(!change.staged);
        assert_eq!(change.old_contents, None);
        assert_eq!(change.new_contents.as_deref(), Some("hello\n"));
        assert!(change.patch.contains("+hello"));
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

        println!("{}: {:?} ({:?})", status.display_name, elapsed, status.state);
        assert!(elapsed.as_millis() < 500, "warm read took {elapsed:?}");
    }
}
