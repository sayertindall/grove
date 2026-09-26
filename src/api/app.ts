import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeCommand, toError } from "@/api/invoke";
import {
  MENU_EVENT,
  NAVIGATE_EVENT,
  type AvailableUpdate,
  type MenuEvent,
  type Navigation,
} from "@/types/menu";

/** A newer signed release, or null when this build is current. Asks only when called. */
export function checkForUpdate(): Promise<AvailableUpdate | null> {
  return invokeCommand<AvailableUpdate | null>("check_for_update");
}

/** Downloads, verifies, and installs the release, then relaunches Grove. */
export function installUpdate(): Promise<void> {
  return invokeCommand<void>("install_update");
}

/** The accelerator that brings Grove forward from anywhere, e.g. `CmdOrCtrl+Shift+G`. */
export function getGlobalShortcut(): Promise<string> {
  return invokeCommand<string>("get_global_shortcut");
}

/** Registers and stores a new global accelerator; rejects with code `usage` when unusable. */
export function setGlobalShortcut(shortcut: string): Promise<string> {
  return invokeCommand<string>("set_global_shortcut", { shortcut });
}

/** Every native menu item click arrives here as its id. */
export async function listenForMenu(onItem: (event: MenuEvent) => void): Promise<UnlistenFn> {
  try {
    return await listen<MenuEvent>(MENU_EVENT, (event) => {
      onItem(event.payload);
    });
  } catch (error) {
    throw toError(error);
  }
}

/** Every `grove://` link and tray row, once the app is running. */
export async function listenForNavigate(
  onNavigate: (navigation: Navigation) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<Navigation>(NAVIGATE_EVENT, (event) => {
      onNavigate(event.payload);
    });
  } catch (error) {
    throw toError(error);
  }
}

/** The link that launched Grove, taken once (then cleared); null when there was none. */
export function takePendingNavigation(): Promise<Navigation | null> {
  return invokeCommand<Navigation | null>("take_pending_navigation");
}
