//! Showing and hiding the one window, for the tray, the global shortcut, deep
//! links, and a second launch. Failures are logged: none of these callers has a
//! place to report one.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// The label of the window `tauri.conf.json` declares.
pub const MAIN_WINDOW: &str = "main";

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let window = app.get_webview_window(MAIN_WINDOW);
    if window.is_none() {
        eprintln!("window `{MAIN_WINDOW}` is gone");
    }
    window
}

/// Brings the window forward: shown, restored if minimized, focused.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let shown = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus());
    if let Err(error) = shown {
        eprintln!("showing the window: {error}");
    }
}

/// Hides the window when it is visible and focused; otherwise brings it forward.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let frontmost = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if !frontmost {
        return show(app);
    }
    if let Err(error) = window.hide() {
        eprintln!("hiding the window: {error}");
    }
}
