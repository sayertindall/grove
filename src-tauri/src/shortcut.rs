//! The system-wide shortcut that shows or hides the window, `Cmd+Shift+G` unless
//! the user picked another. The choice lives in the store plugin's
//! `preferences.json` under `preferences.globalShortcut`.

use std::str::FromStr;

use serde_json::json;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;

use crate::config::store_file_path;
use crate::error::GroveError;

pub const DEFAULT_GLOBAL_SHORTCUT: &str = "CmdOrCtrl+Shift+G";
const PREFERENCES_STORE_FILE: &str = "preferences.json";
const GLOBAL_SHORTCUT_KEY: &str = "preferences.globalShortcut";

/// Parses a shortcut such as `Cmd+Shift+G` or `Alt+Space`. It must hold a
/// Command, Control, or Option modifier: a bare key, or one with only Shift,
/// would fire system-wide while the user types in any app.
pub fn parse_global_shortcut(text: &str) -> Result<Shortcut, GroveError> {
    let shortcut = Shortcut::from_str(text.trim())
        .map_err(|error| GroveError::usage(format!("`{text}` is not a shortcut: {error}")))?;
    let anchors = Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT;
    if !shortcut.mods.intersects(anchors) {
        return Err(GroveError::usage(format!(
            "`{text}` needs Command, Control, or Option: it would fire while typing in any app"
        )));
    }
    Ok(shortcut)
}

/// The plugin, with one handler for every shortcut Grove registers.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::main_window::toggle(app);
            }
        })
        .build()
}

/// Registers the stored shortcut at startup. A stored value that no longer
/// parses, or that another app holds, is logged and the default is tried.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let stored = stored_shortcut(app).unwrap_or_else(|error| {
        eprintln!("{error}");
        DEFAULT_GLOBAL_SHORTCUT.to_string()
    });
    if let Err(error) = register(app, &stored) {
        eprintln!("global shortcut `{stored}`: {error}");
        if stored != DEFAULT_GLOBAL_SHORTCUT {
            register(app, DEFAULT_GLOBAL_SHORTCUT)
                .unwrap_or_else(|error| eprintln!("global shortcut: {error}"));
        }
    }
}

fn stored_shortcut<R: Runtime>(app: &AppHandle<R>) -> Result<String, GroveError> {
    let store = app
        .store(store_file_path(PREFERENCES_STORE_FILE))
        .map_err(|error| GroveError::store(format!("{PREFERENCES_STORE_FILE}: {error}")))?;
    Ok(store
        .get(GLOBAL_SHORTCUT_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| DEFAULT_GLOBAL_SHORTCUT.to_string()))
}

fn save_shortcut<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<(), GroveError> {
    let store = app
        .store(store_file_path(PREFERENCES_STORE_FILE))
        .map_err(|error| GroveError::store(format!("{PREFERENCES_STORE_FILE}: {error}")))?;
    store.set(GLOBAL_SHORTCUT_KEY, json!(text));
    store
        .save()
        .map_err(|error| GroveError::store(format!("{PREFERENCES_STORE_FILE}: {error}")))
}

/// Replaces whatever Grove holds with `text`. Grove registers one shortcut only.
fn register<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<(), GroveError> {
    let shortcut = parse_global_shortcut(text)?;
    let manager = app.global_shortcut();
    manager
        .unregister_all()
        .and_then(|()| manager.register(shortcut))
        .map_err(|error| GroveError::usage(format!("`{text}` could not be registered: {error}")))
}

#[tauri::command]
pub async fn get_global_shortcut<R: Runtime>(app: AppHandle<R>) -> Result<String, GroveError> {
    stored_shortcut(&app)
}

/// Registers `shortcut`, then stores it. An unparsable shortcut is rejected
/// untouched; one the system refuses (another app holds it) puts the previous
/// shortcut back. Returns the stored text.
#[tauri::command]
pub async fn set_global_shortcut<R: Runtime>(
    app: AppHandle<R>,
    shortcut: String,
) -> Result<String, GroveError> {
    let text = shortcut.trim().to_string();
    parse_global_shortcut(&text)?;
    let previous = stored_shortcut(&app)?;
    if let Err(error) = register(&app, &text) {
        register(&app, &previous).unwrap_or_else(|error| eprintln!("global shortcut: {error}"));
        return Err(error);
    }
    save_shortcut(&app, &text)?;
    Ok(text)
}
