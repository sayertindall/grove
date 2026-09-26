//! Deterministic review signals: which changed files deserve a closer look, how
//! long a project has been dirty, and which coding agent last left a marker in it.
//! Every rule is a path pattern or a pattern over added lines; nothing is guessed.

use std::path::Path;
use std::sync::LazyLock;
use std::time::SystemTime;

use git2::{Patch, Status, Statuses};
use regex::RegexSet;
use serde::Serialize;

use super::status::{ChangeSummary, ProjectStatus};
use super::{FileChangeStatus, MAX_TEXT_SIDE_BYTES};

/// Why a changed file may need a closer look. Ordered by severity, highest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RiskSignal {
    Secret,
    Env,
    Auth,
    Migration,
    NoTests,
    Large,
    Lockfile,
    Generated,
}

/// Added plus deleted lines above which a file is `large`.
const LARGE_CHANGE_LINES: u32 = 400;

const LOCKFILE_NAMES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
    "flake.lock",
    "package.resolved",
    "podfile.lock",
    "mix.lock",
    "pubspec.lock",
    "packages.lock.json",
];

const MIGRATION_SEGMENTS: &[&str] = &["migrations", "migration", "migrate", "alembic"];

const GENERATED_SEGMENTS: &[&str] = &[
    "dist",
    "gen",
    "generated",
    "__generated__",
    "__snapshots__",
    "node_modules",
];

const GENERATED_SUFFIXES: &[&str] = &[
    ".min.js",
    ".min.css",
    ".snap",
    ".js.map",
    ".css.map",
    ".pb.go",
    "_pb2.py",
    ".g.dart",
    ".designer.cs",
];

const AUTH_WORDS: &[&str] = &[
    "auth",
    "authn",
    "authz",
    "authentication",
    "authorization",
    "oauth",
    "login",
    "logout",
    "session",
    "sessions",
    "password",
    "passwords",
    "credential",
    "credentials",
    "jwt",
    "permission",
    "permissions",
    "rbac",
    "acl",
    "sso",
    "saml",
    "csrf",
    "keychain",
];

const TEST_SEGMENTS: &[&str] = &["test", "tests", "__tests__", "spec", "specs", "e2e"];

const TEST_NAME_MARKERS: &[&str] = &[".test.", ".spec.", "_test.", "_spec.", "test_"];

const SOURCE_ROOTS: &[&str] = &["src", "lib", "app"];

const SOURCE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "rb", "java", "kt", "swift", "c",
    "cc", "cpp", "h", "hpp", "cs", "php", "vue", "svelte", "ex", "exs", "scala", "dart",
];

/// A directory or file in the repository root that a coding agent leaves behind,
/// and the agent's name as the sidebar shows it.
const AGENT_MARKERS: &[(&str, &str)] = &[
    (".claude", "claude"),
    ("CLAUDE.local.md", "claude"),
    (".codex", "codex"),
    (".cursor", "cursor"),
    (".aider.chat.history.md", "aider"),
    (".omp", "omp"),
];

/// Credential shapes matched against added lines only.
static SECRET_PATTERNS: LazyLock<Option<RegexSet>> = LazyLock::new(|| {
    RegexSet::new([
        r"sk-[A-Za-z0-9_-]{20,}",
        r"AKIA[0-9A-Z]{16}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"gh[pousr]_[A-Za-z0-9]{36,}",
        r"xox[abprs]-[A-Za-z0-9-]{10,}",
        r#"(?i)(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{16,}"#,
    ])
    .map_err(|error| eprintln!("secret patterns unavailable: {error}"))
    .ok()
});

/// The signals of one changed file that its path and line counts alone decide.
/// `secret` comes from the added-line scan of the same patch the counts came from.
pub fn file_risks(path: &str, additions: u32, deletions: u32, secret: bool) -> Vec<RiskSignal> {
    let lower = path.to_ascii_lowercase();
    let (dirs, name) = split_path(&lower);
    let rules = [
        (secret, RiskSignal::Secret),
        (is_env_file(name), RiskSignal::Env),
        (is_auth_path(path), RiskSignal::Auth),
        (is_migration(&dirs, name), RiskSignal::Migration),
        (
            additions.saturating_add(deletions) > LARGE_CHANGE_LINES,
            RiskSignal::Large,
        ),
        (LOCKFILE_NAMES.contains(&name), RiskSignal::Lockfile),
        (is_generated(&dirs, name), RiskSignal::Generated),
    ];
    rules
        .into_iter()
        .filter_map(|(hit, signal)| hit.then_some(signal))
        .collect()
}

/// Whether any added line of a text patch looks like a credential. Patches whose
/// new side is above the text cap are not scanned.
pub fn added_lines_hold_secret(patch: &Patch<'_>) -> bool {
    let Some(patterns) = SECRET_PATTERNS.as_ref() else {
        return false;
    };
    if patch.delta().new_file().size() > MAX_TEXT_SIDE_BYTES {
        return false;
    }
    (0..patch.num_hunks()).any(|hunk| {
        let count = patch.num_lines_in_hunk(hunk).unwrap_or(0);
        (0..count)
            .filter_map(|line| patch.line_in_hunk(hunk, line).ok())
            .filter(|line| line.origin() == '+')
            .any(|line| patterns.is_match(&String::from_utf8_lossy(line.content())))
    })
}

/// Adds `no-tests` to every changed source file under `src`/`lib`/`app` when no
/// test file changed anywhere in the same project.
pub fn mark_untested_sources(files: &mut [ChangeSummary]) {
    if files.iter().any(|file| is_test_path(&file.path)) {
        return;
    }
    for file in files.iter_mut().filter(|file| is_untested_source(file)) {
        file.risk.push(RiskSignal::NoTests);
        file.risk.sort();
    }
}

/// The oldest modification time among changed files still present in the
/// worktree: how long the project has been sitting dirty.
pub fn oldest_changed_mtime(workdir: &Path, statuses: &Statuses<'_>) -> Option<SystemTime> {
    let deleted = Status::WT_DELETED | Status::INDEX_DELETED;
    statuses
        .iter()
        .filter(|entry| !entry.status().intersects(deleted))
        .filter_map(|entry| entry.path().ok().map(|path| workdir.join(path)))
        .filter_map(|path| std::fs::symlink_metadata(path).ok()?.modified().ok())
        .min()
}

/// The agent whose marker in the repository root was touched most recently.
pub fn agent_marker(workdir: &Path) -> Option<String> {
    AGENT_MARKERS
        .iter()
        .filter_map(|(marker, agent)| {
            let modified = std::fs::symlink_metadata(workdir.join(marker))
                .ok()?
                .modified()
                .ok()?;
            Some((modified, *agent))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, agent)| agent.to_string())
}

/// Recomputes `dirty_age_seconds` from the stored dirty-since time, so a cached
/// row still reports the age as of now.
pub fn refresh_dirty_age(status: &mut ProjectStatus) {
    status.dirty_age_seconds = status.dirty_since.map(seconds_since);
}

/// Whole seconds from `since` to now; a clock that went backwards reads as zero.
fn seconds_since(since: SystemTime) -> u64 {
    SystemTime::now()
        .duration_since(since)
        .map(|age| age.as_secs())
        .unwrap_or(0)
}

/// Directory segments and the file name of a lowercase repository-relative path.
fn split_path(lower: &str) -> (Vec<&str>, &str) {
    let mut segments: Vec<&str> = lower.split('/').collect();
    let name = segments.pop().unwrap_or_default();
    (segments, name)
}

fn is_env_file(name: &str) -> bool {
    name == ".env" || name == ".envrc" || name.starts_with(".env.")
}

fn is_auth_path(path: &str) -> bool {
    path_words(path)
        .iter()
        .any(|word| AUTH_WORDS.contains(&word.as_str()))
}

fn is_migration(dirs: &[&str], name: &str) -> bool {
    let numbered_sql = name.ends_with(".sql") && name.starts_with(|c: char| c.is_ascii_digit());
    numbered_sql || dirs.iter().any(|dir| MIGRATION_SEGMENTS.contains(dir))
}

fn is_generated(dirs: &[&str], name: &str) -> bool {
    dirs.iter().any(|dir| GENERATED_SEGMENTS.contains(dir))
        || name.contains(".generated.")
        || GENERATED_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let (dirs, name) = split_path(&lower);
    dirs.iter().any(|dir| TEST_SEGMENTS.contains(dir))
        || TEST_NAME_MARKERS.iter().any(|marker| name.contains(marker))
}

fn is_untested_source(file: &ChangeSummary) -> bool {
    let lower = file.path.to_ascii_lowercase();
    let (dirs, name) = split_path(&lower);
    let extension = name.rsplit_once('.').map(|(_, extension)| extension);
    file.status != FileChangeStatus::Deleted
        && dirs.iter().any(|dir| SOURCE_ROOTS.contains(dir))
        && extension.is_some_and(|extension| SOURCE_EXTENSIONS.contains(&extension))
        && !is_generated(&dirs, name)
}

/// Lowercase words of a path, split on punctuation and camelCase boundaries, so
/// `src/AuthProvider.tsx` yields `auth` and `provider`.
fn path_words(path: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for ch in path.chars() {
        let boundary = !ch.is_ascii_alphanumeric() || (ch.is_ascii_uppercase() && previous_lower);
        if boundary && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        }
        previous_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }
    words.push(current);
    words
}
