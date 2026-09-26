//! The native menu bar. Every Grove item emits one webview event,
//! `grove://menu` `{ id }`, and the webview decides what it does; the ids are
//! `MENU_ITEM_IDS`, mirrored by the `MenuItemId` union in `src/types/menu.ts`.
//! Clipboard, window, hide, and quit items are the platform's own, so ⌘C/⌘V work
//! in text inputs and the Window menu behaves natively.
//!
//! Single-key shortcuts (J/K/N/P/V, Esc) carry no accelerator here: a menu key
//! equivalent without a modifier would swallow that letter while typing in the
//! chat or a search field. The webview keeps handling those keys itself.

use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// The one event every Grove menu item emits.
pub const MENU_EVENT: &str = "grove://menu";

/// Every id a menu item can emit, in menu order. `src/types/menu.ts` mirrors it.
pub const MENU_ITEM_IDS: [&str; 37] = [
    "grove.check-for-updates",
    "grove.settings",
    "file.add-projects",
    "file.reveal-in-finder",
    "file.open-in-editor",
    "view.toggle-diff-layout",
    "view.toggle-wrap",
    "view.toggle-whitespace",
    "view.theme-system",
    "view.theme-light",
    "view.theme-dark",
    "view.toggle-chat",
    "view.toggle-sidebar",
    "view.reload",
    "navigate.next-file",
    "navigate.previous-file",
    "navigate.next-hunk",
    "navigate.previous-hunk",
    "navigate.mark-file-viewed",
    "navigate.command-palette",
    "navigate.go-to-project",
    "navigate.search-files",
    "navigate.project-1",
    "navigate.project-2",
    "navigate.project-3",
    "navigate.project-4",
    "navigate.project-5",
    "navigate.project-6",
    "navigate.project-7",
    "navigate.project-8",
    "navigate.project-9",
    "assistant.explain-file",
    "assistant.explain-repo",
    "assistant.since-last-viewed",
    "assistant.draft-commit-message",
    "assistant.cancel-turn",
    "help.keyboard-shortcuts",
];

/// The platform's own items: they act natively and emit nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeItem {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    Fullscreen,
}

/// Which submenu macOS adopts as the Window or Help menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmenuRole {
    Plain,
    Window,
    Help,
}

/// One row of the menu bar layout.
#[derive(Debug)]
pub enum MenuEntry {
    Item {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
    },
    Native(NativeItem),
    Separator,
    Submenu {
        title: &'static str,
        role: SubmenuRole,
        entries: &'static [MenuEntry],
    },
}

const fn item(id: &'static str, label: &'static str) -> MenuEntry {
    MenuEntry::Item {
        id,
        label,
        accelerator: None,
    }
}

const fn keyed(id: &'static str, label: &'static str, accelerator: &'static str) -> MenuEntry {
    MenuEntry::Item {
        id,
        label,
        accelerator: Some(accelerator),
    }
}

const fn submenu(title: &'static str, entries: &'static [MenuEntry]) -> MenuEntry {
    MenuEntry::Submenu {
        title,
        role: SubmenuRole::Plain,
        entries,
    }
}

use MenuEntry::{Native, Separator};

/// The whole menu bar, top level first. The first submenu is the app menu.
pub const MENU_BAR: &[MenuEntry] = &[
    submenu(
        "Grove",
        &[
            Native(NativeItem::About),
            item("grove.check-for-updates", "Check for Updates…"),
            Separator,
            keyed("grove.settings", "Settings…", "CmdOrCtrl+Comma"),
            Separator,
            Native(NativeItem::Services),
            Separator,
            Native(NativeItem::Hide),
            Native(NativeItem::HideOthers),
            Native(NativeItem::ShowAll),
            Separator,
            Native(NativeItem::Quit),
        ],
    ),
    submenu(
        "File",
        &[
            keyed("file.add-projects", "Add Projects…", "CmdOrCtrl+O"),
            Separator,
            keyed(
                "file.reveal-in-finder",
                "Reveal in Finder",
                "CmdOrCtrl+Shift+R",
            ),
            keyed("file.open-in-editor", "Open in Editor", "CmdOrCtrl+Enter"),
            Separator,
            Native(NativeItem::CloseWindow),
        ],
    ),
    submenu(
        "Edit",
        &[
            Native(NativeItem::Undo),
            Native(NativeItem::Redo),
            Separator,
            Native(NativeItem::Cut),
            Native(NativeItem::Copy),
            Native(NativeItem::Paste),
            Native(NativeItem::SelectAll),
        ],
    ),
    submenu(
        "View",
        &[
            keyed(
                "view.toggle-diff-layout",
                "Unified / Split",
                "CmdOrCtrl+Backslash",
            ),
            item("view.toggle-wrap", "Wrap / Scroll"),
            item("view.toggle-whitespace", "Hide Whitespace"),
            Separator,
            submenu(
                "Theme",
                &[
                    item("view.theme-system", "System"),
                    item("view.theme-light", "Light"),
                    item("view.theme-dark", "Dark"),
                ],
            ),
            Separator,
            keyed("view.toggle-chat", "Toggle Chat", "CmdOrCtrl+L"),
            item("view.toggle-sidebar", "Toggle Sidebar"),
            Separator,
            keyed("view.reload", "Reload", "CmdOrCtrl+R"),
            Native(NativeItem::Fullscreen),
        ],
    ),
    submenu(
        "Navigate",
        &[
            item("navigate.next-file", "Next File (K)"),
            item("navigate.previous-file", "Previous File (J)"),
            item("navigate.next-hunk", "Next Hunk (N)"),
            item("navigate.previous-hunk", "Previous Hunk (P)"),
            item("navigate.mark-file-viewed", "Mark File Viewed (V)"),
            Separator,
            keyed(
                "navigate.command-palette",
                "Command Palette…",
                "CmdOrCtrl+K",
            ),
            keyed("navigate.go-to-project", "Go to Project…", "CmdOrCtrl+P"),
            keyed("navigate.search-files", "Search Files", "CmdOrCtrl+F"),
            Separator,
            submenu(
                "Projects",
                &[
                    keyed("navigate.project-1", "Project 1", "CmdOrCtrl+1"),
                    keyed("navigate.project-2", "Project 2", "CmdOrCtrl+2"),
                    keyed("navigate.project-3", "Project 3", "CmdOrCtrl+3"),
                    keyed("navigate.project-4", "Project 4", "CmdOrCtrl+4"),
                    keyed("navigate.project-5", "Project 5", "CmdOrCtrl+5"),
                    keyed("navigate.project-6", "Project 6", "CmdOrCtrl+6"),
                    keyed("navigate.project-7", "Project 7", "CmdOrCtrl+7"),
                    keyed("navigate.project-8", "Project 8", "CmdOrCtrl+8"),
                    keyed("navigate.project-9", "Project 9", "CmdOrCtrl+9"),
                ],
            ),
        ],
    ),
    submenu(
        "Assistant",
        &[
            keyed("assistant.explain-file", "Explain File", "CmdOrCtrl+E"),
            item("assistant.explain-repo", "Explain Repo"),
            item("assistant.since-last-viewed", "Since Last Viewed"),
            item("assistant.draft-commit-message", "Draft Commit Message"),
            Separator,
            item("assistant.cancel-turn", "Cancel Turn (Esc)"),
        ],
    ),
    MenuEntry::Submenu {
        title: "Window",
        role: SubmenuRole::Window,
        entries: &[Native(NativeItem::Minimize), Native(NativeItem::Zoom)],
    },
    MenuEntry::Submenu {
        title: "Help",
        role: SubmenuRole::Help,
        entries: &[keyed(
            "help.keyboard-shortcuts",
            "Keyboard Shortcuts",
            "CmdOrCtrl+Slash",
        )],
    },
];

/// Every Grove item id in `entries`, depth first, in menu order.
pub fn layout_item_ids(entries: &[MenuEntry]) -> Vec<&'static str> {
    entries
        .iter()
        .flat_map(|entry| match entry {
            MenuEntry::Item { id, .. } => vec![*id],
            MenuEntry::Submenu { entries, .. } => layout_item_ids(entries),
            MenuEntry::Native(_) | MenuEntry::Separator => Vec::new(),
        })
        .collect()
}

/// Builds the menu bar from `MENU_BAR`. Passed to `Builder::menu`.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let items = build_entries(app, MENU_BAR)?;
    Menu::with_items(app, &borrowed(&items))
}

/// Forwards a Grove item's click to the webview. Tray items and native items
/// arrive here too (menu events are app-wide); only the ids in `MENU_ITEM_IDS`
/// are forwarded.
pub fn forward<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    let Some(id) = MENU_ITEM_IDS.iter().find(|known| **known == id) else {
        return;
    };
    if let Err(error) = app.emit(MENU_EVENT, MenuPayload { id }) {
        eprintln!("{MENU_EVENT}: {error}");
    }
}

#[derive(Clone, Serialize)]
struct MenuPayload {
    id: &'static str,
}

type BoxedItem<R> = Box<dyn IsMenuItem<R>>;

fn borrowed<R: Runtime>(items: &[BoxedItem<R>]) -> Vec<&dyn IsMenuItem<R>> {
    items.iter().map(|item| item.as_ref()).collect()
}

fn build_entries<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[MenuEntry],
) -> tauri::Result<Vec<BoxedItem<R>>> {
    entries
        .iter()
        .map(|entry| build_entry(app, entry))
        .collect()
}

fn build_entry<R: Runtime>(app: &AppHandle<R>, entry: &MenuEntry) -> tauri::Result<BoxedItem<R>> {
    Ok(match entry {
        MenuEntry::Item {
            id,
            label,
            accelerator,
        } => Box::new(MenuItem::with_id(app, *id, *label, true, *accelerator)?),
        MenuEntry::Native(native) => Box::new(native_item(app, *native)?),
        MenuEntry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
        MenuEntry::Submenu {
            title,
            role,
            entries,
        } => Box::new(build_submenu(app, title, *role, entries)?),
    })
}

fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    role: SubmenuRole,
    entries: &[MenuEntry],
) -> tauri::Result<Submenu<R>> {
    let items = build_entries(app, entries)?;
    let submenu = Submenu::with_items(app, title, true, &borrowed(&items))?;
    #[cfg(target_os = "macos")]
    match role {
        SubmenuRole::Window => submenu.set_as_windows_menu_for_nsapp()?,
        SubmenuRole::Help => submenu.set_as_help_menu_for_nsapp()?,
        SubmenuRole::Plain => {}
    }
    #[cfg(not(target_os = "macos"))]
    let _ = role;
    Ok(submenu)
}

fn native_item<R: Runtime>(
    app: &AppHandle<R>,
    native: NativeItem,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match native {
        NativeItem::About => PredefinedMenuItem::about(app, Some("About Grove"), None),
        NativeItem::Services => PredefinedMenuItem::services(app, None),
        NativeItem::Hide => PredefinedMenuItem::hide(app, Some("Hide Grove")),
        NativeItem::HideOthers => PredefinedMenuItem::hide_others(app, None),
        NativeItem::ShowAll => PredefinedMenuItem::show_all(app, None),
        NativeItem::Quit => PredefinedMenuItem::quit(app, Some("Quit Grove")),
        NativeItem::CloseWindow => PredefinedMenuItem::close_window(app, None),
        NativeItem::Undo => PredefinedMenuItem::undo(app, None),
        NativeItem::Redo => PredefinedMenuItem::redo(app, None),
        NativeItem::Cut => PredefinedMenuItem::cut(app, None),
        NativeItem::Copy => PredefinedMenuItem::copy(app, None),
        NativeItem::Paste => PredefinedMenuItem::paste(app, None),
        NativeItem::SelectAll => PredefinedMenuItem::select_all(app, None),
        NativeItem::Minimize => PredefinedMenuItem::minimize(app, None),
        NativeItem::Zoom => PredefinedMenuItem::maximize(app, Some("Zoom")),
        NativeItem::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
    }
}
