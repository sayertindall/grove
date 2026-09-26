//! Read-only Git access: opening a registered project, the shared diff options,
//! and the wire enums. `status` reads counts and change lists, `diff` reads one
//! file, `history` reads commits, blame, search, and worktrees.

mod diff;
mod history;
mod status;
#[cfg(test)]
mod tests;
mod triage;

use std::path::Path;

use git2::{
    Delta, Diff, DiffDelta, DiffFile, DiffFindOptions, DiffFlags, DiffOptions, FileMode, Oid,
    Repository, StatusOptions, Tree,
};
use serde::{Deserialize, Serialize};

use crate::config::canonicalize_project_paths;
use crate::discovery::directory_holds_git_metadata;
use crate::error::GroveError;

pub use diff::{
    read_file_diff, ConflictSides, DiffHunk, DiffLine, DiffLineKind, FileDiff, ImagePreview,
};
pub use history::{
    read_blame, read_blame_view, read_file_history, read_recent_commits, read_worktrees,
    repository_main_path, search_changed_files, BlameLine, BlameView, BlameViewLine, ChangeMatch,
    CommitInfo, WorktreeInfo, MAX_BLAME_LINES, MAX_COMMIT_LIMIT,
};
pub use status::{
    read_project_changes, read_project_status, BranchInfo, ChangeSummary, ProjectChanges,
    ProjectStatus,
};
pub use triage::{refresh_dirty_age, RiskSignal};

/// A content side above this size is dropped instead of hydrated, so one huge file
/// cannot push megabytes through IPC.
pub const MAX_TEXT_SIDE_BYTES: u64 = 512 * 1024;

/// Image previews above this size are omitted. The text cap still applies to
/// `oldContents` / `newContents`.
const MAX_IMAGE_SIDE_BYTES: u64 = 5 * 1024 * 1024;

/// Context lines around each hunk when the caller does not ask for a number.
pub const DEFAULT_CONTEXT_LINES: u32 = 3;

/// The largest explicit context a caller may ask for; `all` covers the rest.
pub const MAX_CONTEXT_LINES: u32 = 10;

/// Context for `all`: large enough that every file becomes one hunk, small enough
/// that libgit2's `2 * context + interhunk` arithmetic cannot overflow.
const WHOLE_FILE_CONTEXT_LINES: u32 = 1 << 28;

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
    /// Unmerged: the index holds conflict stages for the path.
    Conflicted,
    /// A gitlink whose recorded commit moved; its contents are never read.
    Submodule,
}

/// The two commits a submodule (gitlink) entry points at; absent when that side has
/// no entry. Full hex ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePointer {
    pub old_commit: Option<String>,
    pub new_commit: Option<String>,
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

/// The one parser of a view word, shared by the CLI and the chat tools.
impl std::str::FromStr for DiffView {
    type Err = GroveError;

    fn from_str(value: &str) -> Result<DiffView, GroveError> {
        match value {
            "head" => Ok(DiffView::Head),
            "staged" => Ok(DiffView::Staged),
            "unstaged" => Ok(DiffView::Unstaged),
            other => Err(GroveError::usage(format!(
                "unknown view `{other}` (expected head, staged, or unstaged)"
            ))),
        }
    }
}

/// How much unchanged text surrounds each hunk. On the wire: `"default"`, a number
/// from 0 to `MAX_CONTEXT_LINES`, or `"all"` for the whole file as one hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(try_from = "DiffContextWire", into = "DiffContextWire")]
pub enum DiffContext {
    #[default]
    Default,
    Lines(u32),
    All,
}

impl DiffContext {
    fn context_lines(self) -> u32 {
        match self {
            DiffContext::Default => DEFAULT_CONTEXT_LINES,
            DiffContext::Lines(lines) => lines,
            DiffContext::All => WHOLE_FILE_CONTEXT_LINES,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum DiffContextWire {
    Keyword(DiffContextKeyword),
    Lines(u32),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DiffContextKeyword {
    Default,
    All,
}

impl TryFrom<DiffContextWire> for DiffContext {
    type Error = String;

    fn try_from(wire: DiffContextWire) -> Result<DiffContext, String> {
        match wire {
            DiffContextWire::Keyword(DiffContextKeyword::Default) => Ok(DiffContext::Default),
            DiffContextWire::Keyword(DiffContextKeyword::All) => Ok(DiffContext::All),
            DiffContextWire::Lines(lines) if lines <= MAX_CONTEXT_LINES => {
                Ok(DiffContext::Lines(lines))
            }
            DiffContextWire::Lines(lines) => Err(format!(
                "context {lines} is out of range (0 to {MAX_CONTEXT_LINES}, or \"all\")"
            )),
        }
    }
}

impl From<DiffContext> for DiffContextWire {
    fn from(context: DiffContext) -> DiffContextWire {
        match context {
            DiffContext::Default => DiffContextWire::Keyword(DiffContextKeyword::Default),
            DiffContext::Lines(lines) => DiffContextWire::Lines(lines),
            DiffContext::All => DiffContextWire::Keyword(DiffContextKeyword::All),
        }
    }
}

/// The comparison options every reader shares.
struct DiffRequest {
    view: DiffView,
    ignore_whitespace: bool,
    context: DiffContext,
}

/// Canonicalizes a project argument and opens its repository.
fn open_project(project_path: &str) -> Result<(String, Repository), GroveError> {
    let path = canonical_project_path(project_path)?;
    let repository = open_repository(&path)?;
    Ok((path, repository))
}

fn canonical_project_path(path: &str) -> Result<String, GroveError> {
    canonicalize_project_paths(vec![path.to_string()])?
        .into_iter()
        .next()
        .ok_or_else(|| GroveError::Missing {
            path: path.to_string(),
        })
}

fn open_repository(path: &str) -> Result<Repository, GroveError> {
    if !directory_holds_git_metadata(Path::new(path)) {
        return Err(GroveError::NotARepository {
            path: path.to_string(),
        });
    }
    Repository::open(path).map_err(|error| GroveError::git(path, error))
}

/// Peels HEAD to a tree. A repository whose branch is unborn has no HEAD to compare
/// against, so the diff runs against an empty tree.
fn head_tree(repository: &Repository) -> Result<Option<Tree<'_>>, GroveError> {
    match repository.head() {
        Ok(head) => head
            .peel_to_tree()
            .map(Some)
            .map_err(|error| GroveError::git("HEAD", error)),
        Err(error) => match error.code() {
            git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound => Ok(None),
            _ => Err(GroveError::git("HEAD", error)),
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

fn diff_options(request: &DiffRequest, limit_size: bool) -> DiffOptions {
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .include_typechange(true)
        .ignore_whitespace(request.ignore_whitespace)
        .context_lines(request.context.context_lines());
    if limit_size {
        // Status totals must not read a huge untracked file as text.
        options.max_size(MAX_TEXT_SIDE_BYTES as i64);
    }
    options
}

fn view_diff<'repository>(
    repository: &'repository Repository,
    head: Option<&Tree<'_>>,
    request: &DiffRequest,
    pathspec: &[String],
) -> Result<Diff<'repository>, GroveError> {
    let limit_size =
        request.view == DiffView::Head && pathspec.is_empty() && !request.ignore_whitespace;
    let mut options = diff_options(request, limit_size);
    for path in pathspec {
        options.pathspec(path.as_str());
    }

    let mut diff = match request.view {
        DiffView::Head => repository.diff_tree_to_workdir_with_index(head, Some(&mut options)),
        DiffView::Staged => repository.diff_tree_to_index(head, None, Some(&mut options)),
        DiffView::Unstaged => repository.diff_index_to_workdir(None, Some(&mut options)),
    }
    .map_err(|error| GroveError::git(format!("{} diff", request.view), error))?;
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

fn abbreviate(repository: &Repository, oid: Oid) -> Option<String> {
    let object = repository.find_object(oid, None).ok()?;
    let buf = object.short_id().ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// The abbreviated id, or the first seven hex digits when the object is unreadable.
fn short_id(repository: &Repository, oid: Oid) -> String {
    abbreviate(repository, oid).unwrap_or_else(|| oid.to_string()[..7].to_string())
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

/// A gitlink delta is a submodule pointer whatever libgit2 calls its change; a
/// conflict stays a conflict even on a gitlink.
fn file_change_status_from_delta(delta: &DiffDelta<'_>) -> Option<FileChangeStatus> {
    let status = match delta.status() {
        Delta::Added => FileChangeStatus::Added,
        Delta::Deleted => FileChangeStatus::Deleted,
        Delta::Modified | Delta::Typechange => FileChangeStatus::Modified,
        Delta::Renamed | Delta::Copied => FileChangeStatus::Renamed,
        Delta::Untracked => FileChangeStatus::Untracked,
        Delta::Conflicted => return Some(FileChangeStatus::Conflicted),
        Delta::Unmodified | Delta::Ignored | Delta::Unreadable => return None,
    };
    Some(if delta_is_gitlink(delta) {
        FileChangeStatus::Submodule
    } else {
        status
    })
}

fn delta_is_gitlink(delta: &DiffDelta<'_>) -> bool {
    let gitlink = |file: DiffFile<'_>| file.exists() && file.mode() == FileMode::Commit;
    gitlink(delta.old_file()) || gitlink(delta.new_file())
}

/// The commits a gitlink delta names. `None` for every other delta.
fn submodule_pointer(delta: &DiffDelta<'_>) -> Option<SubmodulePointer> {
    if !delta_is_gitlink(delta) || delta.status() == Delta::Conflicted {
        return None;
    }
    let commit = |file: DiffFile<'_>| file.exists().then(|| file.id().to_string());
    Some(SubmodulePointer {
        old_commit: commit(delta.old_file()),
        new_commit: commit(delta.new_file()),
    })
}

fn file_mode(file: &DiffFile<'_>) -> Option<u32> {
    if !file.exists() {
        return None;
    }
    Some(u32::from(file.mode())).filter(|mode| *mode != 0)
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

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn saturating_u32(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}
