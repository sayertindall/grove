//! The `grove` command-line surface: read-only facts about the registered
//! projects, the same readers the GUI uses, printed as compact tables or JSON.

use std::path::Path;

use crate::chat;
use crate::config;
use crate::git::{
    read_file_diff, read_project_changes, read_project_status, read_worktrees,
    repository_main_path, DiffView,
};

/// A failure with its process exit code: 1 runtime, 2 usage.
pub struct Failure {
    pub code: i32,
    pub message: String,
}

fn usage(message: impl Into<String>) -> Failure {
    Failure {
        code: 2,
        message: message.into(),
    }
}

fn runtime(message: impl Into<String>) -> Failure {
    Failure {
        code: 1,
        message: message.into(),
    }
}

/// Runs one subcommand with everything after the subcommand name. Returns the
/// process exit code; the caller prints and exits.
pub fn run(args: &[String]) -> Result<i32, Failure> {
    let Some(command) = args.first() else {
        return Err(usage(USAGE));
    };
    let rest = &args[1..];
    match command.as_str() {
        "status" => command_status(rest),
        "changes" => command_changes(rest),
        "diff" => command_diff(rest),
        "worktrees" => command_worktrees(rest),
        "ask" => command_ask(rest),
        "help" => {
            print!("{USAGE}");
            Ok(0)
        }
        other => Err(usage(format!(
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
    help
        This text. `--help` / `-h` and `--version` also work.

PROJECT ARGUMENTS:
    A registered absolute path, or a display name (exact match, or a unique
    prefix; an ambiguous prefix names the candidates).

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
fn split_flags(args: &[String], allow_view: bool) -> Result<(Vec<&str>, Flags), Failure> {
    let mut positional = Vec::new();
    let mut flags = Flags {
        json: false,
        view: DiffView::Head,
    };
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--json" => {
                if flags.json {
                    return Err(usage("--json given twice"));
                }
                flags.json = true;
            }
            "--view" if allow_view => {
                index += 1;
                flags.view = parse_view(args.get(index).map(String::as_str))?;
            }
            other if allow_view && other.starts_with("--view=") => {
                flags.view = parse_view(Some(&other["--view=".len()..]))?;
            }
            other => positional.push(other),
        }
        index += 1;
    }
    Ok((positional, flags))
}

fn parse_view(value: Option<&str>) -> Result<DiffView, Failure> {
    match value {
        Some("head") => Ok(DiffView::Head),
        Some("staged") => Ok(DiffView::Staged),
        Some("unstaged") => Ok(DiffView::Unstaged),
        Some(other) => Err(usage(format!(
            "unknown view `{other}` (expected head, staged, or unstaged)"
        ))),
        None => Err(usage("--view needs head, staged, or unstaged")),
    }
}

/// One registered project: its stored path and the display name the sidebar
/// derives from it.
struct Project {
    path: String,
    display_name: String,
}

fn load_projects() -> Result<Vec<Project>, Failure> {
    let paths = config::load_registered_paths().map_err(runtime)?;
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

/// Resolves a project argument: a registered path (as stored or canonicalized),
/// a display name, or a unique display-name prefix. Ambiguity names the
/// candidates; no match is a runtime failure (exit 1).
fn resolve_project(name: &str) -> Result<Project, Failure> {
    let projects = load_projects()?;

    if let Some(found) = projects.iter().find(|project| project.path == name) {
        return Ok(Project {
            path: found.path.clone(),
            display_name: found.display_name.clone(),
        });
    }

    let canonical = std::fs::canonicalize(name)
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    if let Some(found) = canonical
        .as_ref()
        .and_then(|path| projects.iter().find(|project| &project.path == path))
    {
        return Ok(Project {
            path: found.path.clone(),
            display_name: found.display_name.clone(),
        });
    }

    let by_name: Vec<&Project> = projects
        .iter()
        .filter(|project| project.display_name == name)
        .collect();
    match by_name.len() {
        1 => {
            let found = by_name[0];
            return Ok(Project {
                path: found.path.clone(),
                display_name: found.display_name.clone(),
            });
        }
        count if count > 1 => {
            let candidates: Vec<String> =
                by_name.iter().map(|project| project.path.clone()).collect();
            return Err(usage(format!(
                "`{name}` matches {count} projects; name one of: {}",
                candidates.join(", ")
            )));
        }
        _ => {}
    }

    let prefix_matches: Vec<&Project> = projects
        .iter()
        .filter(|project| project.display_name.starts_with(name))
        .collect();
    match prefix_matches.len() {
        1 => {
            let found = prefix_matches[0];
            Ok(Project {
                path: found.path.clone(),
                display_name: found.display_name.clone(),
            })
        }
        count if count > 1 => {
            let candidates: Vec<String> = prefix_matches
                .iter()
                .map(|project| project.display_name.clone())
                .collect();
            Err(usage(format!(
                "`{name}` is ambiguous; it prefixes {count} projects: {}",
                candidates.join(", ")
            )))
        }
        _ => Err(runtime(format!(
            "`{name}` is not a registered project (registered: {})",
            if projects.is_empty() {
                "none".to_string()
            } else {
                projects
                    .iter()
                    .map(|project| project.display_name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ))),
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

fn to_json(value: &impl serde::Serialize) -> Result<String, Failure> {
    serde_json::to_string(value).map_err(|error| runtime(error.to_string()))
}

// --- status --------------------------------------------------------------------

fn command_status(args: &[String]) -> Result<i32, Failure> {
    let (_, flags) = split_flags(args, false)?;
    let projects = load_projects()?;

    let statuses: Vec<_> = projects
        .iter()
        .map(|project| {
            // The CLI never arms the watcher, so it is never watching here.
            read_project_status(&project.path)
        })
        .collect();

    if flags.json {
        println!("{}", to_json(&statuses)?);
        return Ok(0);
    }

    let mut rows = vec![vec![
        "path".into(),
        "state".into(),
        "branch".into(),
        "upstream".into(),
        "ahead/behind".into(),
        "staged".into(),
        "unstaged".into(),
        "untracked".into(),
        "+/-".into(),
        "worktree-of".into(),
        "watching".into(),
    ]];
    for status in &statuses {
        let (branch, upstream, ahead_behind) = match &status.branch {
            Some(branch) => (
                branch
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("({})", branch.head_short.as_deref().unwrap_or("detached"))),
                branch.upstream.clone().unwrap_or_else(|| "-".into()),
                format!("{}/{}", branch.ahead, branch.behind),
            ),
            None => ("-".into(), "-".into(), "-".into()),
        };
        rows.push(vec![
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
        ]);
    }
    print_table(&rows);
    Ok(0)
}

// --- changes -------------------------------------------------------------------

fn command_changes(args: &[String]) -> Result<i32, Failure> {
    let (positional, flags) = split_flags(args, false)?;
    match positional.len() {
        0 => {}
        1 => {}
        _ => return Err(usage("changes takes at most one project")),
    }

    let targets: Vec<Project> = match positional.first() {
        Some(name) => vec![resolve_project(name)?],
        None => load_projects()?,
    };

    let mut changes = Vec::new();
    for project in &targets {
        changes.push(read_project_changes(&project.path, false).map_err(runtime)?);
    }

    if flags.json {
        println!("{}", to_json(&changes)?);
        return Ok(0);
    }

    let mut rows = vec![vec![
        "project".into(),
        "path".into(),
        "status".into(),
        "staged".into(),
        "unstaged".into(),
        "binary".into(),
        "+/-".into(),
        "old-path".into(),
    ]];
    for change in &changes {
        let name = display_name(&change.path);
        if change.files.is_empty() {
            rows.push(vec![name, "-".into(), "clean".into(), "".into(), "".into(), "".into(), "".into(), "".into()]);
            continue;
        }
        for file in &change.files {
            rows.push(vec![
                name.clone(),
                file.path.clone(),
                format!("{:?}", file.status).to_lowercase(),
                if file.staged { "yes" } else { "" }.into(),
                if file.unstaged { "yes" } else { "" }.into(),
                if file.binary { "yes" } else { "" }.into(),
                format!("{}/{}", file.additions, file.deletions),
                file.old_path.clone().unwrap_or_default(),
            ]);
        }
    }
    print_table(&rows);
    Ok(0)
}

// --- diff ----------------------------------------------------------------------

fn command_diff(args: &[String]) -> Result<i32, Failure> {
    let (positional, flags) = split_flags(args, true)?;
    if positional.len() != 2 {
        return Err(usage("diff takes exactly a project and a file"));
    }
    let project = resolve_project(positional[0])?;
    let diff =
        read_file_diff(&project.path, positional[1], flags.view, false).map_err(runtime)?;

    if flags.json {
        println!("{}", to_json(&diff)?);
        return Ok(0);
    }

    println!(
        "{}  {}  {}",
        diff.path,
        format!("{:?}", diff.status).to_lowercase(),
        format!("{:?}", diff.view).to_lowercase(),
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

fn command_worktrees(args: &[String]) -> Result<i32, Failure> {
    let (positional, flags) = split_flags(args, false)?;
    match positional.len() {
        0 | 1 => {}
        _ => return Err(usage("worktrees takes at most one project")),
    }

    let targets: Vec<Project> = match positional.first() {
        Some(name) => vec![resolve_project(name)?],
        None => load_projects()?,
    };

    // Group by repository: several registered projects can be linked worktrees
    // of one repository, and that repository's worktree list is emitted once,
    // keyed by its main worktree path.
    let registered_paths: Vec<String> = load_projects()?
        .into_iter()
        .map(|project| project.path)
        .collect();
    let mut seen_repos: Vec<String> = Vec::new();
    let mut rows: Vec<WorktreeRow> = Vec::new();
    for project in &targets {
        let repo = repository_main_path(&project.path).map_err(runtime)?;
        if seen_repos.contains(&repo) {
            continue;
        }
        seen_repos.push(repo.clone());
        for worktree in read_worktrees(&project.path).map_err(runtime)? {
            let registered = registered_paths.iter().any(|path| {
                path == &worktree.path
                    || std::fs::canonicalize(&worktree.path)
                        .map(|canonical| path == &canonical.to_string_lossy())
                        .unwrap_or(false)
            });
            rows.push(WorktreeRow {
                repo: repo.clone(),
                project: project.path.clone(),
                registered,
                name: worktree.name,
                path: worktree.path,
                branch: worktree.branch,
                head_short: worktree.head_short,
                locked: worktree.locked,
                main: worktree.main,
                prunable: worktree.prunable,
            });
        }
    }

    if flags.json {
        println!("{}", to_json(&rows)?);
        return Ok(0);
    }

    let mut table = vec![vec![
        "repo".into(),
        "project".into(),
        "registered".into(),
        "name".into(),
        "path".into(),
        "branch".into(),
        "head".into(),
        "locked".into(),
        "main".into(),
        "prunable".into(),
    ]];
    for row in &rows {
        table.push(vec![
            row.repo.clone(),
            row.project.clone(),
            if row.registered { "yes" } else { "" }.into(),
            row.name.clone(),
            row.path.clone(),
            row.branch.clone().unwrap_or_else(|| "-".into()),
            row.head_short.clone().unwrap_or_else(|| "-".into()),
            if row.locked { "yes" } else { "" }.into(),
            if row.main { "yes" } else { "" }.into(),
            if row.prunable { "yes" } else { "" }.into(),
        ]);
    }
    print_table(&table);
    Ok(0)
}

// --- ask -----------------------------------------------------------------------

/// `grove ask "<prompt>" ...` delegates to the chat CLI. `--file` is a context
/// hint parsed here and appended to the prompt, because the shared chat entry
/// owns everything after the prompt.
fn command_ask(args: &[String]) -> Result<i32, Failure> {
    let mut passthrough: Vec<String> = Vec::new();
    let mut file: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--file" => {
                index += 1;
                let value = args.get(index).ok_or_else(|| usage("--file needs a path"))?;
                file = Some(value.clone());
            }
            other if other.starts_with("--file=") => {
                file = Some(other["--file=".len()..].to_string());
            }
            other => passthrough.push(other.to_string()),
        }
        index += 1;
    }

    if let Some(file) = &file {
        if !Path::new(file).exists() {
            return Err(runtime(format!("{file}: no such file")));
        }
        passthrough.push(format!("(context file: {file})"));
    }

    chat::cli::run_ask(&passthrough).map_err(runtime)?;
    Ok(0)
}
