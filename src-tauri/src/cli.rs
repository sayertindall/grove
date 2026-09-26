//! The `grove` command-line surface: read-only facts about the registered
//! projects, the same readers the GUI uses, printed as compact tables or JSON.
//! Failures are `GroveError`s; the caller exits with `GroveError::exit_code`.

use std::path::Path;

use crate::chat;
use crate::config::{self, registered_path};
use crate::error::GroveError;
use crate::git::{
    read_file_diff, read_project_changes, read_project_status, read_worktrees,
    repository_main_path, BranchInfo, DiffContext, DiffView, ProjectChanges, ProjectStatus,
    WorktreeInfo,
};

/// Runs one subcommand with everything after the subcommand name. Returns the
/// process exit code; the caller prints and exits.
pub fn run(args: &[String]) -> Result<i32, GroveError> {
    let Some(command) = args.first() else {
        return Err(GroveError::usage(USAGE));
    };
    let rest = &args[1..];
    match command.as_str() {
        "status" => command_status(rest),
        "changes" => command_changes(rest),
        "diff" => command_diff(rest),
        "worktrees" => command_worktrees(rest),
        "ask" => command_ask(rest),
        "mcp" => crate::mcp::run(rest),
        "help" => {
            print!("{USAGE}");
            Ok(0)
        }
        other => Err(GroveError::usage(format!(
            "unknown command `{other}`\n\n{USAGE}"
        ))),
    }
}

pub const USAGE: &str = "\
grove — read-only git working-tree viewer

USAGE:
    grove <COMMAND> [OPTIONS]

COMMANDS:
    status [--json]
        Every registered project: state, branch, upstream, ahead/behind,
        staged/unstaged/untracked counts, additions/deletions, worktree
        origin, whether the watcher is armed.
    changes [<project>] [--json]
        Changed files per project: status, staged/unstaged, binary,
        additions/deletions, old path. All projects when omitted.
    diff <project> <file> [--view head|staged|unstaged] [--json]
        One file's diff. View defaults to head.
    worktrees [<project>] [--json]
        Worktrees, including prunable ones. All projects when omitted.
    ask \"<prompt>\" [--project <path>] [--file <path>] [--json]
        One chat turn through the configured provider.
    mcp
        Serve the assistant's nine read-only tools over MCP on stdio
        (JSON-RPC on stdout, logs on stderr) for Claude Code, Codex, etc.
    help
        This text. `--help` / `-h` and `--version` also work.

PROJECT ARGUMENTS:
    A path inside a registered project, or a display name (exact match, or a
    unique prefix; an ambiguous prefix names the candidates).

FLAGS:
    --json   Emit the serde shape of the GUI's own types.

EXIT CODES:
    0 success, 1 runtime failure, 2 usage error.

ENVIRONMENT:
    GROVE_DATA_DIR   Read the store from this directory instead of the app data.
";

// --- Argument helpers ----------------------------------------------------------

struct Flags {
    json: bool,
    view: DiffView,
}

/// Splits out `--json` and `--view <v>` / `--view=<v>`; anything else is
/// positional. A repeated or malformed flag is a usage error.
fn split_flags(args: &[String], allow_view: bool) -> Result<(Vec<&str>, Flags), GroveError> {
    let mut positional = Vec::new();
    let mut flags = Flags {
        json: false,
        view: DiffView::Head,
    };
    let mut rest = args.iter().map(String::as_str);
    while let Some(arg) = rest.next() {
        match arg {
            "--json" if flags.json => return Err(GroveError::usage("--json given twice")),
            "--json" => flags.json = true,
            "--view" if allow_view => flags.view = parse_view(rest.next())?,
            other if allow_view && other.starts_with("--view=") => {
                flags.view = parse_view(Some(&other["--view=".len()..]))?;
            }
            other => positional.push(other),
        }
    }
    Ok((positional, flags))
}

fn parse_view(value: Option<&str>) -> Result<DiffView, GroveError> {
    value
        .ok_or_else(|| GroveError::usage("--view needs head, staged, or unstaged"))?
        .parse()
}

/// At most one positional project; none means every registered project.
fn target_projects(positional: &[&str], command: &str) -> Result<Vec<Project>, GroveError> {
    match positional {
        [] => load_projects(),
        [name] => Ok(vec![resolve_project(name)?]),
        _ => Err(GroveError::usage(format!(
            "{command} takes at most one project"
        ))),
    }
}

/// One registered project: its stored path and the display name the sidebar
/// derives from it.
#[derive(Clone)]
struct Project {
    path: String,
    display_name: String,
}

fn load_projects() -> Result<Vec<Project>, GroveError> {
    let paths = config::load_registered_paths()?;
    Ok(paths
        .into_iter()
        .map(|path| Project {
            display_name: display_name(&path),
            path,
        })
        .collect())
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Resolves a project argument. A word with a `/` is a path and goes through the
/// same registration guard as the GUI: it must be a registered project or inside
/// one. Anything else is a display name, then a unique display-name prefix.
fn resolve_project(name: &str) -> Result<Project, GroveError> {
    let projects = load_projects()?;
    if name.contains('/') {
        return project_containing(&projects, name);
    }
    let exact = unique_match(&projects, name, |project| project.display_name == name)?;
    if let Some(found) = exact {
        return Ok(found);
    }
    let prefixed = unique_match(&projects, name, |project| {
        project.display_name.starts_with(name)
    })?;
    prefixed.ok_or_else(|| unknown_project(&projects, name))
}

fn project_containing(projects: &[Project], path: &str) -> Result<Project, GroveError> {
    if let Some(found) = projects.iter().find(|project| project.path == path) {
        return Ok(found.clone());
    }
    let paths: Vec<String> = projects
        .iter()
        .map(|project| project.path.clone())
        .collect();
    let registered = registered_path(&paths, path)?;
    projects
        .iter()
        .find(|project| project.path == registered.project)
        .cloned()
        .ok_or_else(|| GroveError::OutsideRegisteredProjects {
            path: path.to_string(),
        })
}

/// The one project `matches` selects, `None` for none, a usage error naming the
/// candidates for several.
fn unique_match(
    projects: &[Project],
    name: &str,
    matches: impl Fn(&Project) -> bool,
) -> Result<Option<Project>, GroveError> {
    let found: Vec<&Project> = projects.iter().filter(|project| matches(project)).collect();
    match found.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some((*one).clone())),
        many => {
            let candidates: Vec<&str> = many.iter().map(|project| project.path.as_str()).collect();
            Err(GroveError::usage(format!(
                "`{name}` matches {} projects; name one of: {}",
                many.len(),
                candidates.join(", ")
            )))
        }
    }
}

fn unknown_project(projects: &[Project], name: &str) -> GroveError {
    let names: Vec<&str> = projects
        .iter()
        .map(|project| project.display_name.as_str())
        .collect();
    GroveError::UnknownProject {
        name: name.to_string(),
        registered: if names.is_empty() {
            "none".to_string()
        } else {
            names.join(", ")
        },
    }
}

/// Prints rows as aligned columns. The first row is the header.
fn print_table(rows: &[Vec<String>]) {
    let Some(header) = rows.first() else {
        return;
    };
    let mut widths: Vec<usize> = header.iter().map(|cell| cell.chars().count()).collect();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    for row in rows {
        let last = row.len() - 1;
        let line: String = row
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                if index == last {
                    cell.clone()
                } else {
                    format!("{cell:<width$}", width = widths[index] + 2)
                }
            })
            .collect();
        println!("{}", line.trim_end());
    }
}

fn header(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn yes(flag: bool) -> String {
    if flag { "yes" } else { "" }.to_string()
}

fn print_json(value: &impl serde::Serialize) -> Result<i32, GroveError> {
    let text = serde_json::to_string(value).map_err(|error| GroveError::Io {
        context: "json".to_string(),
        source: error.into(),
    })?;
    println!("{text}");
    Ok(0)
}

// --- status --------------------------------------------------------------------

fn command_status(args: &[String]) -> Result<i32, GroveError> {
    let (_, flags) = split_flags(args, false)?;
    // The CLI never arms the watcher, so no row is watching.
    let statuses: Vec<ProjectStatus> = load_projects()?
        .iter()
        .map(|project| read_project_status(&project.path))
        .collect();
    if flags.json {
        return print_json(&statuses);
    }

    let mut rows = vec![header(&[
        "path",
        "state",
        "branch",
        "upstream",
        "ahead/behind",
        "staged",
        "unstaged",
        "untracked",
        "+/-",
        "worktree-of",
        "watching",
    ])];
    rows.extend(statuses.iter().map(status_row));
    print_table(&rows);
    Ok(0)
}

fn status_row(status: &ProjectStatus) -> Vec<String> {
    let [branch, upstream, ahead_behind] = branch_cells(status.branch.as_ref());
    vec![
        status.path.clone(),
        format!("{:?}", status.state).to_lowercase(),
        branch,
        upstream,
        ahead_behind,
        status.staged_count.to_string(),
        status.unstaged_count.to_string(),
        status.untracked_count.to_string(),
        format!("{}/{}", status.additions, status.deletions),
        status.worktree_of.clone().unwrap_or_else(|| "-".into()),
        if status.watching { "yes" } else { "no" }.into(),
    ]
}

fn branch_cells(branch: Option<&BranchInfo>) -> [String; 3] {
    let Some(branch) = branch else {
        return ["-".into(), "-".into(), "-".into()];
    };
    let name = branch
        .name
        .clone()
        .unwrap_or_else(|| format!("({})", branch.head_short.as_deref().unwrap_or("detached")));
    [
        name,
        branch.upstream.clone().unwrap_or_else(|| "-".into()),
        format!("{}/{}", branch.ahead, branch.behind),
    ]
}

// --- changes -------------------------------------------------------------------

fn command_changes(args: &[String]) -> Result<i32, GroveError> {
    let (positional, flags) = split_flags(args, false)?;
    let changes = target_projects(&positional, "changes")?
        .iter()
        .map(|project| read_project_changes(&project.path, false))
        .collect::<Result<Vec<_>, _>>()?;
    if flags.json {
        return print_json(&changes);
    }

    let mut rows = vec![header(&[
        "project", "path", "status", "staged", "unstaged", "binary", "+/-", "old-path",
    ])];
    for change in &changes {
        rows.extend(change_rows(change));
    }
    print_table(&rows);
    Ok(0)
}

fn change_rows(change: &ProjectChanges) -> Vec<Vec<String>> {
    let name = display_name(&change.path);
    if change.files.is_empty() {
        let mut clean = vec![name, "-".into(), "clean".into()];
        clean.resize(8, String::new());
        return vec![clean];
    }
    change
        .files
        .iter()
        .map(|file| {
            vec![
                name.clone(),
                file.path.clone(),
                format!("{:?}", file.status).to_lowercase(),
                yes(file.staged),
                yes(file.unstaged),
                yes(file.binary),
                format!("{}/{}", file.additions, file.deletions),
                file.old_path.clone().unwrap_or_default(),
            ]
        })
        .collect()
}

// --- diff ----------------------------------------------------------------------

fn command_diff(args: &[String]) -> Result<i32, GroveError> {
    let (positional, flags) = split_flags(args, true)?;
    let [project, file] = positional.as_slice() else {
        return Err(GroveError::usage("diff takes exactly a project and a file"));
    };
    let project = resolve_project(project)?;
    let diff = read_file_diff(
        &project.path,
        file,
        flags.view,
        false,
        DiffContext::Default,
        None,
    )?;
    if flags.json {
        return print_json(&diff);
    }

    println!(
        "{}  {}  {}",
        diff.path,
        format!("{:?}", diff.status).to_lowercase(),
        diff.view,
    );
    if diff.binary {
        println!("(binary)");
        return Ok(0);
    }
    print!("{}", diff.patch);
    Ok(0)
}

// --- worktrees -----------------------------------------------------------------

/// One worktree row with its repository association carried in the data, so
/// rendering never has to recover the owner by position.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRow {
    /// The repository's main worktree path.
    repo: String,
    /// The registered project the repo was discovered through.
    project: String,
    /// Whether this worktree path is itself a registered project.
    registered: bool,
    name: String,
    path: String,
    branch: Option<String>,
    head_short: Option<String>,
    locked: bool,
    main: bool,
    prunable: bool,
}

fn command_worktrees(args: &[String]) -> Result<i32, GroveError> {
    let (positional, flags) = split_flags(args, false)?;
    let targets = target_projects(&positional, "worktrees")?;
    let rows = worktree_rows(&targets)?;
    if flags.json {
        return print_json(&rows);
    }

    let mut table = vec![header(&[
        "repo",
        "project",
        "registered",
        "name",
        "path",
        "branch",
        "head",
        "locked",
        "main",
        "prunable",
    ])];
    table.extend(rows.iter().map(|row| {
        vec![
            row.repo.clone(),
            row.project.clone(),
            yes(row.registered),
            row.name.clone(),
            row.path.clone(),
            row.branch.clone().unwrap_or_else(|| "-".into()),
            row.head_short.clone().unwrap_or_else(|| "-".into()),
            yes(row.locked),
            yes(row.main),
            yes(row.prunable),
        ]
    }));
    print_table(&table);
    Ok(0)
}

/// Grouped by repository: several registered projects can be linked worktrees of
/// one repository, and that repository's worktree list is emitted once, keyed by
/// its main worktree path.
fn worktree_rows(targets: &[Project]) -> Result<Vec<WorktreeRow>, GroveError> {
    let registered: Vec<String> = load_projects()?
        .into_iter()
        .map(|project| project.path)
        .collect();
    let mut seen_repos: Vec<String> = Vec::new();
    let mut rows = Vec::new();
    for project in targets {
        let repo = repository_main_path(&project.path)?;
        if seen_repos.contains(&repo) {
            continue;
        }
        seen_repos.push(repo.clone());
        for worktree in read_worktrees(&project.path)? {
            rows.push(worktree_row(&repo, project, &registered, worktree));
        }
    }
    Ok(rows)
}

fn worktree_row(
    repo: &str,
    project: &Project,
    registered: &[String],
    worktree: WorktreeInfo,
) -> WorktreeRow {
    let canonical = std::fs::canonicalize(&worktree.path)
        .map(|path| path.to_string_lossy().into_owned())
        .ok();
    let is_registered = registered
        .iter()
        .any(|path| path == &worktree.path || Some(path) == canonical.as_ref());
    WorktreeRow {
        repo: repo.to_string(),
        project: project.path.clone(),
        registered: is_registered,
        name: worktree.name,
        path: worktree.path,
        branch: worktree.branch,
        head_short: worktree.head_short,
        locked: worktree.locked,
        main: worktree.main,
        prunable: worktree.prunable,
    }
}

// --- ask -----------------------------------------------------------------------

/// `grove ask "<prompt>" ...` delegates to the chat CLI. `--file` is a context
/// hint parsed here and appended to the prompt, because the shared chat entry
/// owns everything after the prompt.
fn command_ask(args: &[String]) -> Result<i32, GroveError> {
    let mut passthrough: Vec<String> = Vec::new();
    let mut file: Option<String> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--file" => {
                let value = rest
                    .next()
                    .ok_or_else(|| GroveError::usage("--file needs a path"))?;
                file = Some(value.clone());
            }
            other if other.starts_with("--file=") => {
                file = Some(other["--file=".len()..].to_string());
            }
            other => passthrough.push(other.to_string()),
        }
    }
    if let Some(file) = &file {
        if !Path::new(file).exists() {
            return Err(GroveError::Missing { path: file.clone() });
        }
        passthrough.push(format!("(context file: {file})"));
    }
    chat::cli::run_ask(&passthrough).map_err(GroveError::chat)?;
    Ok(0)
}
