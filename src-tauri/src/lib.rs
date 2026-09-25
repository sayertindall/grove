pub mod commands;
pub mod config;
pub mod discovery;
pub mod git;
pub mod watch;

use std::sync::Mutex;

use tauri::Manager;

use crate::commands::replace_registered_projects;
use crate::config::load_project_paths;
use crate::watch::ProjectWatcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Mutex::new(ProjectWatcher::default()))
        .invoke_handler(tauri::generate_handler![
            commands::scan_for_repos,
            commands::list_projects,
            commands::get_project_status,
            commands::set_projects,
            commands::list_changes,
            commands::get_file_diff,
            commands::reveal_in_finder,
            commands::open_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = load_project_paths(&handle).unwrap_or_else(|error| {
                eprintln!("{error}");
                Vec::new()
            });

            // The same function the command calls, so startup is not a second writer
            // of the store or of the watcher.
            let watcher = app.state::<Mutex<ProjectWatcher>>();
            if let Err(error) = replace_registered_projects(&handle, paths, watcher.inner()) {
                eprintln!("{error}");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running grove");
}
