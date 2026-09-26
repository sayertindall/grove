import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem } from "@pierre/diffs/react";
import { useQueries } from "@tanstack/react-query";
import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { getFileDiff } from "@/api/grove";
import { toError } from "@/api/invoke";
import {
  buildDiffMetadata,
  diffCodeViewOptions,
  diffContentKey,
  useLineDiffType,
} from "@/components/diff/diffMetadata";
import {
  DEFAULT_DIFF_CONTEXT,
  diffContextArgument,
  type LineDiffType,
} from "@/components/diff/diffPreferences";
import { Chip, RiskChips, ViewedToggle } from "@/components/RiskChips";
import { SubmodulePointerLabel } from "@/components/SubmoduleView";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectChangesState } from "@/hooks/useReviewState";
import type { DiffOverflow, DiffStyle, StreamFilter } from "@/lib/storage";
import { collapsedByDefault, isViewed, type ReviewIndex } from "@/lib/triage";
import { cn } from "@/lib/utils";
import { fileDiffKeys } from "@/queries";
import type { ChangeSummary, FileDiff, ProjectStatus } from "@/types/grove";

/** Every stream header (repo and file) is this tall; CodeView lays items out by it. */
const HEADER_HEIGHT = 40;

const FILTER_OPTIONS: SegmentedOption<StreamFilter>[] = [
  { value: "all", label: "All" },
  { value: "unviewed", label: "Unviewed" },
];

const STYLE_OPTIONS: SegmentedOption<DiffStyle>[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

interface RepoRow {
  kind: "repo";
  id: string;
  project: ProjectStatus;
  viewedCount: number;
  total: number;
}

interface FileRow {
  kind: "file";
  id: string;
  project: ProjectStatus;
  file: ChangeSummary;
  viewed: boolean;
}

type StreamRow = RepoRow | FileRow;

interface DiffState {
  data: FileDiff | undefined;
  error: Error | null;
}

/** The item id of one file in the stream. */
export function streamFileId(projectPath: string, filePath: string): string {
  return `file:${projectPath}\0${filePath}`;
}

/** Imperative stream actions for the menu/keyboard commands App wires. */
export interface ChangeStreamCommands {
  /** Scrolls to the next (1) or previous (-1) file after the one at the top. */
  step: (direction: 1 | -1) => void;
  /** Toggles "viewed" on the file at the top. */
  toggleActiveViewed: () => void;
}

/** A request to bring one file to the top; `seq` makes a repeat request distinct. */
export interface StreamScrollRequest {
  projectPath: string;
  filePath: string;
  seq: number;
}

interface ChangeStreamProps {
  /** Dirty projects, in sidebar order. */
  projects: readonly ProjectStatus[];
  changes: ReadonlyMap<string, ProjectChangesState>;
  reviewIndex: ReviewIndex;
  filter: StreamFilter;
  themeType: "dark" | "light";
  diffStyle: DiffStyle;
  overflow: DiffOverflow;
  lineDiffType: LineDiffType;
  ignoreWhitespace: boolean;
  scrollRequest: StreamScrollRequest | null;
  commandsRef: MutableRefObject<ChangeStreamCommands | null>;
  onFilterChange: (filter: StreamFilter) => void;
  onDiffStyleChange: (style: DiffStyle) => void;
  onToggleViewed: (projectPath: string, file: ChangeSummary, viewed: boolean) => void;
  /** The file whose header is at the top of the stream, for the file list's highlight. */
  onActiveFileChange: (projectPath: string | null, filePath: string | null) => void;
}

export function ChangeStream({
  projects,
  changes,
  reviewIndex,
  filter,
  themeType,
  diffStyle,
  overflow,
  lineDiffType,
  ignoreWhitespace,
  scrollRequest,
  commandsRef,
  onFilterChange,
  onDiffStyleChange,
  onToggleViewed,
  onActiveFileChange,
}: ChangeStreamProps) {
  useLineDiffType(lineDiffType);
  const viewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [topProject, setTopProject] = useState<string | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [unseenIds, setUnseenIds] = useState<readonly string[]>([]);

  const rows = useMemo(
    () => streamRows(projects, changes, reviewIndex, filter),
    [projects, changes, reviewIndex, filter],
  );
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const fileRows = useMemo(() => rows.filter((row): row is FileRow => row.kind === "file"), [rows]);
  const totalFiles = projects.reduce(
    (sum, project) => sum + (changes.get(project.path)?.files.length ?? 0),
    0,
  );

  const requestDiff = useCallback((id: string) => {
    setWanted((current) => (current.has(id) ? current : new Set(current).add(id)));
  }, []);

  const wantedRows = useMemo(
    () => fileRows.filter((row) => wanted.has(row.id)),
    [fileRows, wanted],
  );
  const diffStates = useFileDiffs(wantedRows, ignoreWhitespace);
  const items = useStreamItems(rows, diffStates, shown, folded, ignoreWhitespace);

  const syncTop = useCallback(() => {
    const root = containerRef.current;
    if (root === null) return;
    const top = readTopRows(root);
    setTopProject(scrollTopRef.current > 0 ? top.project : null);
    setActiveFileId(top.fileId);
  }, []);

  useEffect(() => {
    const row = activeFileId === null ? undefined : rowsById.get(activeFileId);
    onActiveFileChange(row?.project.path ?? null, row?.kind === "file" ? row.file.path : null);
  }, [activeFileId, rowsById, onActiveFileChange]);

  useUnseenChanges(fileRows, scrollTopRef, setUnseenIds);

  const scrollToId = useCallback((id: string) => {
    viewRef.current?.scrollTo({ type: "item", id, align: "start", offset: HEADER_HEIGHT });
  }, []);

  useEffect(() => {
    if (scrollRequest === null) return;
    scrollToId(streamFileId(scrollRequest.projectPath, scrollRequest.filePath));
  }, [scrollRequest, scrollToId]);

  commandsRef.current = {
    step: (direction) => {
      const index = fileRows.findIndex((row) => row.id === activeFileId);
      const next = fileRows[index < 0 ? (direction > 0 ? 0 : -1) : index + direction];
      if (next !== undefined) scrollToId(next.id);
    },
    toggleActiveViewed: () => {
      const row = activeFileId === null ? undefined : rowsById.get(activeFileId);
      if (row?.kind === "file") onToggleViewed(row.project.path, row.file, !row.viewed);
    },
  };

  const renderHeader = useCallback(
    (item: CodeViewItem<undefined>): ReactNode => {
      const row = rowsById.get(item.id);
      if (row === undefined) return null;
      if (row.kind === "repo") return <RepoHeader row={row} />;
      return (
        <FileHeader
          row={row}
          diff={diffStates.get(row.id)}
          wanted={wanted.has(row.id)}
          defaultCollapsed={collapsedByDefault(row.file) && !shown.has(row.id)}
          folded={folded.has(row.id)}
          onRequestDiff={requestDiff}
          onShow={() => setShown((current) => new Set(current).add(row.id))}
          onFold={(fold) => setFolded((current) => toggled(current, row.id, fold))}
          onToggleViewed={onToggleViewed}
        />
      );
    },
    [rowsById, diffStates, wanted, shown, folded, requestDiff, onToggleViewed],
  );

  const options = useMemo(
    () => ({
      ...diffCodeViewOptions<undefined>({ themeType, diffStyle, overflow, lineDiffType }),
      disableFileHeader: false,
      itemMetrics: { diffHeaderHeight: HEADER_HEIGHT },
    }),
    [themeType, diffStyle, overflow, lineDiffType],
  );

  const topRepoRow = topProject === null ? undefined : rowsById.get(`repo:${topProject}`);

  return (
    <section
      data-diff-pane
      aria-label="Change stream"
      className="relative flex h-full min-w-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border pr-3 pl-4">
        <h2 className="text-[13px] font-semibold text-foreground">Change stream</h2>
        <span className="truncate text-xs text-muted-foreground">
          {projects.length} {projects.length === 1 ? "repo" : "repos"} · {totalFiles}{" "}
          {totalFiles === 1 ? "file" : "files"} · live
        </span>
        <span className="flex-1" />
        <SegmentedControl
          aria-label="Stream filter"
          value={filter}
          options={FILTER_OPTIONS}
          onValueChange={onFilterChange}
        />
        <SegmentedControl
          aria-label="Diff style"
          value={diffStyle}
          options={STYLE_OPTIONS}
          onValueChange={onDiffStyleChange}
        />
      </header>

      {items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {projects.length === 0 ? "Nothing changed" : "Everything here is viewed"}
            </EmptyTitle>
            <EmptyDescription>
              {projects.length === 0
                ? "Every registered project matches HEAD. Grove keeps watching."
                : "An edit to a viewed file brings it back. Switch to All to see viewed files."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="relative min-h-0 flex-1"
          onClickCapture={(event) => {
            const root = containerRef.current;
            if (root === null) return;
            const pressed = pressedFileRow(root, event.target, event.clientY);
            if (pressed !== null) setActiveFileId(pressed);
          }}
        >
          <CodeView
            ref={viewRef}
            containerRef={containerRef}
            className="absolute inset-0 overflow-auto"
            items={items}
            options={options}
            renderCustomHeader={renderHeader}
            onScroll={(scrollTop) => {
              scrollTopRef.current = scrollTop;
              if (scrollTop <= 0) setUnseenIds([]);
              syncTop();
            }}
          />
          {topRepoRow?.kind === "repo" ? (
            <div className="absolute inset-x-0 top-0 z-10 shadow-[0_1px_0_var(--color-border),0_8px_16px_#00000059]">
              <RepoHeader row={topRepoRow} />
            </div>
          ) : null}
          {unseenIds.length > 0 ? (
            <button
              type="button"
              className="absolute top-12 left-1/2 z-20 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground pr-3 pl-2.5 text-xs font-semibold text-background shadow-[0_6px_20px_#00000073]"
              onClick={() => {
                const first = unseenIds.find((id) => rowsById.has(id));
                setUnseenIds([]);
                if (first !== undefined) scrollToId(first);
              }}
            >
              <ArrowUpIcon size={12} strokeWidth={2.5} />
              Latest · {unseenIds.length} new {unseenIds.length === 1 ? "change" : "changes"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function toggled(set: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/** Repo header rows followed by their files; the Unviewed filter drops viewed files. */
function streamRows(
  projects: readonly ProjectStatus[],
  changes: ReadonlyMap<string, ProjectChangesState>,
  reviewIndex: ReviewIndex,
  filter: StreamFilter,
): StreamRow[] {
  return projects.flatMap((project): StreamRow[] => {
    const files = changes.get(project.path)?.files ?? [];
    const fileRows = files.map((file): FileRow => ({
      kind: "file",
      id: streamFileId(project.path, file.path),
      project,
      file,
      viewed: isViewed(reviewIndex, project.path, file),
    }));
    const visible = filter === "unviewed" ? fileRows.filter((row) => !row.viewed) : fileRows;
    if (visible.length === 0) return [];
    const repo: RepoRow = {
      kind: "repo",
      id: `repo:${project.path}`,
      project,
      viewedCount: fileRows.filter((row) => row.viewed).length,
      total: fileRows.length,
    };
    return [repo, ...visible];
  });
}

/** One `get_file_diff` query per file that has come into view, sharing the diff cache. */
function useFileDiffs(
  rows: readonly FileRow[],
  ignoreWhitespace: boolean,
): ReadonlyMap<string, DiffState> {
  const results = useQueries({
    queries: rows.map((row) => ({
      queryKey: fileDiffKeys.for(
        row.project.path,
        row.file.path,
        "head",
        ignoreWhitespace,
        DEFAULT_DIFF_CONTEXT,
      ),
      queryFn: () =>
        getFileDiff(
          row.project.path,
          row.file.path,
          "head",
          ignoreWhitespace,
          diffContextArgument(DEFAULT_DIFF_CONTEXT),
        ),
    })),
  });
  const signature = results.map((result) => `${result.dataUpdatedAt}:${result.status}`).join();
  return useMemo(
    () =>
      new Map(
        rows.map((row, index) => {
          const result = results[index];
          return [row.id, { data: result?.data, error: result?.error ?? null }];
        }),
      ),
    // `results` is a new array every render; the signature says when it moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, signature],
  );
}

interface CachedMetadata {
  key: string;
  metadata: FileDiffMetadata | null;
  version: number;
}

/**
 * CodeView items for the rows. A file without a loaded diff (or one that renders no
 * text) is a collapsed placeholder: only its header shows, and that header asks for
 * the diff. Versions bump only when the rendered content or collapse state changes.
 */
function useStreamItems(
  rows: readonly StreamRow[],
  diffStates: ReadonlyMap<string, DiffState>,
  shown: ReadonlySet<string>,
  folded: ReadonlySet<string>,
  ignoreWhitespace: boolean,
): CodeViewItem<undefined>[] {
  const metadataCache = useRef(new Map<string, CachedMetadata>());
  const placeholders = useRef(new Map<string, FileDiffMetadata>());

  return useMemo(() => {
    const placeholder = (name: string) => {
      let metadata = placeholders.current.get(name);
      if (metadata === undefined) {
        metadata = parseDiffFromFile({ name, contents: "" }, { name, contents: "" });
        placeholders.current.set(name, metadata);
      }
      return metadata;
    };
    const cachedMetadata = (id: string, file: FileDiff) => {
      const key = diffContentKey(file, ignoreWhitespace, DEFAULT_DIFF_CONTEXT);
      const cached = metadataCache.current.get(id);
      if (cached?.key === key) return cached;
      const next = {
        key,
        metadata: buildDiffMetadata(file, ignoreWhitespace, DEFAULT_DIFF_CONTEXT),
        version: (cached?.version ?? 0) + 1,
      };
      metadataCache.current.set(id, next);
      return next;
    };

    return rows.map((row): CodeViewItem<undefined> => {
      if (row.kind === "repo") {
        return { id: row.id, type: "diff", fileDiff: placeholder(row.id), collapsed: true };
      }
      const data = diffStates.get(row.id)?.data;
      const cached = data === undefined ? null : cachedMetadata(row.id, data);
      const metadata = cached?.metadata ?? null;
      const collapsed =
        metadata === null ||
        folded.has(row.id) ||
        (collapsedByDefault(row.file) && !shown.has(row.id));
      return {
        id: row.id,
        type: "diff",
        fileDiff: metadata ?? placeholder(row.file.path),
        collapsed,
        version: (cached?.version ?? 0) * 2 + (collapsed ? 1 : 0),
      };
    });
  }, [rows, diffStates, shown, folded, ignoreWhitespace]);
}

/**
 * The project of the header nearest above the top edge, and the file whose header
 * sits just under the pinned repo header. CodeView pools its elements, so DOM order
 * is not screen order: every header is measured.
 */
function readTopRows(root: HTMLElement): { project: string | null; fileId: string | null } {
  const edge = root.getBoundingClientRect().top;
  let project: string | null = null;
  let fileId: string | null = null;
  let projectTop = -Infinity;
  let fileTop = -Infinity;
  for (const header of root.querySelectorAll<HTMLElement>("[data-stream-row]")) {
    const top = header.getBoundingClientRect().top - edge;
    if (top <= 1 && top > projectTop) {
      projectTop = top;
      project = header.dataset.project ?? null;
    }
    if (header.dataset.streamRow === "file" && top <= HEADER_HEIGHT + 1 && top > fileTop) {
      fileTop = top;
      fileId = header.dataset.id ?? null;
    }
  }
  return { project, fileId };
}

/**
 * The file a click lands on: its header when the click is on one (keyboard activation
 * has no geometry), otherwise the last file header above the pointer.
 */
function pressedFileRow(root: HTMLElement, target: EventTarget, clientY: number): string | null {
  if (target instanceof Element) {
    const header = target.closest<HTMLElement>('[data-stream-row="file"]');
    if (header !== null) return header.dataset.id ?? null;
  }
  let fileId: string | null = null;
  let headerTop = -Infinity;
  for (const header of root.querySelectorAll<HTMLElement>('[data-stream-row="file"]')) {
    const top = header.getBoundingClientRect().top;
    if (top <= clientY && top > headerTop) {
      headerTop = top;
      fileId = header.dataset.id ?? null;
    }
  }
  return fileId;
}

/**
 * Files whose content changed (or appeared) while the reader was scrolled away from
 * the top: they feed the "Latest · n new changes" pill instead of moving the page.
 */
function useUnseenChanges(
  fileRows: readonly FileRow[],
  scrollTopRef: MutableRefObject<number>,
  setUnseenIds: (update: (current: readonly string[]) => readonly string[]) => void,
): void {
  const hashesRef = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const next = new Map(fileRows.map((row) => [row.id, row.file.contentHash]));
    const previous = hashesRef.current;
    hashesRef.current = next;
    if (previous === null || scrollTopRef.current <= 0) return;
    const changed = [...next].filter(([id, hash]) => previous.get(id) !== hash).map(([id]) => id);
    if (changed.length === 0) return;
    setUnseenIds((current) => [...new Set([...current, ...changed])]);
  }, [fileRows, scrollTopRef, setUnseenIds]);
}

function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <>
      <span className="shrink-0 font-mono text-[11px] text-success-foreground">+{additions}</span>
      <span className="shrink-0 font-mono text-[11px] text-destructive-foreground">
        −{deletions}
      </span>
    </>
  );
}

function RepoHeader({ row }: { row: RepoRow }) {
  const { project } = row;
  const branch = project.branch?.name ?? project.branch?.headShort ?? null;
  const progress = row.total === 0 ? 0 : row.viewedCount / row.total;
  return (
    <div
      data-stream-row="repo"
      data-project={project.path}
      data-id={row.id}
      className="flex h-10 items-center gap-2.5 border-b border-border bg-background px-4"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span className="truncate text-sm font-semibold text-foreground">{project.displayName}</span>
      {branch !== null ? (
        <span className="flex h-5 min-w-0 items-center gap-1 rounded-sm bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
          <GitBranchIcon size={11} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
      <LineCounts additions={project.additions} deletions={project.deletions} />
      <span className="flex-1" />
      <span className="shrink-0 text-[11px] text-muted-foreground">viewed</span>
      <span
        role="progressbar"
        aria-label={`${project.displayName} viewed`}
        aria-valuemin={0}
        aria-valuemax={row.total}
        aria-valuenow={row.viewedCount}
        className="h-1 w-[50px] shrink-0 overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full rounded-full bg-success"
          style={{ width: `${progress * 100}%` }}
        />
      </span>
      <span className="shrink-0 font-mono text-[11px] text-foreground">
        {row.viewedCount}/{row.total}
      </span>
    </div>
  );
}

interface FileHeaderProps {
  row: FileRow;
  diff: DiffState | undefined;
  wanted: boolean;
  defaultCollapsed: boolean;
  folded: boolean;
  onRequestDiff: (id: string) => void;
  onShow: () => void;
  onFold: (fold: boolean) => void;
  onToggleViewed: (projectPath: string, file: ChangeSummary, viewed: boolean) => void;
}

function FileHeader({
  row,
  diff,
  wanted,
  defaultCollapsed,
  folded,
  onRequestDiff,
  onShow,
  onFold,
  onToggleViewed,
}: FileHeaderProps) {
  const { file, project } = row;
  const open = !defaultCollapsed && !folded;
  // A header renders only once its row is near the viewport: that is when to fetch.
  useEffect(() => {
    if (open && !wanted) onRequestDiff(row.id);
  }, [open, wanted, onRequestDiff, row.id]);

  const data = diff?.data;
  const loading = open && data === undefined && diff?.error == null;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      data-stream-row="file"
      data-project={project.path}
      data-id={row.id}
      className="flex h-10 items-center gap-2 border-b border-border bg-background px-4"
    >
      <button
        type="button"
        aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
        aria-expanded={open}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
        onClick={() => (defaultCollapsed ? onShow() : onFold(!folded))}
      >
        <Chevron size={14} />
      </button>
      <span
        className={cn(
          "min-w-0 truncate font-mono text-xs",
          row.viewed ? "text-muted-foreground" : "text-foreground",
        )}
        title={file.path}
      >
        {file.oldPath !== null ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <RiskChips risks={file.risk} />
      <StatusChip file={file} data={data} />
      <LineCounts additions={file.additions} deletions={file.deletions} />
      {defaultCollapsed ? (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {file.risk.includes("lockfile") ? "Lockfile" : "Generated"} diff collapsed ·{" "}
          {file.additions + file.deletions} lines
          <button
            type="button"
            className="font-medium text-info-foreground hover:underline"
            onClick={onShow}
          >
            Show
          </button>
        </span>
      ) : null}
      {loading ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      {diff?.error != null ? (
        <span className="truncate text-xs text-destructive-foreground">
          {toError(diff.error).message}
        </span>
      ) : null}
      <span className="flex-1" />
      <ViewedToggle
        viewed={row.viewed}
        onChange={(viewed) => onToggleViewed(project.path, file, viewed)}
      />
    </div>
  );
}

/** What the file is beyond a text edit: untracked, conflicted, binary, an image, a submodule. */
function StatusChip({ file, data }: { file: ChangeSummary; data: FileDiff | undefined }) {
  switch (file.status) {
    case "untracked":
      return <Chip tone="neutral">untracked</Chip>;
    case "deleted":
      return <Chip tone="neutral">deleted</Chip>;
    case "conflicted":
      return <Chip tone="destructive">conflict</Chip>;
    case "submodule":
      return (
        <>
          <Chip tone="neutral">submodule</Chip>
          {file.submodule !== null ? <SubmodulePointerLabel pointer={file.submodule} /> : null}
        </>
      );
  }
  if (data?.image != null) return <Chip tone="neutral">image · open in File view</Chip>;
  if (file.binary || data?.binary === true) return <Chip tone="neutral">binary</Chip>;
  return null;
}
