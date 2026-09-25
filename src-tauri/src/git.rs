use std::collections::HashSet;
use std::path::Path;

use base64::Engine as _;
use git2::{
    BranchType, Delta, Diff, DiffDelta, DiffFile, DiffFindOptions, DiffFlags, DiffOptions, Oid,
    Patch, Repository, Status, StatusOptions, Tree,
};
use serde::{Deserialize, Serialize};

use crate::config::canonicalize_project_paths;
use crate::discovery::directory_holds_git_metadata;

/// A content side above this size is dropped instead of hydrated, so one huge file
/// cannot push megabytes through IPC.
pub const MAX_TEXT_SIDE_BYTES: u64 = 512 * 1024;

/// Image previews above this size are omitted. The text cap still applies to
/// `oldContents` / `newContents`.
const MAX_IMAGE_SIDE_BYTES: u64 = 5 * 1024 * 1024;

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

/// Which comparison a file diff shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffView {
    Head,
    Staged,
    Unstaged,
}

impl std::fmt::Display for DiffView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            DiffView::Head => "head",
            DiffView::Staged => "staged",
            DiffView::Unstaged => "unstaged",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: Option<String>,
    pub head_short: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    pub branch: Option<BranchInfo>,
    pub worktree_of: Option<String>,
    pub watching: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileChangeStatus,
    pub staged: bool,
    pub unstaged: bool,
    pub binary: bool,
    pub additions: u32,
    pub deletions: u32,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChanges {
    pub path: String,
    pub files: Vec<ChangeSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
    pub old_data_url: Option<String>,
    pub new_data_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileChangeStatus,
    pub view: DiffView,
    pub binary: bool,
    pub patch: String,
    pub old_contents: Option<String>,
    pub new_contents: Option<String>,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    pub image: Option<ImagePreview>,
}

struct StatusCounts {
    staged: u32,
    unstaged: u32,
    untracked: u32,
    additions: u32,
    deletions: u32,
}

enum SideSource {
    Absent,
    Head,
    Index,
    Worktree,
}

/// Reads one registered project. A path that is gone or unopenable is a state, never
/// an error: the sidebar still has to render the row. `watching` is filled in by the
/// command from the watcher, not from git.
pub fn read_project_status(path: &str) -> ProjectStatus {
    if !directory_holds_git_metadata(Path::new(path)) {
        let reason = if Path::new(path).exists() {
            "not a git repository"
        } else {
            "the directory is gone"
        };
        return closed_project_status(path, ProjectState::Missing, Some(reason.to_string()));
    }

    let repository = match Repository::open(path) {
        Ok(repository) => repository,
        Err(error) => {
            eprintln!("{path}: {error}");
            return closed_project_status(path, ProjectState::Unreadable, Some(error.to_string()));
        }
    };

    match status_counts(&repository) {
        Ok(counts) => open_project_status(path, counts, &repository),
        Err(error) => {
            eprintln!("{path}: {error}");
            closed_project_status(path, ProjectState::Unreadable, Some(error.to_string()))
        }
    }
}

/// Summaries only: no patches and no file contents. Line counts are the head view
/// (HEAD against the worktree, index included).
pub fn read_project_changes(
    project_path: &str,
    ignore_whitespace: bool,
) -> Result<ProjectChanges, String> {
    let path = canonical_project_path(project_path)?;
    let repository = open_repository(&path)?;
    let head = head_tree(&repository)?;
    let staged = changed_paths(&repository, head.as_ref(), DiffView::Staged, false)?;
    let unstaged = changed_paths(&repository, head.as_ref(), DiffView::Unstaged, false)?;
    let diff = view_diff(
        &repository,
        head.as_ref(),
        DiffView::Head,
        ignore_whitespace,
        &[],
    )?;

    Ok(ProjectChanges {
        path,
        files: change_summaries(&staged, &unstaged, &diff),
    })
}

/// One file, one view. The two content sides are the sides of that view.
pub fn read_file_diff(
    project_path: &str,
    file_path: &str,
    view: DiffView,
    ignore_whitespace: bool,
) -> Result<FileDiff, String> {
    let path = canonical_project_path(project_path)?;
    let repository = open_repository(&path)?;
    let head = head_tree(&repository)?;
    let pathspec = paths_for_file(&repository, file_path);
    let diff = view_diff(
        &repository,
        head.as_ref(),
        view,
        ignore_whitespace,
        &pathspec,
    )?;

    file_diff_for_path(&repository, head.as_ref(), &diff, file_path, view)
        .ok_or_else(|| format!("{file_path}: no {view} change"))
}

/// Counts come from one `statuses` pass for the three path counts and from the
/// workdir diff for the line totals, so a partially staged file is not counted twice.
fn summarize_status_counts(statuses: &git2::Statuses<'_>) -> (u32, u32, u32) {
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
fn summarize_line_counts(diff: &Diff<'_>) -> (u32, u32) {
    match diff.stats() {
        Ok(stats) => (
            saturating_u32(stats.insertions()),
            saturating_u32(stats.deletions()),
        ),
        Err(error) => {
            eprintln!("line totals unavailable: {error}");
            (0, 0)
        }
    }
}

fn closed_project_status(path: &str, state: ProjectState, reason: Option<String>) -> ProjectStatus {
    ProjectStatus {
        path: path.to_string(),
        display_name: display_name(path),
        state,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        additions: 0,
        deletions: 0,
        branch: None,
        worktree_of: None,
        watching: false,
        reason,
    }
}

fn open_project_status(path: &str, counts: StatusCounts, repository: &Repository) -> ProjectStatus {
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
        branch: Some(read_branch_info(repository)),
        worktree_of: main_worktree_path(repository),
        watching: false,
        reason: None,
    }
}

fn read_branch_info(repository: &Repository) -> BranchInfo {
    match repository.head() {
        Ok(head) => {
            let head_short = head.target().and_then(|oid| abbreviate(repository, oid));
            if head.is_branch() {
                let name = head.shorthand().ok().map(str::to_string);
                let (upstream, ahead, behind) =
                    upstream_divergence(repository, head.shorthand().ok());
                BranchInfo {
                    name,
                    head_short,
                    upstream,
                    ahead,
                    behind,
                }
            } else {
                BranchInfo {
                    name: None,
                    head_short,
                    upstream: None,
                    ahead: 0,
                    behind: 0,
                }
            }
        }
        Err(_) => BranchInfo {
            name: unborn_branch_name(repository),
            head_short: None,
            upstream: None,
            ahead: 0,
            behind: 0,
        },
    }
}

fn upstream_divergence(
    repository: &Repository,
    branch_name: Option<&str>,
) -> (Option<String>, u32, u32) {
    let Some(branch_name) = branch_name else {
        return (None, 0, 0);
    };
    let Ok(branch) = repository.find_branch(branch_name, BranchType::Local) else {
        return (None, 0, 0);
    };
    let Ok(upstream) = branch.upstream() else {
        return (None, 0, 0);
    };
    let name = upstream.name().ok().flatten().map(str::to_string);
    let (ahead, behind) = match (branch.get().target(), upstream.get().target()) {
        (Some(local), Some(upstream_oid)) => repository
            .graph_ahead_behind(local, upstream_oid)
            .unwrap_or((0, 0)),
        _ => (0, 0),
    };
    (name, saturating_u32(ahead), saturating_u32(behind))
}

fn unborn_branch_name(repository: &Repository) -> Option<String> {
    let head = repository.find_reference("HEAD").ok()?;
    let target = head.symbolic_target().ok().flatten()?;
    target.strip_prefix("refs/heads/").map(str::to_string)
}

fn abbreviate(repository: &Repository, oid: Oid) -> Option<String> {
    let object = repository.find_object(oid, None).ok()?;
    let buf = object.short_id().ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Linked worktrees point at the main worktree. `commondir` is the main `.git`
/// directory, so its parent is the main worktree path.
fn main_worktree_path(repository: &Repository) -> Option<String> {
    if !repository.is_worktree() {
        return None;
    }
    let main = repository.commondir().parent()?;
    let resolved = std::fs::canonicalize(main).unwrap_or_else(|_| main.to_path_buf());
    Some(resolved.to_string_lossy().into_owned())
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
    let diff = view_diff(repository, head.as_ref(), DiffView::Head, false, &[])?;
    let (additions, deletions) = summarize_line_counts(&diff);

    Ok(StatusCounts {
        staged,
        unstaged,
        untracked,
        additions,
        deletions,
    })
}

/// Peels HEAD to a tree. A repository whose branch is unborn has no HEAD to compare
/// against, so the diff runs against an empty tree.
fn head_tree(repository: &Repository) -> Result<Option<Tree<'_>>, String> {
    match repository.head() {
        Ok(head) => head
            .peel_to_tree()
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) => match error.code() {
            git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound => Ok(None),
            _ => Err(error.to_string()),
        },
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

fn diff_options(ignore_whitespace: bool, limit_size: bool) -> DiffOptions {
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true)
        .context_lines(PATCH_CONTEXT_LINES);
    if ignore_whitespace {
        options.ignore_whitespace(true);
    }
    if limit_size {
        // Status totals must not read a huge untracked file as text.
        options.max_size(MAX_TEXT_SIDE_BYTES as i64);
    }
    options
}

fn view_diff<'repository>(
    repository: &'repository Repository,
    head: Option<&Tree<'_>>,
    view: DiffView,
    ignore_whitespace: bool,
    pathspec: &[String],
) -> Result<Diff<'repository>, String> {
    let limit_size = view == DiffView::Head && pathspec.is_empty() && !ignore_whitespace;
    let mut options = diff_options(ignore_whitespace, limit_size);
    for path in pathspec {
        options.pathspec(path.as_str());
    }

    let mut diff = match view {
        DiffView::Head => repository
            .diff_tree_to_workdir_with_index(head, Some(&mut options))
            .map_err(|error| error.to_string())?,
        DiffView::Staged => repository
            .diff_tree_to_index(head, None, Some(&mut options))
            .map_err(|error| error.to_string())?,
        DiffView::Unstaged => repository
            .diff_index_to_workdir(None, Some(&mut options))
            .map_err(|error| error.to_string())?,
    };
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

fn changed_paths(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    view: DiffView,
    ignore_whitespace: bool,
) -> Result<HashSet<String>, String> {
    let diff = view_diff(repository, head, view, ignore_whitespace, &[])?;
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

/// Paths the single-file diff must include so rename detection can see both sides.
fn paths_for_file(repository: &Repository, file_path: &str) -> Vec<String> {
    let mut paths = vec![file_path.to_string()];
    let mut options = status_options();
    let Ok(statuses) = repository.statuses(Some(&mut options)) else {
        return paths;
    };

    for entry in statuses.iter() {
        let entry_path = entry.path().unwrap_or("");
        let mut touched = entry_path == file_path;
        let mut extra = Vec::new();
        for delta in [entry.head_to_index(), entry.index_to_workdir()]
            .into_iter()
            .flatten()
        {
            for side in [delta.old_file().path(), delta.new_file().path()]
                .into_iter()
                .flatten()
            {
                let text = side.to_string_lossy().into_owned();
                if text == file_path {
                    touched = true;
                }
                extra.push(text);
            }
        }
        if touched {
            paths.append(&mut extra);
            if !entry_path.is_empty() {
                paths.push(entry_path.to_string());
            }
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

fn change_summaries(
    staged: &HashSet<String>,
    unstaged: &HashSet<String>,
    diff: &Diff<'_>,
) -> Vec<ChangeSummary> {
    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        match change_summary_from_delta(&delta, diff, index, staged, unstaged) {
            Some(summary) => files.push(summary),
            None => report_skipped_delta(&delta),
        }
    }
    files
}

fn change_summary_from_delta(
    delta: &DiffDelta<'_>,
    diff: &Diff<'_>,
    index: usize,
    staged: &HashSet<String>,
    unstaged: &HashSet<String>,
) -> Option<ChangeSummary> {
    let status = file_change_status_from_delta(delta)?;
    let path = delta_path(delta)?;
    let old_path = renamed_source(delta, status);
    let binary = delta_is_binary(delta);
    let old_mode = file_mode(&delta.old_file());
    let new_mode = file_mode(&delta.new_file());
    if status == FileChangeStatus::Modified
        && !binary
        && old_mode == new_mode
        && delta_hunk_count(diff, index) == 0
    {
        // Whitespace-insensitive diffs leave such deltas with nothing to show.
        return None;
    }
    let (additions, deletions) = delta_line_counts(diff, index, binary);

    Some(ChangeSummary {
        staged: path_in_set(&path, old_path.as_deref(), staged),
        unstaged: status == FileChangeStatus::Untracked
            || path_in_set(&path, old_path.as_deref(), unstaged),
        binary,
        additions,
        deletions,
        old_mode,
        new_mode,
        old_path,
        status,
        path,
    })
}

fn file_diff_for_path(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    diff: &Diff<'_>,
    file_path: &str,
    view: DiffView,
) -> Option<FileDiff> {
    let (index, delta) = diff.deltas().enumerate().find(|(_, delta)| {
        delta_path(delta).as_deref() == Some(file_path)
            || delta
                .old_file()
                .path()
                .is_some_and(|path| path.to_string_lossy() == file_path)
    })?;
    let status = file_change_status_from_delta(&delta)?;
    let path = delta_path(&delta)?;
    let old_path = renamed_source(&delta, status);
    let binary = delta_is_binary(&delta);
    let old_side_path = old_path.clone().unwrap_or_else(|| path.clone());
    let (old_source, new_source) = view_sources(view);
    let old_source = if delta.old_file().exists() {
        old_source
    } else {
        SideSource::Absent
    };
    let new_source = if delta.new_file().exists() {
        new_source
    } else {
        SideSource::Absent
    };
    let old_bytes = read_side(repository, head, old_source, &old_side_path);
    let new_bytes = read_side(repository, head, new_source, &path);

    let image = image_preview(
        &old_side_path,
        old_bytes.as_deref(),
        &path,
        new_bytes.as_deref(),
    );
    Some(FileDiff {
        path,
        old_path,
        status,
        view,
        binary,
        patch: unified_patch(diff, index, binary),
        // An image renders from its preview; its bytes are not a text diff.
        old_contents: image
            .as_ref()
            .map_or_else(|| text_side(old_bytes.as_deref(), binary), |_| None),
        new_contents: image
            .as_ref()
            .map_or_else(|| text_side(new_bytes.as_deref(), binary), |_| None),
        old_mode: file_mode(&delta.old_file()),
        new_mode: file_mode(&delta.new_file()),
        image,
    })
}

fn view_sources(view: DiffView) -> (SideSource, SideSource) {
    match view {
        DiffView::Head => (SideSource::Head, SideSource::Worktree),
        DiffView::Staged => (SideSource::Head, SideSource::Index),
        DiffView::Unstaged => (SideSource::Index, SideSource::Worktree),
    }
}

fn file_change_status_from_delta(delta: &DiffDelta<'_>) -> Option<FileChangeStatus> {
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

fn unified_patch(diff: &Diff<'_>, delta_index: usize, binary: bool) -> String {
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

fn delta_line_counts(diff: &Diff<'_>, index: usize, binary: bool) -> (u32, u32) {
    if binary {
        return (0, 0);
    }
    let Ok(Some(patch)) = Patch::from_diff(diff, index) else {
        return (0, 0);
    };
    match patch.line_stats() {
        Ok((_, additions, deletions)) => (saturating_u32(additions), saturating_u32(deletions)),
        Err(error) => {
            eprintln!("line counts unavailable: {error}");
            (0, 0)
        }
    }
}

fn delta_hunk_count(diff: &Diff<'_>, index: usize) -> usize {
    match Patch::from_diff(diff, index) {
        Ok(Some(patch)) => patch.num_hunks(),
        _ => 0,
    }
}

fn text_side(bytes: Option<&[u8]>, binary: bool) -> Option<String> {
    let bytes = bytes?;
    if binary || bytes.len() as u64 > MAX_TEXT_SIDE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn read_side(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    source: SideSource,
    path: &str,
) -> Option<Vec<u8>> {
    let limit = read_limit(path);
    match source {
        SideSource::Absent => None,
        SideSource::Head => blob_bytes(repository, head, path, limit),
        SideSource::Index => index_bytes(repository, path, limit),
        SideSource::Worktree => workdir_bytes(repository, path, limit),
    }
}

fn read_limit(path: &str) -> u64 {
    if image_mime(path).is_some() {
        MAX_IMAGE_SIDE_BYTES
    } else {
        MAX_TEXT_SIDE_BYTES
    }
}

fn blob_bytes(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    path: &str,
    limit: u64,
) -> Option<Vec<u8>> {
    let entry = head?.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repository).ok()?.into_blob().ok()?;
    if blob.size() as u64 > limit {
        return None;
    }
    Some(blob.content().to_vec())
}

fn index_bytes(repository: &Repository, path: &str, limit: u64) -> Option<Vec<u8>> {
    let index = repository.index().ok()?;
    let entry = index.get_path(Path::new(path), 0)?;
    let blob = repository.find_blob(entry.id).ok()?;
    if blob.size() as u64 > limit {
        return None;
    }
    Some(blob.content().to_vec())
}

fn workdir_bytes(repository: &Repository, path: &str, limit: u64) -> Option<Vec<u8>> {
    let full = repository.workdir()?.join(path);
    let metadata = std::fs::metadata(&full).ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    std::fs::read(&full).ok()
}

fn image_preview(
    old_path: &str,
    old_bytes: Option<&[u8]>,
    new_path: &str,
    new_bytes: Option<&[u8]>,
) -> Option<ImagePreview> {
    let old_mime = image_mime(old_path);
    let new_mime = image_mime(new_path);
    if old_mime.is_none() && new_mime.is_none() {
        return None;
    }
    Some(ImagePreview {
        old_data_url: data_url(old_mime, old_bytes),
        new_data_url: data_url(new_mime, new_bytes),
    })
}

fn data_url(mime: Option<&str>, bytes: Option<&[u8]>) -> Option<String> {
    let mime = mime?;
    let bytes = bytes?;
    if bytes.len() as u64 > MAX_IMAGE_SIDE_BYTES {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn image_mime(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

fn file_mode(file: &DiffFile<'_>) -> Option<u32> {
    if !file.exists() {
        return None;
    }
    let mode = u32::from(file.mode());
    if mode == 0 {
        None
    } else {
        Some(mode)
    }
}

fn delta_is_binary(delta: &DiffDelta<'_>) -> bool {
    delta.flags().contains(DiffFlags::BINARY)
}

fn delta_path(delta: &DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|path| path.to_string_lossy().into_owned())
}

fn renamed_source(delta: &DiffDelta<'_>, status: FileChangeStatus) -> Option<String> {
    if status != FileChangeStatus::Renamed {
        return None;
    }
    delta
        .old_file()
        .path()
        .map(|path| path.to_string_lossy().into_owned())
}

fn path_in_set(path: &str, old_path: Option<&str>, paths: &HashSet<String>) -> bool {
    paths.contains(path) || old_path.is_some_and(|source| paths.contains(source))
}

fn report_skipped_delta(delta: &DiffDelta<'_>) {
    if delta.status() == Delta::Unreadable {
        eprintln!(
            "{}: unreadable delta, skipped",
            delta_path(delta).unwrap_or_else(|| "<unknown>".to_string())
        );
    }
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn saturating_u32(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
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
            let root = std::env::temp_dir()
                .join(format!("grove-unit-{}-{unique}-{name}", std::process::id()));
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

        let diff = read_file_diff(&fixture.canonical(), "untracked.txt", DiffView::Head, false)
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

        let head = read_file_diff(&root, "note.txt", DiffView::Head, false).expect("head");
        let staged = read_file_diff(&root, "note.txt", DiffView::Staged, false).expect("staged");
        let unstaged =
            read_file_diff(&root, "note.txt", DiffView::Unstaged, false).expect("unstaged");

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
        let diff = read_file_diff(&root, "script.sh", DiffView::Staged, false).expect("mode diff");
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

        let diff = read_file_diff(&fixture.canonical(), "photo.png", DiffView::Head, false)
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
}
