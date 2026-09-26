//! What travels with a turn besides the question: the repository's own review
//! guidance (rule files) and, for quick actions and delegated CLIs, a snapshot
//! of the diffs in view so the model does not need tools to read them.

use std::io::Read;
use std::path::Path;

use crate::chat::{ChatContext, QuickAction};
use crate::git::{read_file_diff, read_project_changes, DiffContext, DiffView};

/// Rule files read from the project in view, in prompt order.
pub const RULE_FILES: [&str; 4] = [
    "AGENTS.md",
    "CLAUDE.md",
    ".github/copilot-instructions.md",
    ".cursor/BUGBOT.md",
];
/// All rule files together stay under this many bytes.
pub const RULE_FILES_BYTES: usize = 16 * 1024;
/// The snapshot a quick action attaches for an API provider.
pub const ACTION_SNAPSHOT_BYTES: usize = 64 * 1024;
/// The snapshot a delegated CLI gets instead of Grove's tools.
pub const CLI_SNAPSHOT_BYTES: usize = 200 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleFile {
    pub name: String,
    pub text: String,
}

/// Reads the rule files that exist, in order, until the byte budget is spent;
/// the file that crosses it is cut on a character boundary.
pub fn read_rule_files(project: &str) -> Vec<RuleFile> {
    let mut remaining = RULE_FILES_BYTES;
    let mut found = Vec::new();
    for name in RULE_FILES {
        let Some(text) = read_bounded(&Path::new(project).join(name), remaining) else {
            continue;
        };
        remaining -= text.len();
        found.push(RuleFile {
            name: name.to_string(),
            text,
        });
    }
    found
}

/// A regular file's text, at most `limit` bytes; symlinks and non-files are
/// skipped so a rule file cannot pull in something outside the repository.
fn read_bounded(path: &Path, limit: usize) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || limit == 0 {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(truncate_to(text, limit)).filter(|text| !text.trim().is_empty())
}

fn truncate_to(mut text: String, limit: usize) -> String {
    let mut cut = limit.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text
}

/// The diffs in view, as text: what a delegated CLI reads instead of calling
/// tools, and what a quick action pins its answer (and cache key) to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbientSnapshot {
    pub label: String,
    pub text: String,
}

/// Builds the snapshot for `project`: the named files, else the file in view,
/// else every changed file of the project, until `cap` bytes.
pub fn ambient_snapshot(
    project: &str,
    context: &ChatContext,
    cap: usize,
) -> Option<AmbientSnapshot> {
    let (files, listing) = snapshot_files(project, context);
    if files.is_empty() && listing.is_empty() {
        return None;
    }
    let mut text = listing;
    let mut included = 0usize;
    for section in files.iter().filter_map(|file| file_section(project, file)) {
        if text.len() + section.len() > cap {
            let left = files.len() - included;
            text.push_str(&format!(
                "\n({left} more file(s) left out at the {cap}-byte cap.)\n"
            ));
            break;
        }
        text.push_str(&section);
        included += 1;
    }
    Some(AmbientSnapshot {
        label: snapshot_label(project, context, included),
        text,
    })
}

/// One file's patch as a fenced diff section; unreadable files are skipped.
fn file_section(project: &str, file: &str) -> Option<String> {
    let diff = read_file_diff(
        project,
        file,
        DiffView::Head,
        false,
        DiffContext::Default,
        None,
    )
    .ok()?;
    Some(format!(
        "### {file}\n```diff\n{}\n```\n",
        diff.patch.trim_end()
    ))
}

/// Which files to read, plus a change listing when the whole project is in scope.
fn snapshot_files(project: &str, context: &ChatContext) -> (Vec<String>, String) {
    if !context.files.is_empty() {
        return (context.files.clone(), String::new());
    }
    if let Some(file) = &context.file_path {
        return (vec![file.clone()], String::new());
    }
    let Ok(changes) = read_project_changes(project, false) else {
        return (Vec::new(), String::new());
    };
    let listing: String = changes
        .files
        .iter()
        .map(|change| {
            let status = format!("{:?}", change.status).to_lowercase();
            format!(
                "- {status} {} (+{}/-{})\n",
                change.path, change.additions, change.deletions
            )
        })
        .collect();
    let files = changes
        .files
        .into_iter()
        .map(|change| change.path)
        .collect();
    (files, format!("Changed files:\n{listing}\n"))
}

fn snapshot_label(project: &str, context: &ChatContext, included: usize) -> String {
    let name = Path::new(project)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| project.to_string());
    match (&context.file_path, context.files.is_empty()) {
        (Some(file), true) => format!("{name} · {file}"),
        _ => format!("{name} · {included} file diff(s)"),
    }
}

/// Whether a turn carries a snapshot, and how large it may be.
pub fn snapshot_cap(action: Option<QuickAction>, delegated: bool) -> Option<usize> {
    match (delegated, action) {
        (true, _) => Some(CLI_SNAPSHOT_BYTES),
        (false, Some(_)) => Some(ACTION_SNAPSHOT_BYTES),
        (false, None) => None,
    }
}
