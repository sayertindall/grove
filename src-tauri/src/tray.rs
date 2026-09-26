//! The menu-bar tray: a template sprout, a `Grove · N dirty` tooltip, and a menu
//! of the dirty projects. The designed popover is realized as this native menu
//! for now (no custom window, so no positioner). Rows come from the same read as
//! `list_projects` and refresh whenever the watcher emits
//! `grove://projects-changed` or the project list in the store changes.

use std::sync::Mutex;

use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Listener, Manager, Runtime};

use crate::commands::read_registered_projects;
use crate::config::PROJECTS_KEY;
use crate::deep_link::{navigate, Navigation};
use crate::git::{ProjectState, ProjectStatus};
use crate::repo_cache::RepoCache;
use crate::watch::{watching_paths, ProjectWatcher, PROJECTS_CHANGED_EVENT};

const TRAY_ID: &str = "grove-tray";
const OPEN_ID: &str = "tray:open";
const QUIT_ID: &str = "tray:quit";
/// A project row's id is this prefix and the stored project path.
const PROJECT_ID_PREFIX: &str = "tray:project:";
const STORE_CHANGE_EVENT: &str = "store://change";

/// The tooltip for `dirty` dirty projects.
pub fn tray_tooltip(dirty: usize) -> String {
    format!("Grove · {dirty} dirty")
}

/// One dirty project's row: `name · +additions −deletions`.
pub fn project_row_label(status: &ProjectStatus) -> String {
    format!(
        "{} · +{} −{}",
        status.display_name, status.additions, status.deletions
    )
}

/// The projects the tray lists: dirty ones, in stored order. Missing and
/// unreadable projects are not dirty.
pub fn dirty_projects(rows: &[ProjectStatus]) -> Vec<&ProjectStatus> {
    rows.iter()
        .filter(|row| row.state == ProjectState::Dirty)
        .collect()
}

/// Creates the tray and subscribes it to the refresh triggers.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = tray_menu(app, &[])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/tray/tray@2x.png"))
        .icon_as_template(true)
        .tooltip("Grove")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;
    let handle = app.clone();
    app.listen(PROJECTS_CHANGED_EVENT, move |_| refresh(&handle));
    let handle = app.clone();
    app.listen(STORE_CHANGE_EVENT, move |event| {
        let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap_or_default();
        if payload["key"] == PROJECTS_KEY {
            refresh(&handle);
        }
    });
    refresh(app);
    Ok(())
}

/// Re-reads the projects off the main thread and swaps the menu and tooltip.
fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let watching = watching_paths(app.state::<Mutex<ProjectWatcher>>().inner());
        let rows = read_registered_projects(&app, &watching, app.state::<RepoCache>().inner())
            .await
            .unwrap_or_else(|error| {
                eprintln!("tray: {error}");
                Vec::new()
            });
        if let Err(error) = apply(&app, &rows) {
            eprintln!("tray: {error}");
        }
    });
}

fn apply<R: Runtime>(app: &AppHandle<R>, rows: &[ProjectStatus]) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let dirty = dirty_projects(rows);
    tray.set_menu(Some(tray_menu(app, &dirty)?))?;
    tray.set_tooltip(Some(tray_tooltip(dirty.len())))
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, dirty: &[&ProjectStatus]) -> tauri::Result<Menu<R>> {
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = vec![
        Box::new(MenuItem::with_id(
            app,
            OPEN_ID,
            "Open Grove",
            true,
            None::<&str>,
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    for status in dirty {
        let id = format!("{PROJECT_ID_PREFIX}{}", status.path);
        let label = project_row_label(status);
        items.push(Box::new(MenuItem::with_id(
            app,
            id,
            label,
            true,
            None::<&str>,
        )?));
    }
    if dirty.is_empty() {
        let clean = MenuItem::new(app, "No uncommitted changes", false, None::<&str>)?;
        items.push(Box::new(clean));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        QUIT_ID,
        "Quit Grove",
        true,
        None::<&str>,
    )?));
    let borrowed: Vec<&dyn IsMenuItem<R>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &borrowed)
}

/// Menu events are app-wide; only the tray's own ids are handled here.
fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(project) = id.strip_prefix(PROJECT_ID_PREFIX) {
        let navigation = Navigation {
            project: project.to_string(),
            file: None,
            registered: true,
        };
        return navigate(app, navigation);
    }
    match id {
        OPEN_ID => crate::main_window::show(app),
        QUIT_ID => app.exit(0),
        _ => {}
    }
}
