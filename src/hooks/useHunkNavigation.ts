import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DiffLineTarget } from "@/components/diff/diffMetadata";
import type { DiffHunk, FileDiff } from "@/types/grove";

export interface HunkNavigation {
  /** 0-based current hunk; 0 when the file has none. */
  index: number;
  count: number;
  next: () => void;
  prev: () => void;
  /** Scrolls to a new-side line and makes the hunk around it current. */
  scrollTo: (line: number) => void;
}

/** The first changed row of a hunk; a pure-deletion hunk anchors on the old side. */
export function hunkAnchor(hunk: DiffHunk): DiffLineTarget {
  const changed = hunk.lines.find((line) => line.kind !== "context");
  if (
    changed?.kind === "del" &&
    changed.oldNo !== null &&
    !hunk.lines.some((line) => line.kind === "add")
  ) {
    return { line: changed.oldNo, side: "deletions" };
  }
  const added = hunk.lines.find((line) => line.kind === "add");
  return { line: added?.newNo ?? changed?.newNo ?? hunk.newStart, side: "additions" };
}

/** The hunk covering a new-side line, else the last hunk starting before it. */
function hunkIndexForLine(hunks: readonly DiffHunk[], line: number): number {
  let found = 0;
  hunks.forEach((hunk, index) => {
    if (hunk.newStart <= line) found = index;
  });
  return found;
}

/**
 * Previous/next hunk over `FileDiff.hunks`. The index resets when another file or view
 * is shown and is clamped when a refresh changes the hunk count.
 */
export function useHunkNavigation(
  diff: FileDiff | null,
  scrollToTarget: (target: DiffLineTarget) => void,
): HunkNavigation {
  const hunks = useMemo(() => diff?.hunks ?? [], [diff]);
  const identity = diff === null ? null : `${diff.path}\0${diff.view}`;
  const [index, setIndex] = useState(0);
  const identityRef = useRef(identity);
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    setIndex(0);
  }, [identity]);

  const count = hunks.length;
  const current = Math.min(index, Math.max(count - 1, 0));
  const goTo = useCallback(
    (target: number) => {
      const hunk = hunks[target];
      if (hunk === undefined) return;
      setIndex(target);
      scrollToTarget(hunkAnchor(hunk));
    },
    [hunks, scrollToTarget],
  );
  const next = useCallback(() => goTo(Math.min(current + 1, count - 1)), [goTo, current, count]);
  const prev = useCallback(() => goTo(Math.max(current - 1, 0)), [goTo, current]);
  const scrollTo = useCallback(
    (line: number) => {
      if (count > 0) setIndex(hunkIndexForLine(hunks, line));
      scrollToTarget({ line, side: "additions" });
    },
    [hunks, count, scrollToTarget],
  );
  return { index: current, count, next, prev, scrollTo };
}
