//! Signed in-app updates from the GitHub release's `latest.json`. Nothing checks
//! on its own: the only request is the one the user starts from the menu.
//!
//! The public key is `plugins.updater.pubkey` in `tauri.conf.json`, an empty
//! placeholder in the repository that the release workflow fills from
//! `TAURI_SIGNING_PUBLIC_KEY`; the same variable, when set at compile time,
//! also overrides it here. A build with neither refuses to check, because an
//! update it downloaded could not be verified.

use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::GroveError;

const UPDATER_PUBKEY: Option<&str> = option_env!("TAURI_SIGNING_PUBLIC_KEY");

fn pubkey() -> Option<&'static str> {
    UPDATER_PUBKEY.filter(|key| !key.trim().is_empty())
}

/// The plugin, with the compiled-in key replacing the config placeholder.
pub fn plugin<R: Runtime>() -> TauriPlugin<R, tauri_plugin_updater::Config> {
    let builder = tauri_plugin_updater::Builder::new();
    match pubkey() {
        Some(key) => builder.pubkey(key),
        None => builder,
    }
    .build()
}

/// A newer release than the running one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

fn update_error(error: impl std::fmt::Display) -> GroveError {
    GroveError::Io {
        context: "update".to_string(),
        source: std::io::Error::other(error.to_string()),
    }
}

/// Whether this build can verify an update: a compiled-in key or a configured one.
fn has_signing_key<R: Runtime>(app: &AppHandle<R>) -> bool {
    let configured = app.config().plugins.0.get("updater").and_then(|updater| {
        updater
            .get("pubkey")
            .and_then(|key| key.as_str())
            .filter(|key| !key.trim().is_empty())
    });
    pubkey().is_some() || configured.is_some()
}

async fn find_update<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, GroveError> {
    if !has_signing_key(app) {
        return Err(update_error(
            "this build carries no update signing key; install a release build",
        ));
    }
    let updater = app.updater().map_err(update_error)?;
    updater.check().await.map_err(update_error)
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<AvailableUpdate>, GroveError> {
    Ok(find_update(&app).await?.map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    }))
}

/// Downloads, verifies, and installs the newest release, then relaunches.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), GroveError> {
    let Some(update) = find_update(&app).await? else {
        return Err(update_error("Grove is already up to date"));
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(update_error)?;
    app.restart()
}
