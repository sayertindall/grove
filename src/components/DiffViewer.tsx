import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { HistoryIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";

import { DiffFindBar, findDiffMatches } from "@/components/diff/DiffFindBar";
import { DiffFooter } from "@/components/diff/DiffFooter";
import {
  buildDiffMetadata,
  diffCodeViewOptions,
  diffContentKey,
  rowHighlightCSS,
  textSideMissingByPolicy,
  useLineDiffType,
  type DiffLineTarget,
} from "@/components/diff/diffMetadata";
import type { DiffContextChoice, LineDiffType } from "@/components/diff/diffPreferences";
import { ConflictView } from "@/components/ConflictView";
import { HistoryPanel } from "@/components/HistoryPanel";
import { ImageDiff } from "@/components/ImageDiff";
import { SubmoduleView } from "@/components/SubmoduleView";
import { PathContextItems } from "@/components/PathContextItems";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { useHunkNavigation } from "@/hooks/useHunkNavigation";
import { joinProjectFile, modeChangeLabel } from "@/lib/projects";
import type { DiffOverflow, DiffStyle, ImageMode } from "@/lib/storage";
import type { ChangeSummary, DiffView, FileDiff } from "@/types/grove";

const VIEW_OPTIONS: SegmentedOption<DiffView>[] = [
  { value: "head", label: "Head" },
  { value: "staged", label: "Staged" },
  { value: "unstaged", label: "Unstaged" },
];

const STYLE_OPTIONS: SegmentedOption<DiffStyle>[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

const OVERFLOW_OPTIONS: SegmentedOption<DiffOverflow>[] = [
  { value: "wrap", label: "Wrap" },
  { value: "scroll", label: "Scroll" },
];

const CITATION_ROW_CSS =
  "background-color: color-mix(in srgb, var(--info) 16%, transparent) !important; box-shadow: inset 2px 0 0 var(--info);";
const MATCH_ROW_CSS =
  "background-color: color-mix(in srgb, var(--warning) 14%, transparent) !important;";
const CURRENT_MATCH_ROW_CSS =
  "outline: 1px solid var(--warning); outline-offset: -1px; background-color: color-mix(in srgb, var(--warning) 26%, transparent) !important;";

/** New-side lines an assistant answer cited; `label` is its chip text, e.g. "[2]". */
export interface DiffHighlightRange {
  start: number;
  end: number;
  label: string;
}

/** A line range the user selected and wants to ask the assistant about. */
export interface DiffLineSelection {
  start: number;
  end: number;
  side: "additions" | "deletions";
}

export interface DiffViewerHandle {
  /** Scrolls the new-side range into view, expanding collapsed context if needed. */
  scrollToLines: (start: number, end: number) => void;
  /** Menu and palette entry points for the same steps as `n` / `p`. */
  nextHunk: () => void;
  previousHunk: () => void;
}

interface CitationAnnotation {
  label: string;
}

interface DiffViewerProps {
  projectPath: string;
  summary: ChangeSummary | null;
  file: FileDiff | null;
  isPending: boolean;
  errorMessage: string | null;
  themeType: "dark" | "light";
  diffStyle: DiffStyle;
  overflow: DiffOverflow;
  ignoreWhitespace: boolean;
  view: DiffView;
  /** False for untracked files, which only have a Head view. */
  tracked: boolean;
  lineDiffType: LineDiffType;
  diffContext: DiffContextChoice;
  highlightRange?: DiffHighlightRange | null;
  ref?: Ref<DiffViewerHandle>;
  onDiffStyleChange: (style: DiffStyle) => void;
  onOverflowChange: (overflow: DiffOverflow) => void;
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void;
  onViewChange: (view: DiffView) => void;
  onLineDiffTypeChange: (lineDiffType: LineDiffType) => void;
  onDiffContextChange: (context: DiffContextChoice) => void;
  onAskAboutLines?: (selection: DiffLineSelection) => void;
  imageMode: ImageMode;
  onImageModeChange: (mode: ImageMode) => void;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
}

export function DiffViewer({
  projectPath,
  summary,
  file,
  isPending,
  errorMessage,
  themeType,
  diffStyle,
  overflow,
  ignoreWhitespace,
  view,
  tracked,
  lineDiffType,
  diffContext,
  highlightRange = null,
  ref,
  onDiffStyleChange,
  onOverflowChange,
  onIgnoreWhitespaceChange,
  onViewChange,
  onLineDiffTypeChange,
  onDiffContextChange,
  onAskAboutLines,
  imageMode,
  onImageModeChange,
  historyOpen,
  onHistoryOpenChange,
}: DiffViewerProps) {
  useLineDiffType(lineDiffType);
  const codeViewRef = useRef<CodeViewHandle<CitationAnnotation, undefined>>(null);
  const paneRef = useRef<HTMLElement>(null);
  const metadata = useMemo(
    () => (file === null ? null : buildDiffMetadata(file, ignoreWhitespace, diffContext)),
    [file, ignoreWhitespace, diffContext],
  );
  const itemId = file === null ? null : `diff:${file.path}:${file.view}`;
  const citedEnd = highlightRange?.end ?? null;
  const citedLabel = highlightRange?.label ?? "";
  const annotationKey = citedEnd === null ? "" : `${citedEnd}:${citedLabel}`;
  const contentKey =
    file === null
      ? null
      : `${diffContentKey(file, ignoreWhitespace, diffContext)}\0${annotationKey}`;
  const versionRef = useRef(0);
  const keyRef = useRef<string | null>(null);
  if (contentKey !== keyRef.current) {
    keyRef.current = contentKey;
    versionRef.current += 1;
  }
  const version = versionRef.current;

  const items = useMemo(
    () =>
      itemId === null || metadata === null
        ? []
        : [
            {
              id: itemId,
              type: "diff" as const,
              fileDiff: metadata,
              version,
              annotations:
                citedEnd === null
                  ? undefined
                  : [
                      {
                        side: "additions" as const,
                        lineNumber: citedEnd,
                        metadata: { label: citedLabel },
                      },
                    ],
            },
          ],
    [itemId, metadata, version, citedEnd, citedLabel],
  );

  const scrollToTarget = useCallback(
    ({ line, side }: DiffLineTarget, align: "start" | "center" = "center") => {
      const handle = codeViewRef.current;
      if (handle === null || itemId === null) return;
      const rendered = handle.getInstance()?.getRenderedItems()[0];
      const instance = rendered?.type === "diff" ? rendered.instance : undefined;
      // A citation or match can sit in a folded run; unfold it before scrolling there.
      if (side === "additions" && instance !== undefined && !instance.isLineRenderable(line)) {
        instance.revealLine(line);
      }
      handle.scrollTo({ type: "line", id: itemId, lineNumber: line, side, align });
    },
    [itemId],
  );
  const scrollToHunk = useCallback(
    (target: DiffLineTarget) => scrollToTarget(target, "start"),
    [scrollToTarget],
  );
  const hunks = useHunkNavigation(file, scrollToHunk);

  const selectHunkAt = hunks.scrollTo;
  const scrollToLines = useCallback(
    (start: number, end: number) => {
      // Makes the covering hunk current and unfolds `start` if it sits in a folded run.
      selectHunkAt(start);
      const handle = codeViewRef.current;
      if (handle === null || itemId === null) return;
      handle.scrollTo({
        type: "range",
        id: itemId,
        range: { start, end, side: "additions", endSide: "additions" },
        align: "center",
      });
    },
    [selectHunkAt, itemId],
  );
  useImperativeHandle(
    ref,
    () => ({ scrollToLines, nextHunk: hunks.next, previousHunk: hunks.prev }),
    [scrollToLines, hunks.next, hunks.prev],
  );

  const find = useDiffFind(file, scrollToTarget, () => paneRef.current?.focus());
  const [selection, setSelection] = useState<DiffLineSelection | null>(null);
  useEffect(() => setSelection(null), [itemId]);

  const highlightStart = highlightRange?.start ?? null;
  const highlightEnd = highlightRange?.end ?? null;
  useEffect(() => {
    if (highlightStart === null || highlightEnd === null || metadata === null) return;
    const frame = requestAnimationFrame(() => scrollToLines(highlightStart, highlightEnd));
    return () => cancelAnimationFrame(frame);
    // Scroll once per citation, not on every refresh of the same file.
  }, [highlightStart, highlightEnd, itemId, metadata === null]);

  const highlightCSS = useMemo(() => {
    const cited: DiffLineTarget[] = [];
    if (highlightStart !== null && highlightEnd !== null) {
      for (let line = highlightStart; line <= highlightEnd; line += 1) {
        cited.push({ line, side: "additions" });
      }
    }
    const current = find.matches[find.index];
    return (
      rowHighlightCSS(find.open ? find.matches : [], MATCH_ROW_CSS) +
      rowHighlightCSS(cited, CITATION_ROW_CSS) +
      rowHighlightCSS(find.open && current !== undefined ? [current] : [], CURRENT_MATCH_ROW_CSS)
    );
  }, [highlightStart, highlightEnd, find.open, find.matches, find.index]);

  // Callers pass a fresh callback each render; only its presence changes the options.
  const canAsk = onAskAboutLines !== undefined;
  const options = useMemo(
    () => ({
      ...diffCodeViewOptions<CitationAnnotation>({
        themeType,
        diffStyle,
        overflow,
        lineDiffType,
        extraCSS: highlightCSS,
      }),
      enableLineSelection: canAsk,
      onLineSelectionEnd: (range: SelectedLineRange | null) => setSelection(toLineSelection(range)),
    }),
    [themeType, diffStyle, overflow, lineDiffType, highlightCSS, canAsk],
  );

  const askAboutSelection = () => {
    if (selection === null || onAskAboutLines === undefined) return;
    onAskAboutLines(selection);
    codeViewRef.current?.clearSelectedLines();
    setSelection(null);
  };

  const modeLabel = modeChangeLabel(
    file?.oldMode ?? summary?.oldMode ?? null,
    file?.newMode ?? summary?.newMode ?? null,
  );
  const conflict = file?.conflict ?? null;
  const submodule = file?.submodule ?? null;
  // Conflicts and submodules have their own views; none of the text-diff states apply.
  const ownView = conflict !== null || submodule !== null;
  const truncated = file !== null && !ownView && textSideMissingByPolicy(file);
  const image = file?.image ?? null;
  const binary = file?.binary === true && image === null && !ownView;
  const modeOnly =
    modeLabel !== null &&
    image === null &&
    !binary &&
    !ownView &&
    (metadata === null || metadata.hunks.length === 0);
  const showText =
    errorMessage === null &&
    !isPending &&
    items.length > 0 &&
    !modeOnly &&
    image === null &&
    !binary &&
    !ownView;
  const partial = summary !== null && summary.staged && summary.unstaged;
  const displayPath = summary ?? file;
  const absolutePath = displayPath === null ? null : joinProjectFile(projectPath, displayPath.path);

  useHunkKeys(showText && !find.open, hunks.next, hunks.prev);

  const onPaneKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "f" && showText) {
      event.preventDefault();
      event.stopPropagation();
      find.openBar();
    } else if (meta && event.key === "Enter" && selection !== null && onAskAboutLines) {
      event.preventDefault();
      askAboutSelection();
    } else if (
      find.open &&
      !meta &&
      !isTextEntry(event.target) &&
      event.key.toLowerCase() === "n"
    ) {
      event.preventDefault();
      find.step(event.shiftKey ? -1 : 1);
    }
  };

  return (
    <section
      ref={paneRef}
      data-diff-pane
      aria-label={summary === null ? "Diff" : `Diff of ${summary.path}`}
      tabIndex={-1}
      onKeyDown={onPaneKeyDown}
      className="relative flex h-full min-w-0 flex-1 flex-col bg-background outline-none"
    >
      {displayPath !== null ? (
        <header className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-border px-4">
          {absolutePath !== null ? (
            <ContextMenu>
              <ContextMenuTrigger className="min-w-0 truncate text-left font-mono text-[13px]">
                {displayPath.oldPath !== null
                  ? `${displayPath.oldPath} → ${displayPath.path}`
                  : displayPath.path}
              </ContextMenuTrigger>
              <ContextMenuPopup align="start">
                <PathContextItems path={absolutePath} />
              </ContextMenuPopup>
            </ContextMenu>
          ) : null}
          {summary !== null && summary.additions > 0 ? (
            <span className="shrink-0 font-mono text-2xs text-success-foreground">
              +{summary.additions}
            </span>
          ) : null}
          {summary !== null && summary.deletions > 0 ? (
            <span className="shrink-0 font-mono text-2xs text-destructive-foreground">
              −{summary.deletions}
            </span>
          ) : null}
          {partial ? (
            <Badge size="sm" variant="secondary">
              partially staged
            </Badge>
          ) : summary?.staged ? (
            <Badge size="sm" variant="secondary">
              staged
            </Badge>
          ) : null}
          {summary?.binary || file?.binary ? (
            <Badge size="sm" variant="warning">
              binary
            </Badge>
          ) : null}
          {truncated ? (
            <Badge size="sm" variant="warning">
              truncated by policy
            </Badge>
          ) : null}
          {modeLabel !== null ? (
            <Badge size="sm" variant="secondary">
              {modeLabel}
            </Badge>
          ) : null}
          <span className="min-w-0 flex-1" />
          {showText && hunks.count > 0 ? (
            <HunkNavigator
              index={hunks.index}
              count={hunks.count}
              onPrev={hunks.prev}
              onNext={hunks.next}
            />
          ) : null}
          {tracked ? (
            <SegmentedControl
              aria-label="Diff view"
              value={view}
              options={VIEW_OPTIONS}
              onValueChange={onViewChange}
            />
          ) : null}
          {showText ? (
            <>
              <SegmentedControl
                aria-label="Diff style"
                value={diffStyle}
                options={STYLE_OPTIONS}
                onValueChange={onDiffStyleChange}
              />
              <SegmentedControl
                aria-label="Line wrapping"
                value={overflow}
                options={OVERFLOW_OPTIONS}
                onValueChange={onOverflowChange}
              />
            </>
          ) : null}
          <Button
            size="xs"
            variant={historyOpen ? "secondary" : "ghost"}
            aria-pressed={historyOpen}
            title="File history (⌘Y)"
            onClick={() => onHistoryOpenChange(!historyOpen)}
          >
            <HistoryIcon />
            History
          </Button>
        </header>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {errorMessage !== null ? (
            <div className="p-3">
              <Alert variant="error">
                <AlertTitle>That diff could not be read</AlertTitle>
                <AlertDescription className="font-mono text-xs">{errorMessage}</AlertDescription>
              </Alert>
            </div>
          ) : isPending ? (
            <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Loading…
            </div>
          ) : displayPath === null ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No file selected</EmptyTitle>
                <EmptyDescription>
                  Pick a file from the tree to see its diff against HEAD.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : conflict !== null && file !== null ? (
            <ConflictView path={file.path} conflict={conflict} themeType={themeType} />
          ) : submodule !== null && file !== null ? (
            <SubmoduleView path={file.path} pointer={submodule} />
          ) : image !== null && file !== null ? (
            <ImageDiff
              image={image}
              path={file.path}
              mode={imageMode}
              onModeChange={onImageModeChange}
            />
          ) : binary ? (
            <p className="bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
              Binary files differ
            </p>
          ) : modeOnly ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Only the file mode changed; the contents are identical.
            </p>
          ) : showText && metadata !== null ? (
            <>
              <div className="relative flex min-h-0 flex-1 flex-col">
                {find.open ? (
                  <DiffFindBar
                    query={find.query}
                    matchIndex={find.index}
                    matchCount={find.matches.length}
                    onQueryChange={find.setQuery}
                    onStep={find.step}
                    onClose={find.close}
                  />
                ) : null}
                <CodeView<CitationAnnotation, undefined>
                  ref={codeViewRef}
                  className="min-h-0 flex-1 overflow-auto"
                  items={items}
                  options={options}
                  renderAnnotation={(annotation) =>
                    annotation.metadata === undefined ? null : (
                      <CitationMarker label={annotation.metadata.label} />
                    )
                  }
                />
                {selection !== null && onAskAboutLines !== undefined ? (
                  <button
                    type="button"
                    data-ask-about-lines
                    className="absolute right-4 bottom-4 z-20 flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-md hover:bg-accent"
                    onClick={askAboutSelection}
                  >
                    Ask about lines {selection.start}–{selection.end}
                    <kbd className="rounded-sm border border-border px-1 font-sans text-2xs text-muted-foreground">
                      ⌘⏎
                    </kbd>
                  </button>
                ) : null}
              </div>
              <DiffFooter
                diffContext={diffContext}
                ignoreWhitespace={ignoreWhitespace}
                lineDiffType={lineDiffType}
                hunkCount={hunks.count}
                hiddenLines={hiddenLineCount(metadata)}
                onDiffContextChange={onDiffContextChange}
                onIgnoreWhitespaceChange={onIgnoreWhitespaceChange}
                onLineDiffTypeChange={onLineDiffTypeChange}
              />
            </>
          ) : (
            <p className="px-3 py-2 font-mono text-xs text-muted-foreground">No changes to show</p>
          )}
        </div>
        {historyOpen && displayPath !== null ? (
          <HistoryPanel
            projectPath={projectPath}
            filePath={displayPath.path}
            onClose={() => onHistoryOpenChange(false)}
          />
        ) : null}
      </div>
    </section>
  );
}

function HunkNavigator({
  index,
  count,
  onPrev,
  onNext,
}: {
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Hunks"
      className="flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-muted px-0.5"
    >
      <button
        type="button"
        aria-label="Previous hunk"
        className="flex size-6 items-center justify-center rounded-md text-sm font-medium text-foreground hover:bg-input disabled:opacity-40"
        disabled={index === 0}
        onClick={onPrev}
      >
        ‹
      </button>
      <span data-hunk-position className="px-1 text-xs font-medium text-foreground">
        hunk {index + 1} of {count}
      </span>
      <button
        type="button"
        aria-label="Next hunk"
        className="flex size-6 items-center justify-center rounded-md text-sm font-medium text-foreground hover:bg-input disabled:opacity-40"
        disabled={index >= count - 1}
        onClick={onNext}
      >
        ›
      </button>
    </div>
  );
}

function CitationMarker({ label }: { label: string }) {
  return (
    <div className="flex justify-end px-3 py-0.5">
      <span
        data-citation-marker
        className="rounded-sm border border-info/40 bg-info/15 px-2 py-0.5 font-sans text-2xs text-info-foreground"
      >
        cited by assistant · {label}
      </span>
    </div>
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

/** `n` / `p` step hunks while focus is not in a text field. */
function useHunkKeys(enabled: boolean, next: () => void, prev: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target)) return;
      if (event.key === "n") next();
      else if (event.key === "p") prev();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, next, prev]);
}

/** Find-bar state: query, matches over the file's hunks, and the current match. */
function useDiffFind(
  file: FileDiff | null,
  scrollToTarget: (target: DiffLineTarget) => void,
  onClose: () => void,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => findDiffMatches(file?.hunks ?? [], query), [file, query]);
  const current = Math.min(index, Math.max(matches.length - 1, 0));

  useEffect(() => setIndex(0), [query]);
  const target = matches[current];
  useEffect(() => {
    if (open && target !== undefined) scrollToTarget(target);
    // Scroll when the current match moves, not when an equal target is recomputed.
  }, [open, target?.line, target?.side, scrollToTarget]);

  const step = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    setIndex((current + direction + matches.length) % matches.length);
  };
  return {
    open,
    query,
    matches,
    index: current,
    setQuery,
    step,
    openBar: () => setOpen(true),
    close: () => {
      setOpen(false);
      onClose();
    },
  };
}

/** Unchanged lines currently folded behind separators, before and after the hunks. */
function hiddenLineCount(metadata: FileDiffMetadata): number {
  const before = metadata.hunks.reduce((total, hunk) => total + hunk.collapsedBefore, 0);
  const last = metadata.hunks.at(-1);
  if (metadata.isPartial || last === undefined) return before;
  const shownThrough = last.additionStart - 1 + last.additionCount;
  return before + Math.max(0, metadata.additionLines.length - shownThrough);
}

function toLineSelection(range: SelectedLineRange | null): DiffLineSelection | null {
  if (range === null) return null;
  return {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
    side: range.side ?? "additions",
  };
}
