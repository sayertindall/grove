//! One file, one view: the unified patch, the same patch as structured hunks, and
//! the two content sides. Patch text and hunks come from one libgit2 `Patch`. A
//! conflicted file also carries its three index stages; a submodule only its two
//! commit ids.

use std::path::Path;

use base64::Engine as _;
use git2::{
    merge_file, Diff, DiffDelta, MergeFileInput, MergeFileOptions, Oid, Patch, Repository, Tree,
};
use serde::Serialize;

use super::{
    delta_is_binary, delta_is_gitlink, delta_path, file_change_status_from_delta, file_mode,
    head_tree, open_project, renamed_source, status_options, submodule_pointer, view_diff,
    ChangeSummary, DiffContext, DiffRequest, DiffView, FileChangeStatus, SubmodulePointer,
    MAX_IMAGE_SIDE_BYTES, MAX_TEXT_SIDE_BYTES,
};
use crate::error::GroveError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
    pub old_data_url: Option<String>,
    pub new_data_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Add,
    Del,
}

/// One line of a hunk. `text` is the line without its trailing newline; a missing
/// final newline is visible only in `FileDiff.patch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// 1-based line in the old side; absent on an added line.
    pub old_no: Option<u32>,
    /// 1-based line in the new side; absent on a deleted line.
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// The `@@ -a,b +c,d @@ context` line, without its newline.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
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
    /// Empty for binary and mode-only changes.
    pub hunks: Vec<DiffHunk>,
    pub old_contents: Option<String>,
    pub new_contents: Option<String>,
    pub old_mode: Option<u32>,
    pub new_mode: Option<u32>,
    pub image: Option<ImagePreview>,
    /// The three index stages of a conflicted file; `None` for every other status.
    pub conflict: Option<ConflictSides>,
    /// The recorded commits of a submodule; its contents are never read.
    pub submodule: Option<SubmodulePointer>,
}

/// A conflicted file's index stages: 1 (merge base), 2 (ours), 3 (theirs). A side is
/// `None` when its stage is absent (add/add, modify/delete), binary, or above the
/// text cap. `merged` is the three-way merge of the stages with diff3 markers,
/// computed in memory, present only when every existing stage was read as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSides {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub merged: Option<String>,
}

enum SideSource {
    Absent,
    Head,
    Index,
    Worktree,
}

/// One content side: where it is read from and under which path.
struct Side {
    source: SideSource,
    path: String,
}

/// One file, one view. The two content sides are the sides of that view.
///
/// `known_changes` is the project's current change list; its rename pairs widen
/// the pathspec so rename detection sees both sides. Without it the pairs come
/// from a `statuses` scan, which the GUI avoids by passing its cached list.
pub fn read_file_diff(
    project_path: &str,
    file_path: &str,
    view: DiffView,
    ignore_whitespace: bool,
    context: DiffContext,
    known_changes: Option<&[ChangeSummary]>,
) -> Result<FileDiff, GroveError> {
    let (_, repository) = open_project(project_path)?;
    let head = head_tree(&repository)?;
    let pathspec = match known_changes {
        Some(changes) => rename_partners(changes, file_path),
        None => scanned_rename_partners(&repository, file_path),
    };
    let request = DiffRequest {
        view,
        ignore_whitespace,
        context,
    };
    let diff = view_diff(&repository, head.as_ref(), &request, &pathspec)?;
    let no_change = || GroveError::NoChange {
        path: file_path.to_string(),
        view: view.to_string(),
    };
    let index = find_delta(&diff, file_path).ok_or_else(no_change)?;
    file_diff_at(&repository, head.as_ref(), &diff, index, view).ok_or_else(no_change)
}

/// The file plus whichever side of a known rename pairs with it.
fn rename_partners(changes: &[ChangeSummary], file_path: &str) -> Vec<String> {
    let mut paths = vec![file_path.to_string()];
    for change in changes {
        let Some(old_path) = change.old_path.as_deref() else {
            continue;
        };
        if change.path == file_path {
            paths.push(old_path.to_string());
        } else if old_path == file_path {
            paths.push(change.path.clone());
        }
    }
    paths
}

/// Paths the single-file diff must include so rename detection can see both
/// sides, from a full `statuses` pass. Only callers without a change list use it.
fn scanned_rename_partners(repository: &Repository, file_path: &str) -> Vec<String> {
    let mut paths = vec![file_path.to_string()];
    let mut options = status_options();
    let Ok(statuses) = repository.statuses(Some(&mut options)) else {
        return paths;
    };
    for entry in statuses.iter() {
        let sides = status_entry_sides(&entry);
        if sides.iter().any(|side| side == file_path) {
            paths.extend(sides);
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// Every path one status entry names: its own and both sides of both deltas.
fn status_entry_sides(entry: &git2::StatusEntry<'_>) -> Vec<String> {
    let deltas = [entry.head_to_index(), entry.index_to_workdir()];
    let sides = deltas
        .into_iter()
        .flatten()
        .flat_map(|delta| [delta.old_file().path(), delta.new_file().path()])
        .flatten()
        .map(|path| path.to_string_lossy().into_owned());
    entry
        .path()
        .ok()
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .into_iter()
        .chain(sides)
        .collect()
}

fn find_delta(diff: &Diff<'_>, file_path: &str) -> Option<usize> {
    diff.deltas().position(|delta| {
        delta_path(&delta).as_deref() == Some(file_path)
            || delta
                .old_file()
                .path()
                .is_some_and(|path| path.to_string_lossy() == file_path)
    })
}

fn file_diff_at(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    diff: &Diff<'_>,
    index: usize,
    view: DiffView,
) -> Option<FileDiff> {
    let delta = diff.get_delta(index)?;
    let status = file_change_status_from_delta(&delta)?;
    let path = delta_path(&delta)?;
    let old_path = renamed_source(&delta, status);
    let payload = patch_payload(diff, index, delta_is_binary(&delta));
    let binary = payload.binary;
    let (old_side, new_side) = view_sides(&delta, view, old_path.as_deref(), &path);
    let contents = content_sides(repository, head, &old_side, &new_side, binary);
    Some(FileDiff {
        old_contents: contents.old_contents,
        new_contents: contents.new_contents,
        image: contents.image,
        old_mode: file_mode(&delta.old_file()),
        new_mode: file_mode(&delta.new_file()),
        conflict: conflict_sides(repository, &path, status),
        submodule: submodule_pointer(&delta),
        path,
        old_path,
        status,
        view,
        binary,
        patch: payload.text,
        hunks: payload.hunks,
    })
}

/// The text or image sides of one file diff.
struct ContentSides {
    old_contents: Option<String>,
    new_contents: Option<String>,
    image: Option<ImagePreview>,
}

fn content_sides(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    old_side: &Side,
    new_side: &Side,
    binary: bool,
) -> ContentSides {
    let old_bytes = read_side(repository, head, old_side);
    let new_bytes = read_side(repository, head, new_side);
    let image = image_preview(
        old_side,
        old_bytes.as_deref(),
        new_side,
        new_bytes.as_deref(),
    );
    // An image renders from its preview; its bytes are not a text diff.
    let text = |bytes: Option<&[u8]>| image.is_none().then(|| text_side(bytes, binary)).flatten();
    ContentSides {
        old_contents: text(old_bytes.as_deref()),
        new_contents: text(new_bytes.as_deref()),
        image,
    }
}

/// Reads stages 1–3 of a conflicted path, each capped before it is loaded, and
/// merges them in memory. Nothing is written to the index or the worktree.
fn conflict_sides(
    repository: &Repository,
    path: &str,
    status: FileChangeStatus,
) -> Option<ConflictSides> {
    if status != FileChangeStatus::Conflicted {
        return None;
    }
    let index = repository.index().ok()?;
    let stage_ids = [1, 2, 3].map(|stage| index.get_path(Path::new(path), stage).map(|e| e.id));
    let texts = stage_ids.map(|id| id.and_then(|id| capped_text_blob(repository, id)));
    let complete = stage_ids
        .iter()
        .zip(&texts)
        .all(|(id, text)| id.is_some() == text.is_some());
    let merged = complete.then(|| merged_conflict_text(&texts)).flatten();
    let [base, ours, theirs] = texts;
    Some(ConflictSides {
        base,
        ours,
        theirs,
        merged,
    })
}

/// A text blob no larger than the text cap, checked from the object header before
/// the content is loaded. Binary content (a NUL in the first 8000 bytes, Git's own
/// heuristic) is not text.
fn capped_text_blob(repository: &Repository, id: Oid) -> Option<String> {
    let (size, _) = repository.odb().ok()?.read_header(id).ok()?;
    if size as u64 > MAX_TEXT_SIDE_BYTES {
        return None;
    }
    let blob = repository.find_blob(id).ok()?;
    let bytes = blob.content();
    let binary = bytes.iter().take(8000).any(|byte| *byte == 0);
    (!binary).then(|| String::from_utf8_lossy(bytes).into_owned())
}

/// The diff3-style merge of base, ours, and theirs; an absent stage merges as empty.
fn merged_conflict_text(texts: &[Option<String>; 3]) -> Option<String> {
    let inputs = texts.each_ref().map(|text| {
        let mut input = MergeFileInput::new();
        input.content(text.as_deref().unwrap_or_default().as_bytes());
        input
    });
    let mut options = MergeFileOptions::new();
    options
        .ancestor_label("base")
        .our_label("ours")
        .their_label("theirs")
        .style_diff3(true);
    let [base, ours, theirs] = &inputs;
    let result = merge_file(base, ours, theirs, Some(&mut options)).ok()?;
    Some(String::from_utf8_lossy(result.content()).into_owned())
}

/// The old and new side of a view. A side the delta does not have (an add's old
/// side, a delete's new side) is absent rather than read.
fn view_sides(
    delta: &DiffDelta<'_>,
    view: DiffView,
    old_path: Option<&str>,
    path: &str,
) -> (Side, Side) {
    let (old_source, new_source) = match view {
        DiffView::Head => (SideSource::Head, SideSource::Worktree),
        DiffView::Staged => (SideSource::Head, SideSource::Index),
        DiffView::Unstaged => (SideSource::Index, SideSource::Worktree),
    };
    // A submodule's sides are commits in another repository: never read.
    let gitlink = delta_is_gitlink(delta);
    let present = |exists: bool, source: SideSource| {
        if exists && !gitlink {
            source
        } else {
            SideSource::Absent
        }
    };
    let old = Side {
        source: present(delta.old_file().exists(), old_source),
        path: old_path.unwrap_or(path).to_string(),
    };
    let new = Side {
        source: present(delta.new_file().exists(), new_source),
        path: path.to_string(),
    };
    (old, new)
}

/// The unified patch text, its structured hunks, and whether libgit2 found the
/// content binary, all from one patch build. The binary flag is only reliable
/// after the build: an unloaded delta does not know yet.
struct PatchPayload {
    text: String,
    hunks: Vec<DiffHunk>,
    binary: bool,
}

fn patch_payload(diff: &Diff<'_>, index: usize, delta_binary: bool) -> PatchPayload {
    let built = Patch::from_diff(diff, index).ok().flatten();
    let binary = built
        .as_ref()
        .map_or(delta_binary, |patch| delta_is_binary(&patch.delta()));
    let Some(mut patch) = built.filter(|_| !binary) else {
        return PatchPayload {
            text: if binary { "Binary files differ\n" } else { "" }.to_string(),
            hunks: Vec::new(),
            binary,
        };
    };
    let hunks = (0..patch.num_hunks())
        .filter_map(|hunk| patch_hunk(&patch, hunk))
        .collect();
    let text = match patch.to_buf() {
        Ok(buffer) => String::from_utf8_lossy(&buffer).into_owned(),
        Err(error) => {
            eprintln!("patch text unavailable: {error}");
            String::new()
        }
    };
    PatchPayload {
        text,
        hunks,
        binary: false,
    }
}

fn patch_hunk(patch: &Patch<'_>, hunk_index: usize) -> Option<DiffHunk> {
    let (hunk, line_count) = patch.hunk(hunk_index).ok()?;
    let lines = (0..line_count)
        .filter_map(|line| patch.line_in_hunk(hunk_index, line).ok())
        .filter_map(|line| hunk_line(&line))
        .collect();
    Some(DiffHunk {
        header: line_text(hunk.header()),
        old_start: hunk.old_start(),
        old_lines: hunk.old_lines(),
        new_start: hunk.new_start(),
        new_lines: hunk.new_lines(),
        lines,
    })
}

/// Content lines only: the end-of-file newline markers (`=`, `>`, `<`) are dropped.
fn hunk_line(line: &git2::DiffLine<'_>) -> Option<DiffLine> {
    let kind = match line.origin() {
        ' ' => DiffLineKind::Context,
        '+' => DiffLineKind::Add,
        '-' => DiffLineKind::Del,
        _ => return None,
    };
    Some(DiffLine {
        kind,
        old_no: line.old_lineno(),
        new_no: line.new_lineno(),
        text: line_text(line.content()),
    })
}

fn line_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn text_side(bytes: Option<&[u8]>, binary: bool) -> Option<String> {
    let bytes = bytes?;
    if binary || bytes.len() as u64 > MAX_TEXT_SIDE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn read_side(repository: &Repository, head: Option<&Tree<'_>>, side: &Side) -> Option<Vec<u8>> {
    let limit = read_limit(&side.path);
    let path = side.path.as_str();
    match side.source {
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

pub(super) fn blob_bytes(
    repository: &Repository,
    head: Option<&Tree<'_>>,
    path: &str,
    limit: u64,
) -> Option<Vec<u8>> {
    let entry = head?.get_path(Path::new(path)).ok()?;
    let blob = entry.to_object(repository).ok()?.into_blob().ok()?;
    // The size check comes before `content()` is copied.
    (blob.size() as u64 <= limit).then(|| blob.content().to_vec())
}

fn index_bytes(repository: &Repository, path: &str, limit: u64) -> Option<Vec<u8>> {
    let index = repository.index().ok()?;
    let entry = index.get_path(Path::new(path), 0)?;
    let blob = repository.find_blob(entry.id).ok()?;
    (blob.size() as u64 <= limit).then(|| blob.content().to_vec())
}

pub(super) fn workdir_bytes(repository: &Repository, path: &str, limit: u64) -> Option<Vec<u8>> {
    let full = repository.workdir()?.join(path);
    let metadata = std::fs::metadata(&full).ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    std::fs::read(&full).ok()
}

fn image_preview(
    old_side: &Side,
    old_bytes: Option<&[u8]>,
    new_side: &Side,
    new_bytes: Option<&[u8]>,
) -> Option<ImagePreview> {
    let old_mime = image_mime(&old_side.path);
    let new_mime = image_mime(&new_side.path);
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
