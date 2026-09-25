import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { useMemo, useRef } from "react";

import { ImageDiff } from "@/components/ImageDiff";
import { PathContextItems } from "@/components/PathContextItems";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DIFF_THEMES } from "@/diffsWorker";
import { joinProjectFile, modeChangeLabel } from "@/lib/projects";
import type { DiffOverflow, DiffStyle } from "@/lib/storage";
import {
  segmentedControlItemVariants,
  segmentedControlRootClassName,
} from "@/lib/segmented-control";
import type { ChangeSummary, DiffView, FileDiff } from "@/types/grove";

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
  onDiffStyleChange: (style: DiffStyle) => void;
  onOverflowChange: (overflow: DiffOverflow) => void;
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void;
  onViewChange: (view: DiffView) => void;
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
  onDiffStyleChange,
  onOverflowChange,
  onIgnoreWhitespaceChange,
  onViewChange,
}: DiffViewerProps) {
  const metadata = useMemo(() => (file === null ? null : parseFile(file)), [file]);
  const contentKey = file === null ? null : diffContentKey(file);
  const versionRef = useRef(0);
  const keyRef = useRef<string | null>(null);
  if (contentKey !== keyRef.current) {
    keyRef.current = contentKey;
    versionRef.current += 1;
  }
  const version = versionRef.current;

  const items = useMemo(
    () =>
      file === null || metadata === null
        ? []
        : [
            {
              id: `diff:${file.path}:${file.view}`,
              type: "diff" as const,
              fileDiff: metadata,
              version,
            },
          ],
    [file, metadata, version],
  );

  const modeLabel = modeChangeLabel(file?.oldMode ?? summary?.oldMode ?? null, file?.newMode ?? summary?.newMode ?? null);
  const truncated = file !== null && textSideMissingByPolicy(file);
  const image = file?.image ?? null;
  const binary = file?.binary === true && image === null;
  const modeOnly =
    modeLabel !== null && image === null && !binary && (metadata === null || metadata.hunks.length === 0);
  const showText = errorMessage === null && !isPending && items.length > 0 && !modeOnly && image === null && !binary;
  const partial = summary !== null && summary.staged && summary.unstaged;
  const displayPath = summary ?? file;
  const absolutePath =
    displayPath === null ? null : joinProjectFile(projectPath, displayPath.path);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {displayPath !== null ? (
        <header className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-3">
          {absolutePath !== null ? (
            <ContextMenu>
              <ContextMenuTrigger className="min-w-0 flex-1 truncate text-left font-mono text-xs">
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
            <span className="shrink-0 font-mono text-[11px] text-success-foreground">
              +{summary.additions}
            </span>
          ) : null}
          {summary !== null && summary.deletions > 0 ? (
            <span className="shrink-0 font-mono text-[11px] text-destructive-foreground">
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
          {showText ? (
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={ignoreWhitespace}
                  onCheckedChange={(checked) => onIgnoreWhitespaceChange(checked === true)}
                />
                Hide whitespace
              </label>
              {partial ? (
                <ToggleGroup
                  className={segmentedControlRootClassName}
                  value={[view]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "head" || next === "staged" || next === "unstaged") {
                      onViewChange(next);
                    }
                  }}
                >
                  <Segment value="head">Head</Segment>
                  <Segment value="staged">Staged</Segment>
                  <Segment value="unstaged">Unstaged</Segment>
                </ToggleGroup>
              ) : null}
              <StyleToggle value={diffStyle} onChange={onDiffStyleChange} />
              <OverflowToggle value={overflow} onChange={onOverflowChange} />
            </span>
          ) : null}
        </header>
      ) : null}

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
            <EmptyDescription>Pick a file from the tree to see its diff against HEAD.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : image !== null && file !== null ? (
        <ImageDiff image={image} path={file.path} />
      ) : binary ? (
        <p className="bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
          Binary files differ
        </p>
      ) : modeOnly ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Only the file mode changed; the contents are identical.
        </p>
      ) : showText ? (
        <CodeView
          className="min-h-0 flex-1 overflow-auto"
          items={items}
          options={{
            theme: DIFF_THEMES,
            themeType,
            diffStyle,
            overflow,
            disableFileHeader: true,
          }}
        />
      ) : (
        <p className="px-3 py-2 font-mono text-xs text-muted-foreground">No changes to show</p>
      )}
    </section>
  );
}

function Segment({ value, children }: { value: string; children: string }) {
  return (
    <ToggleGroupItem
      value={value}
      className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
    >
      {children}
    </ToggleGroupItem>
  );
}

function StyleToggle({ value, onChange }: { value: DiffStyle; onChange: (style: DiffStyle) => void }) {
  return (
    <ToggleGroup
      className={segmentedControlRootClassName}
      value={[value]}
      onValueChange={(nextValue) => {
        const next = nextValue[0];
        if (next === "unified" || next === "split") onChange(next);
      }}
    >
      <Segment value="unified">Unified</Segment>
      <Segment value="split">Split</Segment>
    </ToggleGroup>
  );
}

function OverflowToggle({
  value,
  onChange,
}: {
  value: DiffOverflow;
  onChange: (overflow: DiffOverflow) => void;
}) {
  return (
    <ToggleGroup
      className={segmentedControlRootClassName}
      value={[value]}
      onValueChange={(nextValue) => {
        const next = nextValue[0];
        if (next === "wrap" || next === "scroll") onChange(next);
      }}
    >
      <Segment value="wrap">Wrap</Segment>
      <Segment value="scroll">Scroll</Segment>
    </ToggleGroup>
  );
}

function textSideMissingByPolicy(file: FileDiff): boolean {
  if (file.binary || file.image !== null || file.patch === "") return false;
  switch (file.status) {
    case "added":
    case "untracked":
      return file.newContents === null;
    case "deleted":
      return file.oldContents === null;
    case "modified":
    case "renamed":
      return file.oldContents === null || file.newContents === null;
  }
}

function parseFile(file: FileDiff): FileDiffMetadata | null {
  if (file.binary || file.image !== null) return null;
  if (textSideMissingByPolicy(file) || (file.oldContents === null && file.newContents === null)) {
    if (file.patch.trim() === "") return null;
    return parsePatchFiles(file.patch, file.path)[0]?.files[0] ?? null;
  }

  const oldFile =
    file.oldContents === null
      ? null
      : { name: file.oldPath ?? file.path, contents: file.oldContents };
  const newFile = file.newContents === null ? null : { name: file.path, contents: file.newContents };
  return parseDiffFromFile(oldFile, newFile);
}

function diffContentKey(file: FileDiff): string {
  return [
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
