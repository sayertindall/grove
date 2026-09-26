// Mirrors `MENU_ITEM_IDS` in src-tauri/src/menu.rs, in menu order. A cargo test
// (`tests/distribution.rs`) fails when the two lists differ.

/** The webview event every native menu item emits, with payload `MenuEvent`. */
export const MENU_EVENT = "grove://menu";

export const MENU_ITEM_IDS = [
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
] as const;

export type MenuItemId = (typeof MENU_ITEM_IDS)[number];

export interface MenuEvent {
  id: MenuItemId;
}

/** `grove://navigate`: a `grove://` link or a tray row asked for this place. */
export const NAVIGATE_EVENT = "grove://navigate";

export interface Navigation {
  /** The stored project path when registered, otherwise the path the link named. */
  project: string;
  /** Repository-relative file to select, when the link named one. */
  file: string | null;
  /** False: show an inline notice; the project is not registered by a link. */
  registered: boolean;
}

/** `check_for_update` result when a newer signed release exists. */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
}
