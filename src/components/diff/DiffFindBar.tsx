import { useEffect, useRef } from "react";

import type { DiffLineTarget } from "@/components/diff/diffMetadata";
import type { DiffHunk } from "@/types/grove";

/** Every hunk row containing `query` (case-insensitive), in display order. */
export function findDiffMatches(hunks: readonly DiffHunk[], query: string): DiffLineTarget[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const matches: DiffLineTarget[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (!line.text.toLowerCase().includes(needle)) continue;
      if (line.kind === "del" && line.oldNo !== null)
        matches.push({ line: line.oldNo, side: "deletions" });
      else if (line.newNo !== null) matches.push({ line: line.newNo, side: "additions" });
    }
  }
  return matches;
}

interface DiffFindBarProps {
  query: string;
  matchIndex: number;
  matchCount: number;
  onQueryChange: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}

/** In-pane find: Enter / ⇧Enter cycle, Escape closes and hands focus back to the diff. */
export function DiffFindBar({
  query,
  matchIndex,
  matchCount,
  onQueryChange,
  onStep,
  onClose,
}: DiffFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const status =
    query.trim() === ""
      ? ""
      : matchCount === 0
        ? "No matches"
        : `${matchIndex + 1} of ${matchCount}`;
  return (
    <div
      role="search"
      aria-label="Find in diff"
      className="absolute top-2 right-4 z-20 flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1 shadow-md"
    >
      <input
        ref={inputRef}
        value={query}
        aria-label="Find in diff"
        placeholder="Find in diff"
        className="h-6 w-48 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span
        data-find-status
        className="min-w-16 text-right text-2xs text-muted-foreground"
        aria-live="polite"
      >
        {status}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        className="flex size-6 items-center justify-center rounded-md text-sm text-foreground hover:bg-accent disabled:opacity-40"
        disabled={matchCount === 0}
        onClick={() => onStep(-1)}
      >
        ‹
      </button>
      <button
        type="button"
        aria-label="Next match"
        className="flex size-6 items-center justify-center rounded-md text-sm text-foreground hover:bg-accent disabled:opacity-40"
        disabled={matchCount === 0}
        onClick={() => onStep(1)}
      >
        ›
      </button>
      <button
        type="button"
        aria-label="Close find"
        className="flex size-6 items-center justify-center rounded-md text-xs text-muted-foreground hover:bg-accent"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
