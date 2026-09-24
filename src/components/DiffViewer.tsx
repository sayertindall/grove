import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DIFF_THEMES } from "@/diffsWorker";
import {
  segmentedControlItemVariants,
  segmentedControlRootClassName,
} from "@/lib/segmented-control";
import type { FileChange } from "@/types/grove";

interface DiffViewerProps {
  change: FileChange | null;
  errorMessage: string | null;
  themeType: "dark" | "light";
}

export function DiffViewer({ change, errorMessage, themeType }: DiffViewerProps) {
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [overflow, setOverflow] = useState<"wrap" | "scroll">("scroll");
  const [version, setVersion] = useState(0);

  const fileDiff = useMemo(() => (change === null ? null : parseChange(change)), [change]);

  // The item is rebuilt from the patch; a new version is what tells CodeView the item
  // changed rather than only its options.
  useEffect(() => {
    setVersion((current) => current + 1);
  }, [change, diffStyle, overflow]);

  const items = useMemo(
    () =>
      change === null || fileDiff === null
        ? []
        : [
            {
              id: `diff:${change.path}`,
              type: "diff" as const,
              fileDiff,
              version,
            },
          ],
    [change, fileDiff, version],
  );

  const truncated = change !== null && textSideMissingByPolicy(change);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3">
        <span className="flex-1" />
        <ToggleGroup
          className={segmentedControlRootClassName}
          value={[diffStyle]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "unified" || next === "split") {
              setDiffStyle(next);
            }
          }}
        >
          <ToggleGroupItem
            value="unified"
            className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
          >
            Unified
          </ToggleGroupItem>
          <ToggleGroupItem
            value="split"
            className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
          >
            Split
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          className={segmentedControlRootClassName}
          value={[overflow]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "wrap" || next === "scroll") {
              setOverflow(next);
            }
          }}
        >
          <ToggleGroupItem
            value="wrap"
            className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
          >
            Wrap
          </ToggleGroupItem>
          <ToggleGroupItem
            value="scroll"
            className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
          >
            Scroll
          </ToggleGroupItem>
        </ToggleGroup>
      </header>

      {errorMessage !== null ? (
        <div className="p-3">
          <Alert variant="error">
            <AlertTitle>That diff could not be read</AlertTitle>
            <AlertDescription className="font-mono text-xs">{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : change === null ? (
        <Empty>
          <EmptyMedia variant="icon" />
          <EmptyHeader>
            <EmptyTitle>No file selected</EmptyTitle>
            <EmptyDescription>
              Pick a file from the tree to see its diff against HEAD.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : items.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
            {change.binary ? "Binary files differ" : "No changes to show"}
          </p>
        </div>
      ) : (
        <CodeView
          className="min-h-0 flex-1"
          items={items}
          options={{
            theme: DIFF_THEMES,
            themeType,
            diffStyle,
            overflow,
          }}
          renderHeaderMetadata={() => (
            <span className="flex items-center gap-1.5">
              {change.staged ? (
                <Badge size="sm" variant="secondary">
                  staged
                </Badge>
              ) : null}
              {change.binary ? (
                <Badge size="sm" variant="warning">
                  binary
                </Badge>
              ) : null}
              {truncated ? (
                <Badge size="sm" variant="warning">
                  truncated by policy
                </Badge>
              ) : null}
            </span>
          )}
        />
      )}
    </section>
  );
}

/**
 * A side that should exist is missing, so the patch is all there is to draw. A pure
 * add or delete is structurally one-sided and is not truncation.
 */
function textSideMissingByPolicy(change: FileChange): boolean {
  if (change.binary || change.patch === "") {
    return false;
  }

  switch (change.status) {
    case "added":
    case "untracked":
      return change.newContents === null;
    case "deleted":
      return change.oldContents === null;
    case "modified":
    case "renamed":
      return change.oldContents === null || change.newContents === null;
  }
}

function parseChange(change: FileChange): FileDiffMetadata | null {
  if (change.binary || textSideMissingByPolicy(change)) {
    return parsePatchFiles(change.patch, change.path)[0]?.files[0] ?? null;
  }

  const oldFile =
    change.oldContents === null
      ? null
      : { name: change.oldPath ?? change.path, contents: change.oldContents };
  const newFile =
    change.newContents === null ? null : { name: change.path, contents: change.newContents };

  return parseDiffFromFile(oldFile, newFile);
}
