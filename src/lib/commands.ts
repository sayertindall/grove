import type { MenuItemId } from "@/types/menu";

/**
 * One id space for everything the user can ask Grove to do: the native menu
 * emits its ids, the palette lists them, and keyboard shortcuts run them.
 * `PaletteOnlyId`s have no native menu item.
 */
export type PaletteOnlyId = "view.toggle-history";
export type CommandId = MenuItemId | PaletteOnlyId;

export interface CommandSpec {
  id: CommandId;
  title: string;
  /**
   * Accelerator in the menu's own notation: `Mod+K`, `Mod+Shift+R`, `Mod+Comma`.
   * A shortcut without `Mod` (`K`, `Escape`) is shown but never bound here: the
   * view that owns it handles the bare key so typing in a field is unaffected.
   */
  shortcut?: string;
  /** False keeps the command out of the palette's Actions scope. */
  palette?: boolean;
  /**
   * Focus inside an element matching this selector keeps the keystroke for
   * itself (the diff pane's own find bar, a text field's ⌘↩).
   */
  focusOwner?: string;
}

export interface GroveCommand extends CommandSpec {
  run: () => void;
}

/** Whatever the app can do right now, by command id. Missing ids have no handler yet. */
export type CommandHandlers = Partial<Record<CommandId, () => void>>;

/** ⌘1…⌘9: the nth visible project, in sidebar order. */
export const PROJECT_SLOT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
  (slot) => `navigate.project-${slot}` as CommandId,
);

export const COMMAND_SPECS: readonly CommandSpec[] = [
  { id: "navigate.command-palette", title: "Command Palette", shortcut: "Mod+K", palette: false },
  { id: "navigate.go-to-project", title: "Go to Project…", shortcut: "Mod+P", palette: false },
  {
    id: "navigate.search-files",
    title: "Search Files",
    shortcut: "Mod+F",
    focusOwner: "[data-diff-pane]",
  },
  { id: "navigate.next-file", title: "Next File", shortcut: "K" },
  { id: "navigate.previous-file", title: "Previous File", shortcut: "J" },
  { id: "navigate.next-hunk", title: "Next Hunk", shortcut: "N" },
  { id: "navigate.previous-hunk", title: "Previous Hunk", shortcut: "P" },
  { id: "navigate.mark-file-viewed", title: "Mark File Viewed", shortcut: "V" },
  { id: "file.add-projects", title: "Add Projects…", shortcut: "Mod+O" },
  { id: "file.reveal-in-finder", title: "Reveal in Finder", shortcut: "Mod+Shift+R" },
  {
    id: "file.open-in-editor",
    title: "Open in Editor",
    shortcut: "Mod+Enter",
    focusOwner: "input, textarea, [contenteditable='true']",
  },
  { id: "view.toggle-diff-layout", title: "Toggle Unified / Split", shortcut: "Mod+Backslash" },
  { id: "view.toggle-wrap", title: "Toggle Wrap / Scroll" },
  { id: "view.toggle-whitespace", title: "Toggle Hide Whitespace" },
  { id: "view.toggle-chat", title: "Toggle Chat", shortcut: "Mod+L" },
  { id: "view.toggle-sidebar", title: "Toggle Sidebar" },
  { id: "view.theme-system", title: "Theme: System" },
  { id: "view.theme-light", title: "Theme: Light" },
  { id: "view.theme-dark", title: "Theme: Dark" },
  { id: "view.toggle-history", title: "Toggle File History", shortcut: "Mod+Y" },
  { id: "view.reload", title: "Reload", shortcut: "Mod+R" },
  { id: "assistant.explain-file", title: "Explain File", shortcut: "Mod+E" },
  { id: "assistant.explain-repo", title: "Explain Repo" },
  { id: "assistant.since-last-viewed", title: "Since Last Viewed" },
  { id: "assistant.draft-commit-message", title: "Draft Commit Message" },
  { id: "assistant.cancel-turn", title: "Cancel Turn", shortcut: "Escape", palette: false },
  { id: "grove.settings", title: "Settings…", shortcut: "Mod+Comma" },
  { id: "grove.check-for-updates", title: "Check for Updates…" },
  { id: "help.keyboard-shortcuts", title: "Keyboard Shortcuts", shortcut: "Mod+Slash" },
  ...PROJECT_SLOT_IDS.map((id, index): CommandSpec => ({
    id,
    title: `Project ${index + 1}`,
    shortcut: `Mod+${index + 1}`,
    palette: false,
  })),
];

/** The registry: every spec that has a handler, in spec order. */
export function buildCommands(handlers: CommandHandlers): GroveCommand[] {
  return COMMAND_SPECS.flatMap((spec) => {
    const run = handlers[spec.id];
    return run === undefined ? [] : [{ ...spec, run }];
  });
}

const KEY_GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Ctrl: "⌃",
  Comma: ",",
  Backslash: "\\",
  Slash: "/",
  Enter: "↩",
  Escape: "esc",
};

/** Keycaps for display: `Mod+Shift+R` → `["⌘", "⇧", "R"]`. */
export function shortcutKeys(shortcut: string): string[] {
  return shortcut.split("+").map((part) => KEY_GLYPHS[part] ?? part);
}

const KEY_CODES: Record<string, string> = {
  Comma: "Comma",
  Backslash: "Backslash",
  Slash: "Slash",
  Enter: "Enter",
};

function keyCode(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return KEY_CODES[key] ?? key;
}

/** Whether a keydown is exactly this `Mod+…` shortcut. Bare-key shortcuts never match. */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+");
  if (!parts.includes("Mod")) return false;
  const key = parts[parts.length - 1] ?? "";
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey === parts.includes("Shift") &&
    event.altKey === parts.includes("Alt") &&
    event.code === keyCode(key)
  );
}
