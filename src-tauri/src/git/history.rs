//! Readers the chat tools and the CLI use beyond the working tree: worktrees,
//! commits, file history, blame, and a text search over changed files. Bounded,
//! read-only, no writes.

use std::path::Path;

use git2::{Blame, Oid, Repository, Tree};
use serde::Serialize;

use super::diff::{blob_bytes, workdir_bytes};
use super::{
    head_tree, open_project, read_project_changes, saturating_u32, short_id, ChangeSummary,
    MAX_TEXT_SIDE_BYTES,
};
use crate::error::GroveError;

/// One entry of `list_worktrees`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub locked: bool,
    pub main: bool,
    /// True when git considers the worktree prunable (its directory is gone or
    /// its metadata is invalid), so stale rows stay visible instead of vanishing.
    pub prunable: bool,
}

/// One entry of `recent_commits` / `file_history`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Unix seconds.
    pub date: i64,
}

/// One line of `blame`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based worktree line number.
    pub line: u32,
    pub commit: String,
    pub short: String,
    pub author: String,
    /// Unix seconds.
    pub date: i64,
}

/// The file as it reads now, each line beside the commit that last touched it.
/// Capped at `MAX_BLAME_LINES` lines from the top.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameView {
    pub lines: Vec<BlameViewLine>,
    /// Every commit a line names, once each, in first-line order.
    pub commits: Vec<CommitInfo>,
    /// The file has more lines than `lines` carries.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameViewLine {
    /// 1-based line of the current text.
    pub line: u32,
    pub text: String,
    /// Full id of the commit that last touched the line; `None` when the line is
    /// not committed yet.
    pub commit: Option<String>,
}

/// One match of `search_changes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeMatch {
    pub project: String,
    pub file: String,
    /// 1-based.
    pub line: u32,
    pub text: String,
}

/// The hard cap on `blame` rows, so one huge answer cannot flood the model.
pub const MAX_BLAME_LINES: usize = 400;

/// The hard cap on commit listings.
pub const MAX_COMMIT_LIMIT: usize = 50;

/// The longest matched line a search row carries, in characters.
const MAX_MATCH_TEXT_CHARS: usize = 400;

/// The main worktree of the repository behind a registered project: the
/// project's own path unless it is a linked worktree, in which case the
/// repository's main worktree path. Grouping key so several registered
/// projects backed by one repository can be deduplicated.
pub fn repository_main_path(project_path: &str) -> Result<String, GroveError> {
    let (path, repository) = open_project(project_path)?;
    let main = match super::main_worktree_path(&repository) {
        Some(main) => main,
        None => workdir(&repository, &path)?.to_string_lossy().into_owned(),
    };
    // `workdir` carries a trailing slash while the canonicalized linked-worktree
    // parent does not; both must produce the same grouping key.
    Ok(main.trim_end_matches('/').to_string())
}

/// The main worktree first, then every linked worktree. Locked and prunable
/// worktrees report it.
pub fn read_worktrees(project_path: &str) -> Result<Vec<WorktreeInfo>, GroveError> {
    let (path, repository) = open_project(project_path)?;
    let mut rows: Vec<WorktreeInfo> = repository
        .workdir()
        .map(|workdir| worktree_info("main", workdir, true))
        .into_iter()
        .collect();
    let names = repository
        .worktrees()
        .map_err(|error| GroveError::git(&path, error))?;
    for name in names.iter().flatten().flatten() {
        rows.push(linked_worktree_info(&repository, name)?);
    }
    Ok(rows)
}

fn linked_worktree_info(repository: &Repository, name: &str) -> Result<WorktreeInfo, GroveError> {
    let worktree = repository
        .find_worktree(name)
        .map_err(|error| GroveError::git(name, error))?;
    let locked = worktree
        .is_locked()
        .is_ok_and(|status| !matches!(status, git2::WorktreeLockStatus::Unlocked));
    // No flags: a valid, present worktree is not prunable; only stale
    // metadata (gone/invalid directories) reports it.
    let mut prune_options = git2::WorktreePruneOptions::new();
    let prunable = worktree
        .is_prunable(Some(&mut prune_options))
        .unwrap_or(false);
    Ok(WorktreeInfo {
        locked,
        prunable,
        ..worktree_info(name, worktree.path(), false)
    })
}

fn worktree_info(name: &str, path: &Path, main: bool) -> WorktreeInfo {
    let head = Repository::open(path)
        .ok()
        .and_then(|repository| worktree_head(&repository));
    let (branch, head_short) = head.unwrap_or_default();
    WorktreeInfo {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        branch,
        head_short,
        locked: false,
        main,
        prunable: false,
    }
}

fn worktree_head(repository: &Repository) -> Option<(Option<String>, Option<String>)> {
    let head = repository.head().ok()?;
    let branch = head.shorthand().ok().map(str::to_string);
    let head_short = head
        .target()
        .and_then(|oid| super::abbreviate(repository, oid));
    Some((branch, head_short))
}

/// Newest first, capped. An unborn branch yields an empty list.
pub fn read_recent_commits(
    project_path: &str,
    limit: usize,
) -> Result<Vec<CommitInfo>, GroveError> {
    let (path, repository) = open_project(project_path)?;
    let Some(walk) = head_walk(&repository, &path)? else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for oid in walk.take(limit.min(MAX_COMMIT_LIMIT)) {
        let (oid, commit) = walked_commit(&repository, oid)?;
        rows.push(commit_info(&repository, oid, &commit));
    }
    Ok(rows)
}

/// Commits that touched one path, newest first, capped.
pub fn read_file_history(
    project_path: &str,
    file_path: &str,
    limit: usize,
) -> Result<Vec<CommitInfo>, GroveError> {
    let (path, repository) = open_project(project_path)?;
    let Some(walk) = head_walk(&repository, &path)? else {
        return Ok(Vec::new());
    };
    let limit = limit.min(MAX_COMMIT_LIMIT);
    let mut rows = Vec::new();
    for oid in walk {
        if rows.len() >= limit {
            break;
        }
        let (oid, commit) = walked_commit(&repository, oid)?;
        if commit_touches_path(&repository, &commit, file_path) {
            rows.push(commit_info(&repository, oid, &commit));
        }
    }
    Ok(rows)
}

/// A time-sorted walk from HEAD, or `None` when HEAD is unborn.
fn head_walk<'repository>(
    repository: &'repository Repository,
    path: &str,
) -> Result<Option<git2::Revwalk<'repository>>, GroveError> {
    let mut walk = repository
        .revwalk()
        .map_err(|error| GroveError::git(path, error))?;
    if walk.push_head().is_err() {
        return Ok(None);
    }
    walk.set_sorting(git2::Sort::TIME)
        .map_err(|error| GroveError::git(path, error))?;
    Ok(Some(walk))
}

fn walked_commit(
    repository: &Repository,
    oid: Result<Oid, git2::Error>,
) -> Result<(Oid, git2::Commit<'_>), GroveError> {
    let oid = oid.map_err(|error| GroveError::git("revwalk", error))?;
    let commit = repository
        .find_commit(oid)
        .map_err(|error| GroveError::git(oid.to_string(), error))?;
    Ok((oid, commit))
}

/// True when the file's blob id at this commit differs from every parent's, so
/// merges that only carry the change forward are skipped.
fn commit_touches_path(
    repository: &Repository,
    commit: &git2::Commit<'_>,
    file_path: &str,
) -> bool {
    let entry_id = |tree: &Tree| -> Option<Oid> {
        tree.get_path(Path::new(file_path))
            .ok()
            .map(|entry| entry.id())
    };
    let Some(here) = commit.tree().ok().and_then(|tree| entry_id(&tree)) else {
        return false;
    };
    let parent_ids: Vec<_> = commit.parent_ids().collect();
    if parent_ids.is_empty() {
        return true;
    }
    !parent_ids.iter().any(|parent| {
        repository
            .find_commit(*parent)
            .ok()
            .and_then(|parent| parent.tree().ok())
            .and_then(|tree| entry_id(&tree))
            .is_some_and(|id| id == here)
    })
}

fn commit_info(repository: &Repository, oid: Oid, commit: &git2::Commit<'_>) -> CommitInfo {
    let subject = commit
        .summary()
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_string();
    CommitInfo {
        id: oid.to_string(),
        short: short_id(repository, oid),
        subject,
        author: commit.author().name().unwrap_or_default().to_string(),
        date: commit.time().seconds(),
    }
}

/// Per-line provenance for one file, 1-based inclusive range, capped at
/// `MAX_BLAME_LINES`.
pub fn read_blame(
    project_path: &str,
    file_path: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<Vec<BlameLine>, GroveError> {
    let (_, repository) = open_project(project_path)?;
    let blame = repository
        .blame_file(Path::new(file_path), None)
        .map_err(|error| GroveError::git(file_path, error))?;

    let start = start_line.unwrap_or(1).max(1);
    let end = end_line.unwrap_or(u32::MAX).max(start);
    let rows = (start..=end)
        .map_while(|line| {
            let hunk = blame.get_line(line as usize)?;
            Some(blame_line(&repository, line, hunk.final_commit_id()))
        })
        .take(MAX_BLAME_LINES)
        .collect();
    Ok(rows)
}

fn blame_line(repository: &Repository, line: u32, commit_id: Oid) -> BlameLine {
    let (author, date) = repository
        .find_commit(commit_id)
        .map(|commit| {
            (
                commit.author().name().unwrap_or_default().to_string(),
                commit.time().seconds(),
            )
        })
        .unwrap_or_default();
    BlameLine {
        line,
        commit: commit_id.to_string(),
        short: short_id(repository, commit_id),
        author,
        date,
    }
}

/// Blame of the file's current text: the worktree copy, or HEAD's when the
/// worktree copy is gone. Lines not committed yet carry no commit. A file with no
/// history (untracked, or a path outside the repository) is a `git` error, raised
/// before anything is read from the worktree.
pub fn read_blame_view(project_path: &str, file_path: &str) -> Result<BlameView, GroveError> {
    let (_, repository) = open_project(project_path)?;
    let committed = repository
        .blame_file(Path::new(file_path), None)
        .map_err(|error| GroveError::git(file_path, error))?;
    let text = current_text(&repository, file_path)?;
    let blame = committed
        .blame_buffer(text.as_bytes())
        .map_err(|error| GroveError::git(file_path, error))?;
    let lines: Vec<BlameViewLine> = text
        .lines()
        .take(MAX_BLAME_LINES)
        .enumerate()
        .map(|(index, line)| blame_view_line(&blame, index + 1, line))
        .collect();
    Ok(BlameView {
        commits: blamed_commits(&repository, &lines),
        truncated: text.lines().nth(MAX_BLAME_LINES).is_some(),
        lines,
    })
}

/// The worktree copy of a file, else HEAD's; capped, and never binary.
fn current_text(repository: &Repository, file_path: &str) -> Result<String, GroveError> {
    let head = head_tree(repository)?;
    let bytes = workdir_bytes(repository, file_path, MAX_TEXT_SIDE_BYTES)
        .or_else(|| blob_bytes(repository, head.as_ref(), file_path, MAX_TEXT_SIDE_BYTES))
        .filter(|bytes| !bytes.iter().take(8000).any(|byte| *byte == 0));
    let unreadable = || {
        let reason = "no text to blame (missing, binary, or over 512 KiB)";
        GroveError::io(file_path, std::io::Error::other(reason))
    };
    let bytes = bytes.ok_or_else(unreadable)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn blame_view_line(blame: &Blame<'_>, line: usize, text: &str) -> BlameViewLine {
    let commit = blame
        .get_line(line)
        .map(|hunk| hunk.final_commit_id())
        .filter(|id| !id.is_zero())
        .map(|id| id.to_string());
    BlameViewLine {
        line: saturating_u32(line),
        text: text.to_string(),
        commit,
    }
}

fn blamed_commits(repository: &Repository, lines: &[BlameViewLine]) -> Vec<CommitInfo> {
    let mut seen = std::collections::HashSet::new();
    lines
        .iter()
        .filter_map(|line| line.commit.as_deref())
        .filter(|id| seen.insert(*id))
        .filter_map(|id| {
            let oid = Oid::from_str(id).ok()?;
            let commit = repository.find_commit(oid).ok()?;
            Some(commit_info(repository, oid, &commit))
        })
        .collect()
}

/// Case-insensitive substring search over the text of every changed (including
/// untracked) file of one project. Returns at most `max_matches` rows.
pub fn search_changed_files(
    project_path: &str,
    query: &str,
    max_matches: usize,
) -> Result<Vec<ChangeMatch>, GroveError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let (path, repository) = open_project(project_path)?;
    let root = workdir(&repository, &path)?;
    let needle = query.to_lowercase();
    let changes = read_project_changes(&path, false)?;
    let mut matches = Vec::new();
    for file in changes.files.iter().filter(|file| !file.binary) {
        let remaining = max_matches.saturating_sub(matches.len());
        if remaining == 0 {
            break;
        }
        matches.extend(search_file(&path, root, file, &needle).take(remaining));
    }
    Ok(matches)
}

/// The matching lines of one changed file. An unreadable, oversized, or non-UTF-8
/// file matches nothing.
fn search_file<'a>(
    project: &'a str,
    root: &Path,
    file: &'a ChangeSummary,
    needle: &'a str,
) -> impl Iterator<Item = ChangeMatch> + 'a {
    let contents = std::fs::read(root.join(&file.path))
        .ok()
        .filter(|bytes| bytes.len() as u64 <= MAX_TEXT_SIDE_BYTES)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default();
    let lines: Vec<(usize, String)> = contents
        .lines()
        .enumerate()
        .filter(|(_, text)| text.to_lowercase().contains(needle))
        .map(|(offset, text)| (offset, text.chars().take(MAX_MATCH_TEXT_CHARS).collect()))
        .collect();
    lines.into_iter().map(move |(offset, text)| ChangeMatch {
        project: project.to_string(),
        file: file.path.clone(),
        line: saturating_u32(offset + 1),
        text,
    })
}

fn workdir<'repository>(
    repository: &'repository Repository,
    path: &str,
) -> Result<&'repository Path, GroveError> {
    repository
        .workdir()
        .ok_or_else(|| GroveError::NotARepository {
            path: format!("{path} (bare repository has no worktree)"),
        })
}
