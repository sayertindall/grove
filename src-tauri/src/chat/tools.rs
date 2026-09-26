//! The nine read-only tools the model can call. Every payload is bounded and
//! every path argument is validated against the registered project list with the
//! same component-boundary check the UI guards use.

use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::chat::ChatCitation;
use crate::config::{path_is_inside_project, registered_path};
use crate::git::{
    read_blame, read_file_diff, read_file_history, read_project_changes, read_project_status,
    read_recent_commits, read_worktrees, search_changed_files, DiffContext, DiffView,
    MAX_BLAME_LINES, MAX_COMMIT_LIMIT,
};

/// The bound for `read_file` payloads; diffs reuse `MAX_TEXT_SIDE_BYTES`.
const MAX_READ_FILE_BYTES: u64 = 512 * 1024;
/// The hard cap on `search_changes` rows.
const MAX_SEARCH_MATCHES: usize = 50;

/// Anything a tool needs from the app: the registered project list.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub projects: Vec<String>,
}

/// A tool call the model made, already complete.
#[derive(Debug, Clone)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    /// Raw JSON argument text (may be empty).
    pub arguments: String,
}

/// What running one tool produced.
pub struct ToolOutcome {
    /// Text sent back to the model (a bounded JSON payload).
    pub content: String,
    /// Citations derived deterministically from what the tool read.
    pub sources: Vec<ChatCitation>,
}

/// The OpenAI/Anthropic tool declarations: name, description, JSON schema.
pub fn tool_specs() -> Vec<(String, String, Value)> {
    fn schema(properties: Value, required: &[&str]) -> Value {
        let mut schema = json!({
            "type": "object",
            "properties": properties,
            "additionalProperties": false,
        });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    }

    vec![
        (
            "list_projects".into(),
            "List every registered project in the workspace with its state, branch, \
             upstream, ahead/behind counts, and change counts."
                .into(),
            schema(json!({}), &[]),
        ),
        (
            "list_changes".into(),
            "List the changed files of one project: status, staged/unstaged, binary, \
             additions/deletions, and rename source."
                .into(),
            schema(
                json!({"project": {"type": "string", "description": "absolute project path"}}),
                &["project"],
            ),
        ),
        (
            "read_diff".into(),
            "Read the patch of one file: which view (head, staged, or unstaged), both text \
             sides when small, and binary/truncated flags."
                .into(),
            schema(
                json!({
                    "project": {"type": "string"},
                    "file": {"type": "string", "description": "path relative to the project"},
                    "view": {"type": "string", "enum": ["head", "staged", "unstaged"]},
                }),
                &["project", "file"],
            ),
        ),
        (
            "read_file".into(),
            "Read the current worktree contents of one file, bounded and reported as \
             truncated when cut off."
                .into(),
            schema(
                json!({
                    "project": {"type": "string"},
                    "file": {"type": "string"},
                }),
                &["project", "file"],
            ),
        ),
        (
            "search_changes".into(),
            "Case-insensitive substring search over the changed (including untracked) files \
             of one project, or of every project when none is given. Returns file:line matches."
                .into(),
            schema(
                json!({
                    "query": {"type": "string"},
                    "project": {"type": "string"},
                }),
                &["query"],
            ),
        ),
        (
            "list_worktrees".into(),
            "List the git worktrees of one project, including the main worktree.".into(),
            schema(json!({"project": {"type": "string"}}), &["project"]),
        ),
        (
            "recent_commits".into(),
            "List the most recent commits of one project, newest first (default 20, max 50)."
                .into(),
            schema(
                json!({
                    "project": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                }),
                &["project"],
            ),
        ),
        (
            "file_history".into(),
            "List the commits that touched one file, newest first (default 20, max 50).".into(),
            schema(
                json!({
                    "project": {"type": "string"},
                    "file": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                }),
                &["project", "file"],
            ),
        ),
        (
            "blame".into(),
            "Get the commit, author, and date for each line of one file (default the whole \
             file, capped at 400 lines)."
                .into(),
            schema(
                json!({
                    "project": {"type": "string"},
                    "file": {"type": "string"},
                    "startLine": {"type": "integer", "minimum": 1},
                    "endLine": {"type": "integer", "minimum": 1},
                }),
                &["project", "file"],
            ),
        ),
    ]
}

/// One tool's parsed arguments. Unknown fields are ignored; malformed JSON is a
/// readable error, never a guess.
#[derive(Deserialize, Default)]
#[serde(default)]
struct ToolArgs {
    project: Option<String>,
    file: Option<String>,
    view: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
    #[serde(rename = "startLine")]
    start_line: Option<u32>,
    #[serde(rename = "endLine")]
    end_line: Option<u32>,
}

fn parse_args(call: &ToolCallRequest) -> Result<ToolArgs, String> {
    if call.arguments.trim().is_empty() {
        return Ok(ToolArgs::default());
    }
    serde_json::from_str(&call.arguments)
        .map_err(|error| format!("{}: invalid arguments: {error}", call.name))
}

/// The diff view the model asked for; absent means `head`. An unrecognized value
/// is rejected, not silently read as `head`.
fn parse_view(view: Option<&str>) -> Result<DiffView, String> {
    view.map_or(Ok(DiffView::Head), str::parse)
        .map_err(|error: crate::error::GroveError| format!("read_diff: {error}"))
}

/// Runs one tool call. Every failure is a readable string, never a panic.
pub fn run_tool(context: &ToolContext, call: &ToolCallRequest) -> Result<ToolOutcome, String> {
    let args = parse_args(call)?;
    match call.name.as_str() {
        "list_projects" => list_projects(context),
        "list_changes" => list_changes(context, &args),
        "read_diff" => read_diff(context, &args),
        "read_file" => read_file(context, &args),
        "search_changes" => search_changes(context, &args),
        "list_worktrees" => list_worktrees(context, &args),
        "recent_commits" => recent_commits(context, &args),
        "file_history" => file_history(context, &args),
        "blame" => blame(context, &args),
        other => Err(format!(
            "{other}: unknown tool; the available tools are listed in the system prompt"
        )),
    }
}

fn list_projects(context: &ToolContext) -> Result<ToolOutcome, String> {
    let rows: Vec<Value> = context
        .projects
        .iter()
        .map(|path| serde_json::to_value(read_project_status(path)).unwrap_or(Value::Null))
        .collect();
    let project = context.projects.first().cloned().unwrap_or_default();
    Ok(ToolOutcome {
        content: bounded_json(json!({ "projects": rows }))?,
        sources: (!project.is_empty())
            .then(|| citation(&project, None, None, None))
            .into_iter()
            .collect(),
    })
}

fn list_changes(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let changes = read_project_changes(&project, false)?;
    Ok(ToolOutcome {
        content: bounded_json(serde_json::to_value(&changes).map_err(|error| error.to_string())?)?,
        sources: vec![citation(&project, None, None, None)],
    })
}

fn read_diff(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let file = required(&args.file, "file")?;
    let relative = resolve_file(&project, file)?;
    let view = parse_view(args.view.as_deref())?;
    let diff = read_file_diff(&project, &relative, view, false, DiffContext::Default, None)?;
    let sources = vec![citation(&project, Some(&relative), Some(1), Some(u32::MAX))];
    Ok(ToolOutcome {
        content: bounded_json(serde_json::to_value(&diff).map_err(|error| error.to_string())?)?,
        sources,
    })
}

fn read_file(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let file = required(&args.file, "file")?;
    let relative = resolve_file(&project, file)?;
    let full = Path::new(&project).join(&relative);
    let metadata = std::fs::metadata(&full).map_err(|error| format!("{relative}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{relative}: not a file"));
    }
    let (contents, truncated) = read_bounded(&full)?;
    Ok(ToolOutcome {
        content: bounded_json(json!({
            "path": relative,
            "truncated": truncated,
            "contents": contents,
        }))?,
        sources: vec![citation(&project, Some(&relative), None, None)],
    })
}

fn search_changes(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let query = required(&args.query, "query")?;
    let projects: Vec<String> = match &args.project {
        Some(path) => vec![resolve_project(context, path)?],
        None => context.projects.clone(),
    };
    let mut matches = Vec::new();
    let mut sources = Vec::new();
    for project in &projects {
        if matches.len() >= MAX_SEARCH_MATCHES {
            break;
        }
        let found = search_changed_files(project, query, MAX_SEARCH_MATCHES - matches.len())?;
        for hit in found {
            sources.push(citation(
                project,
                Some(&hit.file),
                Some(hit.line),
                Some(hit.line),
            ));
            matches.push(serde_json::to_value(&hit).unwrap_or(Value::Null));
        }
    }
    Ok(ToolOutcome {
        content: bounded_json(json!({ "matches": matches, "count": matches.len() }))?,
        sources,
    })
}

fn list_worktrees(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let worktrees = read_worktrees(&project)?;
    Ok(ToolOutcome {
        content: bounded_json(json!({ "worktrees": worktrees }))?,
        sources: vec![citation(&project, None, None, None)],
    })
}

fn recent_commits(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let limit = clamp_limit(args.limit);
    let commits = read_recent_commits(&project, limit)?;
    Ok(ToolOutcome {
        content: bounded_json(json!({ "commits": commits, "count": commits.len() }))?,
        sources: vec![citation(&project, None, None, None)],
    })
}

fn file_history(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let file = required(&args.file, "file")?;
    let relative = resolve_file(&project, file)?;
    let commits = read_file_history(&project, &relative, clamp_limit(args.limit))?;
    Ok(ToolOutcome {
        content: bounded_json(json!({ "file": relative, "commits": commits }))?,
        sources: vec![citation(&project, Some(&relative), None, None)],
    })
}

fn blame(context: &ToolContext, args: &ToolArgs) -> Result<ToolOutcome, String> {
    let project = resolve_project(context, required(&args.project, "project")?)?;
    let file = required(&args.file, "file")?;
    let relative = resolve_file(&project, file)?;
    let blame = read_blame(&project, &relative, args.start_line, args.end_line)?;
    let start = args
        .start_line
        .or_else(|| blame.first().map(|row| row.line));
    let end = args
        .end_line
        .or_else(|| blame.last().map(|row| row.line))
        .or(start);
    Ok(ToolOutcome {
        content: bounded_json(json!({
            "file": relative,
            "truncated": blame.len() >= MAX_BLAME_LINES,
            "lines": blame,
        }))?,
        sources: vec![citation(&project, Some(&relative), start, end)],
    })
}

fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str, String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{name}: missing required argument"))
}

fn clamp_limit(limit: Option<u32>) -> usize {
    limit
        .map(|value| value.clamp(1, MAX_COMMIT_LIMIT as u32) as usize)
        .unwrap_or(20)
}

/// Canonicalizes the candidate and requires it to be a registered project or a
/// descendant on a `/` boundary. Returns the stored project path: the identity
/// the model was given, even when it differs from the canonical form.
fn resolve_project(context: &ToolContext, candidate: &str) -> Result<String, String> {
    registered_path(&context.projects, candidate)
        .map(|registered| registered.project)
        .map_err(|error| match error {
            crate::error::GroveError::OutsideRegisteredProjects { .. } => format!(
                "{candidate}: not inside a registered project; pass one of the project paths \
                 from list_projects"
            ),
            other => other.to_string(),
        })
}

/// Turns a user/model file path into a safe project-relative path. Absolute paths
/// must already sit inside the project; relative paths may not escape it.
fn resolve_file(project: &str, file: &str) -> Result<String, String> {
    let project_root = Path::new(project);
    // Compare against the canonical root so a stored path through a symlink
    // (`/tmp/...` on macOS) still matches canonicalized candidates.
    let canonical_root =
        std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    let root_text = canonical_root.to_string_lossy().into_owned();
    let candidate = Path::new(file);
    let relative: std::borrow::Cow<'_, str> = if candidate.is_absolute() {
        let canonical =
            std::fs::canonicalize(candidate).map_err(|error| format!("{file}: {error}"))?;
        canonical
            .strip_prefix(&canonical_root)
            .map_err(|_| format!("{file}: not inside {project}"))?
            .to_string_lossy()
            .into_owned()
            .into()
    } else {
        file.to_string().into()
    };

    let joined = project_root.join(relative.as_ref());
    let canonical = std::fs::canonicalize(&joined).map_err(|error| format!("{file}: {error}"))?;
    if !path_is_inside_project(&root_text, canonical.to_string_lossy().as_ref()) {
        return Err(format!("{file}: not inside {project}"));
    }
    Ok(canonical
        .strip_prefix(&canonical_root)
        .map_err(|_| format!("{file}: not inside {project}"))?
        .to_string_lossy()
        .into_owned())
}

/// Reads at most `MAX_READ_FILE_BYTES` from a file, reporting whether it was cut.
fn read_bounded(path: &Path) -> Result<(String, bool), String> {
    use std::io::Read;

    let mut file =
        std::fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let cap = MAX_READ_FILE_BYTES as usize;
    let mut buffer = vec![0u8; cap + 1];
    let mut read = 0usize;
    loop {
        let filled = file
            .read(&mut buffer[read..])
            .map_err(|error| format!("read: {error}"))?;
        if filled == 0 {
            break;
        }
        read += filled;
        if read > cap {
            break;
        }
    }
    let truncated = read > cap;
    let slice = &buffer[..read.min(cap)];
    Ok((String::from_utf8_lossy(slice).into_owned(), truncated))
}

/// Serializes and enforces the payload bound: anything past 512 KiB is dropped to a
/// marker the model can read.
fn bounded_json(value: Value) -> Result<String, String> {
    let mut text = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    if text.len() > crate::git::MAX_TEXT_SIDE_BYTES as usize {
        text = format!(
            "{{\"truncated\": true, \"note\": \"payload exceeded {} bytes and was cut\"}}",
            crate::git::MAX_TEXT_SIDE_BYTES
        );
    }
    Ok(text)
}

fn citation(
    project: &str,
    file: Option<&str>,
    start: Option<u32>,
    end: Option<u32>,
) -> ChatCitation {
    let label = match (file, start) {
        (Some(file), Some(line)) => format!("{file}:{line}"),
        (Some(file), None) => file.to_string(),
        _ => std::path::Path::new(project)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| project.to_string()),
    };
    ChatCitation {
        project_path: project.to_string(),
        file_path: file.map(str::to_string),
        start_line: start.filter(|line| *line != u32::MAX),
        end_line: end.filter(|line| *line != u32::MAX),
        label,
    }
}
