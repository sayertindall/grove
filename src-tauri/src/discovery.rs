use std::path::Path;

use crate::error::GroveError;

/// Depth of the directory the user picked. The walk visits depths 0 through
/// `REPOSITORY_SCAN_MAX_DEPTH` inclusive, so a repository sitting at the limit is
/// listed while its children are never entered.
pub const REPOSITORY_SCAN_MAX_DEPTH: u32 = 6;

/// Directories that hold dependencies or build output rather than the user's own
/// repositories. They are never entered, so a vendored package with its own `.git`
/// is not offered as a project.
const SKIPPED_DIRECTORY_NAMES: [&str; 8] = [
    ".git",
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
];

/// A directory holds git metadata when it contains a `.git` directory (a normal
/// repository) or a `.git` file (a linked worktree or submodule).
pub fn directory_holds_git_metadata(directory: &Path) -> bool {
    directory.join(".git").exists()
}

fn is_skipped_directory_name(name: &std::ffi::OsStr) -> bool {
    SKIPPED_DIRECTORY_NAMES
        .iter()
        .any(|skipped| name == *skipped)
}

/// Returns the canonical absolute paths of every directory at or below `root`
/// that directly contains git metadata, sorted lexicographically.
pub fn find_repositories(root: &Path, max_depth: u32) -> Result<Vec<String>, GroveError> {
    let display = root.display().to_string();
    let metadata = std::fs::metadata(root).map_err(|error| GroveError::io(&display, error))?;
    if !metadata.is_dir() {
        return Err(GroveError::usage(format!("{display}: not a directory")));
    }

    let mut found = Vec::new();
    visit_repository_candidate(root, 0, max_depth, &mut found);
    found.sort();
    Ok(found)
}

/// Walks one directory: list it when it is a repository, then descend either way, so
/// independent repositories nested inside an umbrella repository are found too.
pub fn visit_repository_candidate(
    directory: &Path,
    depth: u32,
    max_depth: u32,
    found: &mut Vec<String>,
) {
    if directory_holds_git_metadata(directory) {
        found.push(canonical_string(directory));
    }

    if depth >= max_depth {
        return;
    }

    let Ok(entries) = std::fs::read_dir(directory) else {
        eprintln!("{}: unreadable directory, skipping", directory.display());
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().is_some_and(is_skipped_directory_name) {
            continue;
        }
        // DirEntry::file_type does not follow symlinks, so a symlinked directory
        // is skipped instead of being walked.
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            visit_repository_candidate(&path, depth + 1, max_depth, found);
        }
    }
}

fn canonical_string(path: &Path) -> String {
    match std::fs::canonicalize(path) {
        Ok(canonical) => canonical.to_string_lossy().into_owned(),
        Err(error) => {
            eprintln!("{}: {error}", path.display());
            path.to_string_lossy().into_owned()
        }
    }
}
