import { UnresolvedFile } from "@pierre/diffs/react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { DIFF_THEMES } from "@/diffsWorker";
import { cn } from "@/lib/utils";
import type { ConflictSides } from "@/types/grove";

/** The markers the backend's in-memory diff3 merge writes; its labels are fixed. */
const MARKER = {
  start: "<<<<<<< ours",
  base: "||||||| base",
  separator: "=======",
  end: ">>>>>>> theirs",
} as const;

/** Unchanged lines kept around each conflict before the rest folds away. */
const CONTEXT_LINES = 3;

type ColumnTone = "shared" | "ours" | "base" | "theirs" | "pad";

interface ColumnCell {
  /** 1-based line of this column's side; null on padding. */
  no: number | null;
  text: string;
  tone: ColumnTone;
}

/** One visual row across the three columns: ours, base, theirs. */
interface AlignedRow {
  cells: [ColumnCell, ColumnCell, ColumnCell];
  /** The conflict this row belongs to, or null for shared text. */
  conflictIndex: number | null;
}

export interface ConflictLayout {
  rows: AlignedRow[];
  /** First row and row count of each conflict region, in file order. */
  regions: { firstRow: number; rowCount: number }[];
  /** False when the sides could not be merged, so rows are the raw sides unaligned. */
  aligned: boolean;
}

const COLUMN_TONES = ["ours", "base", "theirs"] as const;

/**
 * Aligns ours/base/theirs from the diff3-marked merge: text outside a conflict is
 * one shared row; each conflict region becomes as many rows as its longest side,
 * the shorter sides padded. Every column keeps its own line numbers.
 */
export function alignConflictSides(merged: string): ConflictLayout {
  const lines = splitLines(merged);
  const counters = [0, 0, 0];
  const rows: AlignedRow[] = [];
  const regions: ConflictLayout["regions"] = [];
  let block: [string[], string[], string[]] | null = null;
  let section = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (block === null) {
      if (line === MARKER.start) {
        block = [[], [], []];
        section = 0;
      } else {
        const cell = (column: number): ColumnCell => ({
          no: ++counters[column],
          text: raw,
          tone: "shared",
        });
        rows.push({ cells: [cell(0), cell(1), cell(2)], conflictIndex: null });
      }
      continue;
    }
    if (line === MARKER.base) section = 1;
    else if (line === MARKER.separator) section = 2;
    else if (line === MARKER.end) {
      regions.push({ firstRow: rows.length, rowCount: 0 });
      rows.push(...conflictRows(block, counters, regions.length - 1));
      regions[regions.length - 1].rowCount = rows.length - regions[regions.length - 1].firstRow;
      block = null;
    } else block[section].push(raw);
  }
  return { rows, regions, aligned: true };
}

function conflictRows(
  sides: [string[], string[], string[]],
  counters: number[],
  conflictIndex: number,
): AlignedRow[] {
  const height = Math.max(1, ...sides.map((side) => side.length));
  return Array.from({ length: height }, (_, row) => {
    const cell = (column: number): ColumnCell => {
      const text = sides[column][row];
      if (text === undefined) return { no: null, text: "", tone: "pad" };
      return { no: ++counters[column], text, tone: COLUMN_TONES[column] };
    };
    return { cells: [cell(0), cell(1), cell(2)], conflictIndex };
  });
}

/** Without a merge the three sides are shown as they are, line by line. */
function unalignedLayout(conflict: ConflictSides): ConflictLayout {
  const sides = [conflict.ours, conflict.base, conflict.theirs].map((side) =>
    side === null ? [] : splitLines(side),
  );
  const height = Math.max(0, ...sides.map((side) => side.length));
  const rows = Array.from({ length: height }, (_, row): AlignedRow => {
    const cell = (column: number): ColumnCell => {
      const text = sides[column][row];
      return text === undefined
        ? { no: null, text: "", tone: "pad" }
        : { no: row + 1, text, tone: "shared" };
    };
    return { cells: [cell(0), cell(1), cell(2)], conflictIndex: null };
  });
  return { rows, regions: [], aligned: false };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

type LayoutItem = { type: "row"; index: number } | { type: "fold"; start: number; end: number };

/** Shared runs farther than `CONTEXT_LINES` from any conflict fold into one item. */
function foldRows(layout: ConflictLayout, expanded: ReadonlySet<number>): LayoutItem[] {
  const near = new Array<boolean>(layout.rows.length).fill(!layout.aligned);
  for (const region of layout.regions) {
    const from = Math.max(0, region.firstRow - CONTEXT_LINES);
    const to = Math.min(layout.rows.length, region.firstRow + region.rowCount + CONTEXT_LINES);
    for (let row = from; row < to; row += 1) near[row] = true;
  }
  const items: LayoutItem[] = [];
  let row = 0;
  while (row < layout.rows.length) {
    let end = row;
    while (end < layout.rows.length && !near[end]) end += 1;
    if (end - row > 1 && !expanded.has(row)) {
      items.push({ type: "fold", start: row, end });
      row = end;
      continue;
    }
    const stop = Math.max(end, row + 1);
    for (; row < stop; row += 1) items.push({ type: "row", index: row });
  }
  return items;
}

type ConflictLayoutMode = "columns" | "unified";

const LAYOUT_OPTIONS: SegmentedOption<ConflictLayoutMode>[] = [
  { value: "columns", label: "Columns" },
  { value: "unified", label: "Unified" },
];

interface ConflictViewProps {
  path: string;
  conflict: ConflictSides;
  themeType: "dark" | "light";
}

/**
 * A conflicted file, read-only: ours, base, and theirs side by side with each
 * conflict region aligned across the three, a rail of conflict marks, and
 * previous/next navigation. "Unified" hands the merged text to @pierre/diffs'
 * `UnresolvedFile` with its resolution actions turned off.
 */
export function ConflictView({ path, conflict, themeType }: ConflictViewProps) {
  const [layoutMode, setLayoutMode] = useState<ConflictLayoutMode>("columns");
  const merged = conflict.merged;
  const layout = useMemo(
    () => (merged === null ? unalignedLayout(conflict) : alignConflictSides(merged)),
    [conflict, merged],
  );
  const total = layout.regions.length;
  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const goTo = (index: number) => {
    const next = (index + total) % total;
    setCurrent(next);
    scrollRef.current
      ?.querySelector(`[data-conflict-start="${next}"]`)
      ?.scrollIntoView({ block: "center" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conflict-view">
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-card px-3">
        <Badge size="sm" variant="error">
          conflict
        </Badge>
        <span className="truncate text-xs text-muted-foreground">
          {total === 1 ? "1 conflict" : `${total} conflicts`}
        </span>
        <span className="flex-1" />
        {merged !== null ? (
          <SegmentedControl
            aria-label="Conflict layout"
            value={layoutMode}
            options={LAYOUT_OPTIONS}
            onValueChange={setLayoutMode}
          />
        ) : null}
        {layoutMode === "columns" && total > 0 ? (
          <div className="flex h-7 items-center gap-0.5 rounded-lg bg-muted px-0.5">
            <Button
              aria-label="Previous conflict"
              size="icon-xs"
              variant="ghost"
              onClick={() => goTo(current - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="px-1 text-xs font-medium tabular-nums" aria-live="polite">
              conflict {current + 1} of {total}
            </span>
            <Button
              aria-label="Next conflict"
              size="icon-xs"
              variant="ghost"
              onClick={() => goTo(current + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground">
          read-only · resolve in your editor
        </span>
      </div>
      {!layout.aligned ? (
        <p className="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          The sides could not be merged (a side is binary or over 512 KiB), so they are shown
          unaligned.
        </p>
      ) : null}
      {layoutMode === "unified" && merged !== null ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <UnresolvedFile
            file={{ name: path, contents: merged }}
            options={{
              theme: DIFF_THEMES,
              themeType,
              disableFileHeader: true,
              mergeConflictActionsType: "none",
            }}
          />
        </div>
      ) : (
        <ConflictColumns
          conflict={conflict}
          layout={layout}
          current={current}
          scrollRef={scrollRef}
          onSelectConflict={goTo}
        />
      )}
    </div>
  );
}

interface ConflictColumnsProps {
  conflict: ConflictSides;
  layout: ConflictLayout;
  current: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onSelectConflict: (index: number) => void;
}

function ConflictColumns({
  conflict,
  layout,
  current,
  scrollRef,
  onSelectConflict,
}: ConflictColumnsProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const items = useMemo(() => foldRows(layout, expanded), [layout, expanded]);
  const rail = useConflictRail(scrollRef, items);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="grid shrink-0 grid-cols-3 border-b border-border">
          <ColumnHeader tone="ours" title="Ours" detail="HEAD" side={conflict.ours} />
          <ColumnHeader tone="base" title="Base" detail="merge base" side={conflict.base} />
          <ColumnHeader tone="theirs" title="Theirs" detail="incoming" side={conflict.theirs} />
        </div>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs"
          onScroll={rail.onScroll}
          role="table"
          aria-label="Conflict sides: ours, base, theirs"
        >
          {items.map((item) =>
            item.type === "fold" ? (
              <button
                key={`fold-${item.start}`}
                type="button"
                className="block w-full bg-muted/60 px-3 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted"
                onClick={() => setExpanded((open) => new Set(open).add(item.start))}
              >
                {item.end - item.start} unchanged lines
              </button>
            ) : (
              <ConflictRow
                key={item.index}
                row={layout.rows[item.index]}
                startsRegion={layout.regions.findIndex((region) => region.firstRow === item.index)}
                active={layout.rows[item.index].conflictIndex === current}
              />
            ),
          )}
        </div>
      </div>
      <ConflictRail
        marks={rail.marks}
        thumb={rail.thumb}
        current={current}
        onSelectConflict={onSelectConflict}
      />
    </div>
  );
}

const TONE_DOT: Record<"ours" | "base" | "theirs", string> = {
  ours: "bg-info",
  base: "bg-warning",
  theirs: "bg-success",
};

const TONE_ROW: Record<ColumnTone, string> = {
  shared: "",
  pad: "bg-muted/40",
  ours: "bg-info/10 shadow-[inset_2px_0_0_var(--color-info)]",
  base: "bg-warning/10 shadow-[inset_2px_0_0_var(--color-warning)]",
  theirs: "bg-success/10 shadow-[inset_2px_0_0_var(--color-success)]",
};

function ColumnHeader({
  tone,
  title,
  detail,
  side,
}: {
  tone: "ours" | "base" | "theirs";
  title: string;
  detail: string;
  side: string | null;
}) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 border-r border-border px-3 last:border-r-0">
      <span className={cn("size-2 shrink-0 rounded-[2px]", TONE_DOT[tone])} />
      <span className="text-xs font-semibold">{title}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">
        {side === null ? `${detail} · absent or unreadable` : detail}
      </span>
    </div>
  );
}

function ConflictRow({
  row,
  startsRegion,
  active,
}: {
  row: AlignedRow;
  startsRegion: number;
  active: boolean;
}) {
  return (
    <div
      role="row"
      className={cn(
        "grid grid-cols-3",
        active && "outline outline-1 -outline-offset-1 outline-ring/40",
      )}
      data-conflict-start={startsRegion >= 0 ? startsRegion : undefined}
      data-conflict={row.conflictIndex ?? undefined}
    >
      {row.cells.map((cell, column) => (
        <div
          key={column}
          role="cell"
          className={cn(
            "flex min-h-5 min-w-0 border-r border-border last:border-r-0",
            TONE_ROW[cell.tone],
          )}
        >
          <span className="w-10 shrink-0 select-none pr-2 text-right text-[11px] leading-5 text-muted-foreground">
            {cell.no ?? ""}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pl-2 leading-5">
            {cell.text}
          </span>
        </div>
      ))}
    </div>
  );
}

interface RailMark {
  conflictIndex: number;
  /** Fractions of the scroll height. */
  top: number;
  height: number;
}

/** Conflict marks and the viewport thumb, measured from the rendered rows. */
function useConflictRail(scrollRef: React.RefObject<HTMLDivElement | null>, items: LayoutItem[]) {
  const [marks, setMarks] = useState<RailMark[]>([]);
  const [thumb, setThumb] = useState({ top: 0, height: 1 });

  const measureThumb = () => {
    const scroller = scrollRef.current;
    if (scroller === null || scroller.scrollHeight === 0) return;
    setThumb({
      top: scroller.scrollTop / scroller.scrollHeight,
      height: Math.min(1, scroller.clientHeight / scroller.scrollHeight),
    });
  };

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || scroller.scrollHeight === 0) return;
    const byConflict = new Map<number, { top: number; bottom: number }>();
    for (const element of scroller.querySelectorAll<HTMLElement>("[data-conflict]")) {
      const index = Number(element.dataset.conflict);
      const span = byConflict.get(index);
      const top = element.offsetTop;
      const bottom = top + element.offsetHeight;
      byConflict.set(index, {
        top: Math.min(span?.top ?? top, top),
        bottom: Math.max(span?.bottom ?? bottom, bottom),
      });
    }
    const total = scroller.scrollHeight;
    setMarks(
      [...byConflict].map(([conflictIndex, span]) => ({
        conflictIndex,
        top: span.top / total,
        height: (span.bottom - span.top) / total,
      })),
    );
    measureThumb();
    // Items change what is rendered; the scroller ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return { marks, thumb, onScroll: measureThumb };
}

function ConflictRail({
  marks,
  thumb,
  current,
  onSelectConflict,
}: {
  marks: RailMark[];
  thumb: { top: number; height: number };
  current: number;
  onSelectConflict: (index: number) => void;
}) {
  return (
    <div className="relative w-3.5 shrink-0 bg-muted" data-testid="conflict-rail">
      <div
        className="absolute left-[3px] w-2 rounded-sm bg-input"
        style={{ top: `${thumb.top * 100}%`, height: `${thumb.height * 100}%` }}
      />
      {marks.map((mark) => (
        <button
          key={mark.conflictIndex}
          type="button"
          aria-label={`Conflict ${mark.conflictIndex + 1}`}
          data-conflict-mark={mark.conflictIndex}
          className={cn(
            "absolute left-0 w-full min-h-[3px] bg-destructive",
            mark.conflictIndex === current ? "opacity-100" : "opacity-70",
          )}
          style={{ top: `${mark.top * 100}%`, height: `${mark.height * 100}%` }}
          onClick={() => onSelectConflict(mark.conflictIndex)}
        />
      ))}
    </div>
  );
}
