#[cfg(debug_assertions)]
mod automation;
pub mod chat;
pub mod cli;
pub mod commands;
pub mod config;
pub mod deep_link;
pub mod discovery;
pub mod error;
pub mod git;
mod main_window;
pub mod mcp;
pub mod menu;
pub mod repo_cache;
pub mod review;
pub mod shortcut;
pub mod tray;
mod updater;
pub mod watch;

use std::sync::Mutex;

use tauri::Manager;

use crate::commands::replace_registered_projects;
use crate::config::load_project_paths;
use crate::watch::ProjectWatcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Debug builds driven by the automation socket run hidden: no window, no Dock
    // icon, never frontmost. Window-state restore would show and focus the window.
    #[cfg(debug_assertions)]
    let headless = automation::requested();
    #[cfg(not(debug_assertions))]
    let headless = false;
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    automation::hide_windows(&mut context);

    // Headless automation runs skip everything that reaches past the hidden
    // window: single-instance would hand the run to the user's own Grove (same
    // identifier), and the tray, global shortcut, and deep links would land on
    // their screen and keyboard.
    let mut builder = tauri::Builder::default();
    if !headless {
        // Registered first, so a second launch reaches the running app (and, on
        // Windows/Linux, forwards its `grove://` argument to deep-link) before
        // any other plugin starts.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                main_window::show(app)
            }))
            .plugin(tauri_plugin_deep_link::init())
            .plugin(shortcut::plugin());
    }
    builder = builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(updater::plugin())
        .menu(menu::build)
        .on_menu_event(menu::forward);
    if !headless {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }
    #[allow(unused_mut)]
    let mut app = builder
        .manage(Mutex::new(ProjectWatcher::default()))
        .manage(repo_cache::RepoCache::default())
        .manage(deep_link::PendingNavigation::default())
        .invoke_handler(tauri::generate_handler![
            commands::scan_for_repos,
            commands::list_projects,
            commands::get_project_status,
            commands::set_projects,
            commands::list_changes,
            commands::get_file_diff,
            commands::reveal_in_finder,
            commands::open_path,
            commands::list_reviewed,
            commands::set_reviewed,
            commands::blame_file,
            commands::file_history,
            commands::chat_settings,
            commands::set_chat_settings,
            commands::chat_key_status,
            commands::set_chat_key,
            commands::clear_chat_key,
            commands::chat_history,
            commands::chat_send,
            commands::chat_cancel,
            commands::chat_clear,
            commands::chat_preview,
            commands::chat_usage,
            commands::chat_cli_status,
            deep_link::take_pending_navigation,
            shortcut::get_global_shortcut,
            shortcut::set_global_shortcut,
            updater::check_for_update,
            updater::install_update,
        ])
        .setup(move |app| {
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

            if !headless {
                deep_link::install(app.handle());
                shortcut::install(app.handle());
                if let Err(error) = tray::install(app.handle()) {
                    eprintln!("tray: {error}");
                }
            }

            #[cfg(debug_assertions)]
            automation::install(app);

            Ok(())
        })
        .build(context)
        .expect("error while building grove");
    #[cfg(debug_assertions)]
    automation::prohibit_activation(&mut app);
    app.run(|_, _| {});
}
