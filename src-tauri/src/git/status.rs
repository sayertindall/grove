//! Sidebar rows and change lists: one `statuses` pass for path counts, the head
//! diff for line totals and summaries.

use std::collections::HashSet;
use std::path::Path;
use std::time::SystemTime;

use git2::{
    BranchType, Delta, Diff, DiffDelta, DiffFile, ObjectType, Oid, Patch, Repository, Status, Tree,
};
use serde::Serialize;

use super::triage::{
    added_lines_hold_secret, agent_marker, file_risks, mark_untested_sources, oldest_changed_mtime,
    refresh_dirty_age, RiskSignal,
};
use super::{
    abbreviate, delta_is_binary, delta_path, display_name, file_change_status_from_delta,
    file_mode, head_tree, main_worktree_path, open_project, renamed_source, saturating_u32,
    status_options, submodule_pointer, view_diff, DiffContext, DiffRequest, DiffView,
    FileChangeStatus, ProjectState, SubmodulePointer,
};
use crate::discovery::directory_holds_git_metadata;
use crate::error::GroveError;

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
    /// Seconds since the oldest changed worktree file was last modified.
    pub dirty_age_seconds: Option<u64>,
    /// The coding agent whose marker in the repository root is newest.
    pub agent: Option<String>,
    /// When the oldest changed file was modified; `dirty_age_seconds` is derived
    /// from it on every read, cached or not.
    #[serde(skip)]
    pub dirty_since: Option<SystemTime>,
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
    /// Review signals, most severe first.
    pub risk: Vec<RiskSignal>,
    /// Blob id of the worktree side; empty for a deleted file. A stored review
    /// mark counts only while this still matches.
    pub content_hash: String,
    /// The two commits of a `submodule` row; `None` for every other status.
    pub submodule: Option<SubmodulePointer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChanges {
    pub path: String,
    pub files: Vec<ChangeSummary>,
}

struct StatusCounts {
    staged: u32,
    unstaged: u32,
    untracked: u32,
    additions: u32,
    deletions: u32,
    dirty_since: Option<SystemTime>,
}

/// Which files belong to the staged and unstaged sides of the head view.
struct Membership {
    staged: HashSet<String>,
    unstaged: HashSet<String>,
}

/// Reads one registered project. A path that is gone or unopenable is a state, never
/// an error: the sidebar still has to render the row. `watching` is filled in by the
/// command from the watcher, not from git.
pub fn read_project_status(path: &str) -> ProjectStatus {
    if !directory_holds_git_metadata(Path::new(path)) {
        let reason = missing_reason(path).to_string();
        return closed_project_status(path, ProjectState::Missing, Some(reason));
    }
    let read = Repository::open(path)
        .map_err(|error| GroveError::git(path, error))
        .and_then(|repository| {
            let counts = status_counts(&repository)?;
            let mut status = open_project_status(path, counts, &repository);
            refresh_dirty_age(&mut status);
            Ok(status)
        });
    read.unwrap_or_else(|error| {
        eprintln!("{error}");
        closed_project_status(
            path,
            ProjectState::Unreadable,
            Some(unreadable_reason(error)),
        )
    })
}

/// Summaries only: no patches and no file contents. Line counts are the head view
/// (HEAD against the worktree, index included).
pub fn read_project_changes(
    project_path: &str,
    ignore_whitespace: bool,
) -> Result<ProjectChanges, GroveError> {
    let (path, repository) = open_project(project_path)?;
    let head = head_tree(&repository)?;
    let membership = Membership {
        staged: changed_paths(&repository, head.as_ref(), DiffView::Staged)?,
        unstaged: changed_paths(&repository, head.as_ref(), DiffView::Unstaged)?,
    };
    let request = DiffRequest {
        view: DiffView::Head,
        ignore_whitespace,
        context: DiffContext::Default,
    };
    let diff = view_diff(&repository, head.as_ref(), &request, &[])?;
    let mut files = change_summaries(&membership, &diff);
    if let Some(workdir) = repository.workdir() {
        fill_unread_content_hashes(&mut files, workdir);
    }
    mark_untested_sources(&mut files);
    Ok(ProjectChanges { path, files })
}

fn missing_reason(path: &str) -> &'static str {
    if Path::new(path).exists() {
        "not a git repository"
    } else {
        "the directory is gone"
    }
}

/// The row's reason is the underlying git text; the path is the row itself.
fn unreadable_reason(error: GroveError) -> String {
    match error {
        GroveError::Git { source, .. } => source.to_string(),
        other => other.to_string(),
    }
}

/// Counts come from one `statuses` pass for the three path counts and from the
/// workdir diff for the line totals, so a partially staged file is not counted twice.
fn summarize_status_counts(statuses: &git2::Statuses<'_>) -> (u32, u32, u32) {
    let staged_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE;
    let unstaged_flags = Status::WT_MODIFIED
        | Status::WT_DELETED
        | Status::WT_RENAMED
        | Status::WT_TYPECHANGE
        | Status::CONFLICTED;

    let (mut staged, mut unstaged, mut untracked) = (0, 0, 0);
    for entry in statuses.iter() {
        let status = entry.status();
        staged += u32::from(status.intersects(staged_flags));
        unstaged += u32::from(status.intersects(unstaged_flags));
        untracked += u32::from(status.contains(Status::WT_NEW));
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
        dirty_age_seconds: None,
        agent: None,
        dirty_since: None,
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
        dirty_age_seconds: None,
        agent: repository.workdir().and_then(agent_marker),
        dirty_since: counts.dirty_since,
    }
}

fn read_branch_info(repository: &Repository) -> BranchInfo {
    let Ok(head) = repository.head() else {
        return BranchInfo {
            name: unborn_branch_name(repository),
            ..detached_branch(None)
        };
    };
    let head_short = head.target().and_then(|oid| abbreviate(repository, oid));
    if !head.is_branch() {
        return detached_branch(head_short);
    }
    let name = head.shorthand().ok().map(str::to_string);
    let (upstream, ahead, behind) = upstream_divergence(repository, name.as_deref());
    BranchInfo {
        name,
        head_short,
        upstream,
        ahead,
        behind,
    }
}

fn detached_branch(head_short: Option<String>) -> BranchInfo {
    BranchInfo {
        name: None,
        head_short,
        upstream: None,
        ahead: 0,
        behind: 0,
    }
}

fn upstream_divergence(
    repository: &Repository,
    branch_name: Option<&str>,
) -> (Option<String>, u32, u32) {
    let upstream = branch_name
        .and_then(|name| repository.find_branch(name, BranchType::Local).ok())
        .and_then(|branch| Some((branch.upstream().ok()?, branch)));
    let Some((upstream, branch)) = upstream else {
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

fn status_counts(repository: &Repository) -> Result<StatusCounts, GroveError> {
    let mut options = status_options();
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|error| GroveError::git("status", error))?;
    let (staged, unstaged, untracked) = summarize_status_counts(&statuses);
    let dirty_since = repository
        .workdir()
        .and_then(|workdir| oldest_changed_mtime(workdir, &statuses));

    let head = head_tree(repository)?;
    let request = DiffRequest {
        view: DiffView::Head,
        ignore_whitespace: false,
        context: DiffContext::Default,
    };
    let diff = view_diff(repository, head.as_ref(), &request, &[])?;
    let (additions, deletions) = summarize_line_counts(&diff);

    Ok(StatusCounts {
        staged,
        unstaged,
        untracked,
        additions,
        deletions,
        dirty_since,
    })
}

fn changed_paths(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    view: DiffView,
) -> Result<HashSet<String>, GroveError> {
    let request = DiffRequest {
        view,
        ignore_whitespace: false,
        context: DiffContext::Default,
    };
    let diff = view_diff(repository, head, &request, &[])?;
    let paths = diff
        .deltas()
        .flat_map(|delta| [delta.old_file().path(), delta.new_file().path()])
        .flatten()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    Ok(paths)
}

fn change_summaries(membership: &Membership, diff: &Diff<'_>) -> Vec<ChangeSummary> {
    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        match change_summary_from_delta(&delta, diff, index, membership) {
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
    membership: &Membership,
) -> Option<ChangeSummary> {
    let status = file_change_status_from_delta(delta)?;
    let path = delta_path(delta)?;
    let old_path = renamed_source(delta, status);
    let old_mode = file_mode(&delta.old_file());
    let new_mode = file_mode(&delta.new_file());
    let facts = delta_patch_facts(delta, diff, index);
    let binary = facts.binary;
    if status == FileChangeStatus::Modified && !binary && old_mode == new_mode && facts.hunks == 0 {
        // Whitespace-insensitive diffs leave such deltas with nothing to show.
        return None;
    }
    let old = old_path.as_deref();
    Some(ChangeSummary {
        staged: path_in_set(&path, old, &membership.staged),
        unstaged: matches!(
            status,
            FileChangeStatus::Untracked | FileChangeStatus::Conflicted
        ) || path_in_set(&path, old, &membership.unstaged),
        binary,
        additions: facts.additions,
        deletions: facts.deletions,
        risk: file_risks(&path, facts.additions, facts.deletions, facts.secret),
        content_hash: facts.content_hash,
        submodule: submodule_pointer(delta),
        old_mode,
        new_mode,
        old_path,
        status,
        path,
    })
}

/// What building a delta's patch reveals. libgit2 sets the binary flag only once
/// it has loaded the content, so `binary` must come from the built patch: the
/// unloaded delta says "not binary" and has no hunks, which reads as empty.
struct PatchFacts {
    binary: bool,
    hunks: usize,
    additions: u32,
    deletions: u32,
    /// An added line matched a credential pattern.
    secret: bool,
    content_hash: String,
}

fn delta_patch_facts(delta: &DiffDelta<'_>, diff: &Diff<'_>, index: usize) -> PatchFacts {
    let unread = PatchFacts {
        binary: delta_is_binary(delta),
        hunks: 0,
        additions: 0,
        deletions: 0,
        secret: false,
        content_hash: blob_id(&delta.new_file()),
    };
    let Ok(Some(patch)) = Patch::from_diff(diff, index) else {
        return unread;
    };
    // Loading the patch hashes a worktree side the delta had no id for yet.
    let content_hash = blob_id(&patch.delta().new_file());
    if delta_is_binary(&patch.delta()) {
        return PatchFacts {
            binary: true,
            content_hash,
            ..unread
        };
    }
    let (additions, deletions) = patch_line_counts(&patch);
    PatchFacts {
        binary: false,
        hunks: patch.num_hunks(),
        additions,
        deletions,
        secret: added_lines_hold_secret(&patch),
        content_hash,
    }
}

fn patch_line_counts(patch: &Patch<'_>) -> (u32, u32) {
    match patch.line_stats() {
        Ok((_, additions, deletions)) => (saturating_u32(additions), saturating_u32(deletions)),
        Err(error) => {
            eprintln!("line counts unavailable: {error}");
            (0, 0)
        }
    }
}

/// The side's blob id, or empty when libgit2 has none (absent, or never loaded).
fn blob_id(file: &DiffFile<'_>) -> String {
    let id = file.id();
    if id.is_zero() {
        String::new()
    } else {
        id.to_string()
    }
}

/// A worktree side libgit2 skipped (above the size cap) is hashed from disk so its
/// review mark still resets when it changes.
fn fill_unread_content_hashes(files: &mut [ChangeSummary], workdir: &Path) {
    let unread = files
        .iter_mut()
        .filter(|file| file.content_hash.is_empty() && file.status != FileChangeStatus::Deleted);
    for file in unread {
        let hashed = Oid::hash_file(ObjectType::Blob, workdir.join(&file.path));
        file.content_hash = hashed.map(|id| id.to_string()).unwrap_or_default();
    }
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
