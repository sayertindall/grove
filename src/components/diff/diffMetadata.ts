import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useWorkerPool, type CodeViewReactOptions } from "@pierre/diffs/react";
import { useEffect } from "react";

import {
  diffContextLines,
  type DiffContextChoice,
  type LineDiffType,
} from "@/components/diff/diffPreferences";
import { DIFF_THEMES } from "@/diffsWorker";
import type { DiffOverflow, DiffStyle } from "@/lib/storage";
import type { FileDiff } from "@/types/grove";

/** Unchanged lines revealed per ↑/↓ click on a hunk separator. */
const EXPANSION_LINE_COUNT = 20;
/** Gaps this short render inline instead of behind a separator. */
const COLLAPSED_CONTEXT_THRESHOLD = 2;

/**
 * Restyles the library's `line-info` separators into the Grove bar:
 * `⋯ N unchanged lines · expand ↑ ↓ all`. Runs inside each diff's shadow root, in the
 * last cascade layer, so every rule is scoped to the one wrapper the library shows
 * (old-side gutter in split, the single gutter in unified).
 */
const BAR = `:is([data-deletions], [data-unified]) [data-gutter] [data-separator="line-info"] [data-separator-wrapper]`;
const SEPARATOR_CSS = `
${BAR} {
  display: flex; align-items: center; gap: 4px; padding-inline: 12px 0;
  background: var(--muted); color: var(--muted-foreground);
  font-family: var(--font-sans, system-ui, sans-serif); font-size: 12px;
  border-block: 1px solid var(--border);
}
[data-additions] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
  background: var(--muted); border-block: 1px solid var(--border); border-radius: 0;
}
${BAR}::before { content: "⋯"; font-size: 14px; font-weight: 600; margin-right: 8px; }
${BAR} [data-separator-content] {
  order: 0; flex: none; padding: 0; background: transparent; border-radius: 0;
}
${BAR} [data-separator-content]::after { content: "· expand"; margin-inline: 8px 4px; }
${BAR} [data-expand-button] {
  order: 1; display: flex; align-self: center; height: 20px; min-width: 0; padding: 0 6px;
  border: 0; border-radius: 4px; background: var(--input); color: var(--foreground);
  font-size: 11px; font-weight: 500;
}
${BAR} [data-expand-button]:hover { background: var(--accent); }
${BAR} [data-expand-button] [data-icon] { display: none; }
${BAR} [data-expand-up]::before { content: "↑"; }
${BAR} [data-expand-down]::before { content: "↓"; }
${BAR} [data-expand-both]::before { content: "all"; }
${BAR} [data-expand-all-button] { order: 2; font-size: 0; }
${BAR} [data-expand-all-button]::before { content: "all"; font-size: 11px; }
`;

/** Where one diff row sits: its 1-based line on the old (`deletions`) or new (`additions`) side. */
export interface DiffLineTarget {
  line: number;
  side: "additions" | "deletions";
}

/**
 * CSS for tinted row ranges inside the diff's shadow root. Each rule targets both the
 * code row and its gutter number on the given side, in split and unified layouts.
 */
export function rowHighlightCSS(rows: readonly DiffLineTarget[], declarations: string): string {
  if (rows.length === 0) return "";
  const selectors = rows.flatMap(({ line, side }) => {
    const unifiedRow =
      side === "deletions"
        ? `[data-line-type="change-deletion"]`
        : `:not([data-line-type="change-deletion"])`;
    return [
      `[data-${side}] [data-line="${line}"]`,
      `[data-${side}] [data-column-number="${line}"]`,
      `[data-unified] [data-line="${line}"]${unifiedRow}`,
      `[data-unified] [data-column-number="${line}"]${unifiedRow}`,
    ];
  });
  return `${selectors.join(",\n")} { ${declarations} }\n`;
}

/** The CodeView options every Grove diff shares; `extraCSS` layers highlights on top. */
export function diffCodeViewOptions<LAnnotation>({
  themeType,
  diffStyle,
  overflow,
  lineDiffType,
  extraCSS = "",
}: {
  themeType: "dark" | "light";
  diffStyle: DiffStyle;
  overflow: DiffOverflow;
  lineDiffType: LineDiffType;
  extraCSS?: string;
}): CodeViewReactOptions<LAnnotation, undefined> {
  return {
    theme: DIFF_THEMES,
    themeType,
    diffStyle,
    overflow,
    lineDiffType,
    disableFileHeader: true,
    hunkSeparators: "line-info",
    expandUnchanged: false,
    expansionLineCount: EXPANSION_LINE_COUNT,
    collapsedContextThreshold: COLLAPSED_CONTEXT_THRESHOLD,
    unsafeCSS: SEPARATOR_CSS + extraCSS,
    onPostRender: (node: HTMLElement) => relabelUnchangedRuns(node),
  };
}

/** The library prints "N unmodified lines"; Grove's separators say "unchanged". */
function relabelUnchangedRuns(host: HTMLElement): void {
  for (const label of host.shadowRoot?.querySelectorAll("[data-unmodified-lines]") ?? []) {
    const text = label.textContent ?? "";
    if (text.includes("unmodified")) label.textContent = text.replace("unmodified", "unchanged");
  }
}

/**
 * Pushes the intra-line comparison mode into the shared highlighting pool. The pool's
 * render options win over per-view options, so every mounted diff follows this value.
 */
export function useLineDiffType(lineDiffType: LineDiffType): void {
  const pool = useWorkerPool();
  useEffect(() => {
    void pool?.setRenderOptions({ lineDiffType });
  }, [pool, lineDiffType]);
}

/** True when the backend withheld a text side (too large) that the file's status implies. */
export function textSideMissingByPolicy(file: FileDiff): boolean {
  if (file.binary || file.image !== null || file.patch === "") return false;
  switch (file.status) {
    case "added":
    case "untracked":
      return file.newContents === null;
    case "deleted":
      return file.oldContents === null;
    case "modified":
    case "renamed":
    case "conflicted":
      return file.oldContents === null || file.newContents === null;
    case "submodule":
      return false;
  }
}

/**
 * The renderable diff for one file: both sides re-diffed in the page (so unchanged runs
 * can expand), or the backend patch when a side was withheld.
 */
export function buildDiffMetadata(
  file: FileDiff,
  ignoreWhitespace: boolean,
  context: DiffContextChoice,
): FileDiffMetadata | null {
  if (file.binary || file.image !== null || file.submodule !== null) return null;
  if (textSideMissingByPolicy(file) || (file.oldContents === null && file.newContents === null)) {
    if (file.patch.trim() === "") return null;
    return parsePatchFiles(file.patch, file.path)[0]?.files[0] ?? null;
  }
  const oldFile =
    file.oldContents === null
      ? null
      : { name: file.oldPath ?? file.path, contents: file.oldContents };
  const newFile =
    file.newContents === null ? null : { name: file.path, contents: file.newContents };
  return parseDiffFromFile(oldFile, newFile, {
    context: diffContextLines(context),
    ignoreWhitespace,
  });
}

/** Changes whenever what the diff renders changes; a refetch with equal content keeps it. */
export function diffContentKey(
  file: FileDiff,
  ignoreWhitespace: boolean,
  context: DiffContextChoice,
): string {
  return [
    String(ignoreWhitespace),
    context,
    file.path,
    file.oldPath ?? "",
    file.view,
    file.status,
    file.patch,
    file.oldContents ?? "",
    file.newContents ?? "",
    file.image?.oldDataUrl ?? "",
    file.image?.newDataUrl ?? "",
    String(file.oldMode),
    String(file.newMode),
  ].join("\0");
}
