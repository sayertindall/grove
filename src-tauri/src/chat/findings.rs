//! Review findings the model reports in a fenced ```findings JSON block. Each
//! one must land inside a changed hunk (new-side line numbers) of the file it
//! names, or it is dropped and counted: a finding is only drawn in the gutter
//! when the diff actually has those lines.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::registered_path;
use crate::git::{read_file_diff, DiffContext, DiffView};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FindingSeverity {
    P0,
    P1,
    P2,
}

/// One validated finding, anchored to new-side lines of a changed hunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFinding {
    pub project_path: String,
    /// Repository-relative.
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub severity: FindingSeverity,
    pub title: String,
    #[serde(default)]
    pub detail: String,
}

/// The shape the model is asked to emit; `project` is optional and defaults to
/// the project in view.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedFinding {
    #[serde(default)]
    project: Option<String>,
    path: String,
    start_line: u32,
    #[serde(default)]
    end_line: Option<u32>,
    severity: FindingSeverity,
    title: String,
    #[serde(default)]
    detail: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidatedFindings {
    pub kept: Vec<ChatFinding>,
    pub dropped: u32,
}

/// Parses every ```findings block in `answer` and keeps the entries that fall
/// inside a hunk. Unparseable entries count as dropped.
pub fn validate_findings(
    answer: &str,
    projects: &[String],
    ambient_project: Option<&str>,
) -> ValidatedFindings {
    let mut result = ValidatedFindings::default();
    let mut hunks = HunkRanges::default();
    for entry in fenced_blocks(answer, "findings")
        .iter()
        .flat_map(|block| entries(block))
    {
        let anchored = serde_json::from_value::<ProposedFinding>(entry)
            .ok()
            .and_then(|proposed| anchor(proposed, projects, ambient_project, &mut hunks));
        match anchored {
            Some(finding) => result.kept.push(finding),
            None => result.dropped += 1,
        }
    }
    result
}

/// A block's JSON array entries; a block that is not an array is one bad entry.
fn entries(block: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(block) {
        Ok(Value::Array(items)) => items,
        Ok(other) => vec![other],
        Err(_) => vec![Value::Null],
    }
}

fn anchor(
    proposed: ProposedFinding,
    projects: &[String],
    ambient_project: Option<&str>,
    hunks: &mut HunkRanges,
) -> Option<ChatFinding> {
    let candidate = proposed.project.as_deref().or(ambient_project)?;
    let project = registered_path(projects, candidate).ok()?.project;
    let end_line = proposed
        .end_line
        .unwrap_or(proposed.start_line)
        .max(proposed.start_line);
    let inside = hunks
        .of(&project, &proposed.path)
        .iter()
        .any(|&(start, end)| proposed.start_line >= start && end_line <= end);
    inside.then_some(ChatFinding {
        project_path: project,
        path: proposed.path,
        start_line: proposed.start_line,
        end_line,
        severity: proposed.severity,
        title: proposed.title,
        detail: proposed.detail,
    })
}

/// New-side line ranges of each file's hunks, read once per file.
#[derive(Default)]
struct HunkRanges {
    files: HashMap<(String, String), Vec<(u32, u32)>>,
}

impl HunkRanges {
    fn of(&mut self, project: &str, path: &str) -> &[(u32, u32)] {
        self.files
            .entry((project.to_string(), path.to_string()))
            .or_insert_with(|| read_ranges(project, path))
    }
}

fn read_ranges(project: &str, path: &str) -> Vec<(u32, u32)> {
    let Ok(diff) = read_file_diff(
        project,
        path,
        DiffView::Head,
        false,
        DiffContext::Default,
        None,
    ) else {
        return Vec::new();
    };
    diff.hunks
        .iter()
        .map(|hunk| {
            let end = hunk.new_start + hunk.new_lines.saturating_sub(1);
            (hunk.new_start, end.max(hunk.new_start))
        })
        .collect()
}

/// The bodies of every fenced block whose info string starts with `language`.
pub fn fenced_blocks(text: &str, language: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("```") {
        let after = &rest[open + 3..];
        let Some(newline) = after.find('\n') else {
            break;
        };
        let body = &after[newline + 1..];
        let close = body.find("```").unwrap_or(body.len());
        if after[..newline].split_whitespace().next() == Some(language) {
            blocks.push(body[..close].to_string());
        }
        rest = body.get(close + 3..).unwrap_or("");
    }
    blocks
}
