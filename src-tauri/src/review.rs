//! Local review state: which file contents the user has marked viewed. A mark is
//! the file's worktree blob id at the time; the file reads as viewed only while
//! its current `ChangeSummary::content_hash` still equals it, so any edit resets
//! it without Grove having to notice the edit. Stored as `review-state.json` in
//! the app-data directory, next to the chat files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::GroveError;

pub const REVIEW_STATE_FILE: &str = "review-state.json";

/// One stored mark.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMark {
    pub project_path: String,
    pub file_path: String,
    pub content_hash: String,
}

/// A mark as one project's reader sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedFile {
    pub file_path: String,
    pub content_hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReviewStateFile {
    #[serde(default)]
    reviewed: Vec<ReviewMark>,
}

/// Serializes read-modify-write cycles within the process.
static REVIEW_STATE_LOCK: Mutex<()> = Mutex::new(());

/// `review-state.json` in the app-data directory (`GROVE_DATA_DIR` when set).
pub fn review_state_path() -> Result<PathBuf, GroveError> {
    crate::chat::data_dir()
        .map(|dir| dir.join(REVIEW_STATE_FILE))
        .map_err(GroveError::store)
}

/// Every mark stored for one canonical project path, in the order they were set.
pub fn list_reviewed(store: &Path, project_path: &str) -> Result<Vec<ReviewedFile>, GroveError> {
    let state = read_review_state(store)?;
    Ok(state
        .reviewed
        .into_iter()
        .filter(|mark| mark.project_path == project_path)
        .map(|mark| ReviewedFile {
            file_path: mark.file_path,
            content_hash: mark.content_hash,
        })
        .collect())
}

/// Stores (`reviewed`) or drops the mark of one file. Setting replaces any earlier
/// mark of the same file, so there is at most one per file.
pub fn set_reviewed(store: &Path, mark: ReviewMark, reviewed: bool) -> Result<(), GroveError> {
    let _guard = REVIEW_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = read_review_state(store)?;
    state.reviewed.retain(|stored| {
        stored.project_path != mark.project_path || stored.file_path != mark.file_path
    });
    if reviewed {
        state.reviewed.push(mark);
    }
    write_review_state(store, &state)
}

/// A missing file is an empty state; an unparsable one is an error rather than a
/// silent reset of every mark.
fn read_review_state(store: &Path) -> Result<ReviewStateFile, GroveError> {
    let text = match std::fs::read_to_string(store) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(GroveError::io(store.display().to_string(), error)),
    };
    serde_json::from_str(&text)
        .map_err(|error| GroveError::store(format!("{}: {error}", store.display())))
}

/// Writes beside the target, then renames, so a crash never leaves half a file.
fn write_review_state(store: &Path, state: &ReviewStateFile) -> Result<(), GroveError> {
    let io_error = |error| GroveError::io(store.display().to_string(), error);
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| GroveError::store(format!("{}: {error}", store.display())))?;
    let staging = store.with_extension("json.tmp");
    std::fs::write(&staging, text).map_err(io_error)?;
    std::fs::rename(&staging, store).map_err(io_error)
}
