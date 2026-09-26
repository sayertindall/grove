//! `grove://` links. Two shapes, each segment percent-encoded so a path's own `/`
//! never splits it:
//!
//! - `grove://project/<canonical project path>`
//! - `grove://project/<canonical project path>/file/<repository-relative path>`
//!
//! Opening one emits `grove://navigate` `{ project, file, registered }` to the
//! webview and brings the window forward. A project that is not registered is
//! reported with `registered: false` and never registered here. A link that
//! arrives before the webview listens (a cold start from the link) waits in
//! `PendingNavigation` until the webview takes it.
//!
//! macOS registers the scheme from the installed bundle's `Info.plist`, so links
//! only reach a built app in /Applications, never `pnpm tauri dev`.

use std::path::{Component, Path};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::config::load_project_paths;

/// The event the webview navigates on.
pub const NAVIGATE_EVENT: &str = "grove://navigate";

const PROJECT_PREFIX: &str = "grove://project/";
const FILE_SEGMENT: &str = "file";

/// What a link names, decoded and shape-checked but not yet resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLinkTarget {
    pub project: String,
    pub file: Option<String>,
}

/// Where the webview should go. `project` is the stored project path when the
/// project is registered, otherwise the path the link named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    pub project: String,
    pub file: Option<String>,
    pub registered: bool,
}

/// The last navigation the webview has not taken yet.
#[derive(Default)]
pub struct PendingNavigation(Mutex<Option<Navigation>>);

/// Parses a `grove://project/...` link. Anything else — another host, an
/// unencoded path, a query or fragment, a relative project, a file path that is
/// absolute or climbs out with `..` — is an error naming the problem.
pub fn parse_deep_link(url: &str) -> Result<DeepLinkTarget, String> {
    let rest = url
        .strip_prefix(PROJECT_PREFIX)
        .ok_or_else(|| format!("{url}: not a grove://project/ link"))?;
    if rest.contains(['?', '#']) {
        return Err(format!("{url}: a query or fragment is not part of a link"));
    }
    let segments: Vec<&str> = rest.split('/').collect();
    let (project, file) = match segments.as_slice() {
        [project] => (*project, None),
        [project, FILE_SEGMENT, file] => (*project, Some(*file)),
        _ => {
            return Err(format!(
                "{url}: expected project/<path>[/file/<path>], each percent-encoded"
            ))
        }
    };
    Ok(DeepLinkTarget {
        project: decode_project(url, project)?,
        file: file.map(|file| decode_file(url, file)).transpose()?,
    })
}

fn decode_segment(url: &str, segment: &str) -> Result<String, String> {
    let decoded = percent_decode_str(segment)
        .decode_utf8()
        .map_err(|_| format!("{url}: a path segment is not UTF-8"))?;
    if decoded.is_empty() || decoded.contains('\0') {
        return Err(format!("{url}: a path segment is empty or holds NUL"));
    }
    Ok(decoded.into_owned())
}

fn decode_project(url: &str, segment: &str) -> Result<String, String> {
    let project = decode_segment(url, segment)?;
    if !Path::new(&project).is_absolute() {
        return Err(format!("{url}: the project path must be absolute"));
    }
    Ok(project)
}

fn decode_file(url: &str, segment: &str) -> Result<String, String> {
    let file = decode_segment(url, segment)?;
    let inside = Path::new(&file)
        .components()
        .all(|component| matches!(component, Component::Normal(_)));
    if !inside {
        return Err(format!(
            "{url}: the file path must be relative to the project, without `.` or `..`"
        ));
    }
    Ok(file)
}

/// Matches the link's project against the stored list, first verbatim (a
/// project whose directory is gone still matches), then by canonical form (a
/// symlinked `/tmp` names the same project as `/private/tmp`).
pub fn resolve_navigation(target: DeepLinkTarget, registered: &[String]) -> Navigation {
    let canonical = |path: &str| std::fs::canonicalize(path).ok();
    let wanted = canonical(&target.project);
    let stored = registered.iter().find(|stored| {
        **stored == target.project || (wanted.is_some() && canonical(stored) == wanted)
    });
    Navigation {
        project: stored.cloned().unwrap_or(target.project),
        file: target.file,
        registered: stored.is_some(),
    }
}

/// Listens for links and handles the one the app was launched with, if any.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open_link(&handle, url.as_str());
        }
    });
    match app.deep_link().get_current() {
        Ok(urls) => urls
            .into_iter()
            .flatten()
            .for_each(|url| open_link(app, url.as_str())),
        Err(error) => eprintln!("deep link at launch: {error}"),
    }
}

fn open_link<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let target = match parse_deep_link(url) {
        Ok(target) => target,
        Err(error) => return eprintln!("{error}"),
    };
    let registered = load_project_paths(app).unwrap_or_else(|error| {
        eprintln!("{error}");
        Vec::new()
    });
    navigate(app, resolve_navigation(target, &registered));
}

/// Hands a navigation to the webview: kept for `take_pending_navigation`,
/// emitted for a webview already listening, and the window brought forward.
pub fn navigate<R: Runtime>(app: &AppHandle<R>, navigation: Navigation) {
    if let Some(pending) = app.try_state::<PendingNavigation>() {
        *pending
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(navigation.clone());
    }
    if let Err(error) = app.emit(NAVIGATE_EVENT, navigation) {
        eprintln!("{NAVIGATE_EVENT}: {error}");
    }
    crate::main_window::show(app);
}

/// The navigation that arrived before the webview listened, once. The webview
/// calls it after subscribing to `grove://navigate`; navigating twice to the
/// same place is harmless.
#[tauri::command]
pub fn take_pending_navigation(pending: State<'_, PendingNavigation>) -> Option<Navigation> {
    pending
        .0
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take()
}
