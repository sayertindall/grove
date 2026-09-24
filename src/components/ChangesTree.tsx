import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeRowDecoration, GitStatus, GitStatusEntry } from "@pierre/trees";
import { useEffect, useMemo, useRef } from "react";

import type { FileChange, FileChangeStatus } from "@/types/grove";

/** The tree's built-in status set. Grove never invents a staged git status. */
const GIT_STATUS: Record<FileChangeStatus, GitStatus> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "untracked",
};

interface ChangesTreeProps {
  title: string;
  changes: FileChange[];
  selectedPath: string | null;
  themeType: "dark" | "light";
  onSelectChange: (path: string) => void;
}

export function ChangesTree({
  title,
  changes,
  selectedPath,
  themeType,
  onSelectChange,
}: ChangesTreeProps) {
  const paths = useMemo(() => changes.map((change) => change.path), [changes]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      changes.map((change) => ({
        path: change.path,
        status: GIT_STATUS[change.status],
      })),
    [changes],
  );

  // The model is created once, so the row decoration and the selection callback read
  // through refs instead of closing over the first render's data.
  const changesRef = useRef(changes);
  const selectionRef = useRef(onSelectChange);
  useEffect(() => {
    changesRef.current = changes;
  }, [changes]);
  useEffect(() => {
    selectionRef.current = onSelectChange;
  }, [onSelectChange]);

  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    gitStatus,
    renderRowDecoration: ({ item }) => {
      const change = changesRef.current.find((entry) => entry.path === item.path);
      return change === undefined ? null : rowDecorationForChange(change);
    },
    onSelectionChange: (selected) => {
      const next = selected[0];
      if (next !== undefined) {
        selectionRef.current(next);
      }
    },
  });

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  useEffect(() => {
    if (selectedPath !== null) {
      model.scrollToPath(selectedPath, { offset: "nearest" });
    }
  }, [model, selectedPath]);

  return (
    <section className="flex h-full w-70 shrink-0 flex-col border-r border-border bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {changes.length} {changes.length === 1 ? "file" : "files"}
        </span>
      </header>
      <FileTree model={model} className="min-h-0 flex-1" style={{ colorScheme: themeType }} />
    </section>
  );
}

/**
 * The decoration lane: the rename source, the staged flag, and the binary flag, in
 * that order. The tree carries the status itself.
 */
function rowDecorationForChange(change: FileChange): FileTreeRowDecoration {
  const reason =
    change.oldPath !== null
      ? `${change.staged ? "staged, from" : "from"} ${change.oldPath}`
      : change.staged
        ? "staged"
        : null;
  const text = [reason, change.binary ? "binary" : null]
    .filter((part): part is string => part !== null)
    .join(", ");
  const title =
    change.oldPath !== null
      ? change.staged
        ? "Staged rename"
        : "Renamed"
      : change.staged
        ? "Staged in the index"
        : "Binary file";

  return { text, title };
}
