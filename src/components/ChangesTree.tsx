import type { FileTreeRowDecoration, GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";

import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { joinProjectFile } from "@/lib/projects";
import { runPathAction } from "@/lib/path-actions";
import type { ChangeSummary, FileChangeStatus } from "@/types/grove";

const GIT_STATUS: Record<FileChangeStatus, GitStatus> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "untracked",
  // The tree has no conflict or submodule status; both are content changes to it.
  conflicted: "modified",
  submodule: "modified",
};

const menuItemClass =
  "flex min-h-7 w-full cursor-default items-center rounded-sm px-2 py-1 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent";

interface ChangesTreeProps {
  title: string;
  projectPath: string;
  changes: ChangeSummary[];
  selectedPath: string | null;
  isPending: boolean;
  errorMessage: string | null;
  themeType: "dark" | "light";
  width: number;
  autoSelect: boolean;
  searchRef: MutableRefObject<(() => void) | null>;
  onSelectChange: (path: string) => void;
}

export function ChangesTree({
  title,
  projectPath,
  changes,
  selectedPath,
  isPending,
  errorMessage,
  themeType,
  width,
  autoSelect,
  searchRef,
  onSelectChange,
}: ChangesTreeProps) {
  const paths = useMemo(() => changes.map((change) => change.path), [changes]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => changes.map((change) => ({ path: change.path, status: GIT_STATUS[change.status] })),
    [changes],
  );
  const changesByPath = useMemo<Record<string, ChangeSummary>>(
    () => Object.fromEntries(changes.map((change) => [change.path, change])),
    [changes],
  );

  const changesRef = useRef(changes);
  const changesByPathRef = useRef(changesByPath);
  const selectionRef = useRef(onSelectChange);
  const ignoreFocusRef = useRef(false);
  useEffect(() => {
    changesRef.current = changes;
    changesByPathRef.current = changesByPath;
  }, [changes, changesByPath]);
  useEffect(() => {
    selectionRef.current = onSelectChange;
  }, [onSelectChange]);

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,
    search: true,
    initialExpansion: "open",
    gitStatus,
    renderRowDecoration: ({ item }) => {
      const change = changesByPathRef.current[item.path];
      return change === undefined ? null : rowDecorationForChange(change);
    },
    onSelectionChange: (selected) => {
      const next = selected.find((path) => changesRef.current.some((entry) => entry.path === path));
      if (next !== undefined) selectionRef.current(next);
    },
  });

  useEffect(() => {
    searchRef.current = () => model.openSearch();
    return () => {
      searchRef.current = null;
    };
  }, [model, searchRef]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Arrow keys move focus. A focused file becomes the sole selection, which is
  // what the diff follows. Directories stay out of that selection.
  useEffect(() => {
    let syncing = false;
    return model.subscribe(() => {
      if (syncing || ignoreFocusRef.current) return;
      const focused = model.getFocusedItem();
      if (focused === null || focused.isDirectory()) return;
      const path = focused.getPath();
      const selected = model.getSelectedPaths();
      if (selected.length === 1 && selected[0] === path) return;
      syncing = true;
      try {
        for (const current of selected) {
          if (current !== path) model.getItem(current)?.deselect();
        }
        if (!focused.isSelected()) focused.select();
      } finally {
        syncing = false;
      }
    });
  }, [model]);

  // Applying the app's selection moves the tree's selection and focus itself; the
  // focus-follows-selection sync above must not read those intermediate states
  // (focus still on a row being deselected) as a user move and re-select it.
  useEffect(() => {
    ignoreFocusRef.current = true;
    try {
      if (selectedPath === null) {
        for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
        return;
      }
      const item = model.getItem(selectedPath);
      if (item === null || item.isDirectory()) return;
      const selected = model.getSelectedPaths();
      if (!(selected.length === 1 && selected[0] === selectedPath)) {
        for (const path of selected) {
          if (path !== selectedPath) model.getItem(path)?.deselect();
        }
        if (!item.isSelected()) item.select();
      }
      if (model.getFocusedPath() !== selectedPath) model.focusPath(selectedPath);
      model.scrollToPath(selectedPath, { offset: "nearest", focus: false });
    } finally {
      ignoreFocusRef.current = false;
    }
  }, [model, selectedPath, paths]);

  useEffect(() => {
    if (!autoSelect) return;
    if (
      selectedPath !== null &&
      changesRef.current.some((change) => change.path === selectedPath)
    ) {
      return;
    }
    const visible = model.getVisibleRows(0, model.getVisibleCount());
    const firstVisible = visible.find((row) => row.kind === "file")?.path;
    const fallback = [...changesRef.current].sort((left, right) =>
      left.path.localeCompare(right.path),
    )[0]?.path;
    const next = firstVisible ?? fallback;
    if (next !== undefined) selectionRef.current(next);
  }, [autoSelect, model, paths, selectedPath]);

  return (
    <section
      aria-label="Changed files"
      style={{ width }}
      className="flex h-full shrink-0 flex-col bg-background"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        {isPending ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Loading…
          </span>
        ) : errorMessage === null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {changes.length} {changes.length === 1 ? "file" : "files"}
          </span>
        ) : null}
      </header>
      {errorMessage !== null ? (
        <div className="p-3">
          <Alert variant="error">
            <AlertTitle>Changes could not be read</AlertTitle>
            <AlertDescription className="font-mono text-xs">{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : (
        <FileTree
          model={model}
          className="min-h-0 flex-1"
          style={{ colorScheme: themeType }}
          renderContextMenu={(item, context) => (
            <div
              className="min-w-40 rounded-lg border border-border bg-popover p-1 shadow-lg/5"
              data-file-tree-context-menu-root="true"
            >
              <TreeMenuButton
                label="Reveal in Finder"
                onClick={() => {
                  context.close();
                  void runPathAction("reveal", joinProjectFile(projectPath, item.path));
                }}
              />
              <TreeMenuButton
                label="Open"
                onClick={() => {
                  context.close();
                  void runPathAction("open", joinProjectFile(projectPath, item.path));
                }}
              />
              <TreeMenuButton
                label="Copy path"
                onClick={() => {
                  context.close();
                  void runPathAction("copy", joinProjectFile(projectPath, item.path));
                }}
              />
            </div>
          )}
        />
      )}
    </section>
  );
}

function TreeMenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={menuItemClass} onClick={onClick}>
      {label}
    </button>
  );
}

function rowDecorationForChange(change: ChangeSummary): FileTreeRowDecoration {
  const markers = [
    change.oldPath !== null ? "R" : null,
    change.staged ? "S" : null,
    change.binary ? "B" : null,
  ].filter((marker): marker is string => marker !== null);
  const parts = [
    markers.length > 0 ? { text: markers.join("") } : null,
    change.additions > 0
      ? { text: `+${change.additions}`, color: "var(--success-foreground)" }
      : null,
    change.deletions > 0
      ? { text: `−${change.deletions}`, color: "var(--destructive-foreground)" }
      : null,
  ].filter((part): part is { text: string; color?: string } => part !== null);
  const title = [
    change.oldPath !== null ? `Renamed from ${change.oldPath}` : null,
    change.staged && change.unstaged ? "Partially staged" : change.staged ? "Staged" : null,
    change.binary ? "Binary" : null,
    change.additions > 0 || change.deletions > 0
      ? `+${change.additions} −${change.deletions}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return {
    text: parts.map((part) => part.text).join(" "),
    title,
    parts: parts.length > 0 ? parts : undefined,
  };
}
