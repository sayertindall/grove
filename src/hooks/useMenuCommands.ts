import { useCallback, useEffect, useRef } from "react";

import { listenForMenu } from "@/api/app";
import { matchesShortcut, type CommandId, type GroveCommand } from "@/lib/commands";

/**
 * A menu accelerator and the webview's own keydown can both see one keystroke;
 * a second run of the same command inside this window is the same press.
 */
const SAME_PRESS_MS = 250;

const reportedWithoutHandler = new Set<CommandId>();

/**
 * Binds the command registry to the native menu (`grove://menu`) and to its
 * `Mod+…` shortcuts in the webview, so a keystroke, a menu click, and a palette
 * pick all run the same `run`. Returns the dispatcher for other callers.
 */
export function useMenuCommands(commands: readonly GroveCommand[]): (id: CommandId) => void {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const lastRunRef = useRef<{ id: CommandId; at: number } | null>(null);

  const runCommand = useCallback((id: CommandId) => {
    const command = commandsRef.current.find((entry) => entry.id === id);
    if (command === undefined) {
      if (!reportedWithoutHandler.has(id)) {
        reportedWithoutHandler.add(id);
        console.info(`grove: no handler for "${id}" yet`);
      }
      return;
    }
    const now = performance.now();
    const last = lastRunRef.current;
    if (last !== null && last.id === id && now - last.at < SAME_PRESS_MS) return;
    lastRunRef.current = { id, at: now };
    command.run();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listenForMenu((event) => runCommand(event.id))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Without the menu bridge the webview shortcuts below still work.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [runCommand]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = commandsRef.current.find(
        (entry) => entry.shortcut !== undefined && matchesShortcut(event, entry.shortcut),
      );
      if (command === undefined) return;
      const target = event.target;
      const owner = command.focusOwner;
      if (owner !== undefined && target instanceof Element && target.closest(owner) !== null) {
        return;
      }
      event.preventDefault();
      runCommand(command.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCommand]);

  return runCommand;
}
