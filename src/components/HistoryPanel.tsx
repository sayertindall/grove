import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { blameFile, fileHistory } from "@/api/grove";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { BlameView, CommitInfo } from "@/types/grove";

/** The backend's own caps: blame covers the first 400 lines, history 50 commits. */
const HISTORY_LIMIT = 50;

/** Query keys of the history readers; a watch event on a project drops `forProject`. */
export const historyKeys = {
  blameForProject: (projectPath: string) => ["blame", projectPath] as const,
  blame: (projectPath: string, filePath: string) => ["blame", projectPath, filePath] as const,
  commitsForProject: (projectPath: string) => ["fileHistory", projectPath] as const,
  commits: (projectPath: string, filePath: string) =>
    ["fileHistory", projectPath, filePath] as const,
};

type HistoryTab = "blame" | "history";

const TAB_OPTIONS: SegmentedOption<HistoryTab>[] = [
  { value: "blame", label: "Blame" },
  { value: "history", label: "History" },
];

interface HistoryPanelProps {
  projectPath: string;
  filePath: string;
  onClose: () => void;
}

/**
 * Read-only provenance of the selected file: Blame (each line of the current text
 * beside the commit that last touched it) or History (commits that touched it).
 */
export function HistoryPanel({ projectPath, filePath, onClose }: HistoryPanelProps) {
  const [tab, setTab] = useState<HistoryTab>("blame");
  return (
    <aside
      className="flex w-[380px] min-w-0 shrink-0 flex-col border-l border-border bg-background"
      aria-label={`History of ${filePath}`}
      data-testid="history-panel"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <SegmentedControl
          aria-label="File history view"
          value={tab}
          options={TAB_OPTIONS}
          onValueChange={setTab}
        />
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
          {filePath}
        </span>
        <Button aria-label="Close history" size="icon-xs" variant="ghost" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {tab === "blame" ? (
        <BlameTab projectPath={projectPath} filePath={filePath} />
      ) : (
        <HistoryTab projectPath={projectPath} filePath={filePath} />
      )}
    </aside>
  );
}

function BlameTab({ projectPath, filePath }: { projectPath: string; filePath: string }) {
  const blame = useQuery<BlameView>({
    queryKey: historyKeys.blame(projectPath, filePath),
    queryFn: () => blameFile(projectPath, filePath),
  });
  const [openCommit, setOpenCommit] = useState<{ line: number; id: string } | null>(null);
  const commits = useMemo(
    () => new Map((blame.data?.commits ?? []).map((commit) => [commit.id, commit])),
    [blame.data],
  );

  if (blame.isPending) return <PanelLoading />;
  if (blame.isError) return <PanelError title="Blame is unavailable" error={blame.error} />;
  const now = Date.now() / 1000;
  const lines = blame.data.lines;

  return (
    <div
      className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs"
      role="table"
      aria-label="Blame"
    >
      {lines.map((line, index) => {
        const commit = line.commit === null ? null : (commits.get(line.commit) ?? null);
        const runStart = index === 0 || lines[index - 1].commit !== line.commit;
        const open = openCommit !== null && openCommit.line === line.line;
        return (
          <Fragment key={line.line}>
            <div
              role="row"
              className={cn("flex min-h-5", runStart && index > 0 && "border-t border-border/60")}
              data-testid="blame-line"
            >
              <span
                role="cell"
                className="flex w-[150px] shrink-0 items-center gap-1.5 overflow-hidden px-2 text-[11px] leading-5"
              >
                {runStart ? (
                  <BlameGutter
                    commitId={line.commit}
                    commit={commit}
                    now={now}
                    open={open}
                    onToggle={() =>
                      setOpenCommit(
                        open || line.commit === null ? null : { line: line.line, id: line.commit },
                      )
                    }
                  />
                ) : null}
              </span>
              <span
                role="cell"
                className="w-9 shrink-0 select-none pr-2 text-right text-[11px] leading-5 text-muted-foreground"
              >
                {line.line}
              </span>
              <span role="cell" className="min-w-0 flex-1 whitespace-pre pr-3 leading-5">
                {line.text}
              </span>
            </div>
            {open && commit !== null ? <CommitDetail commit={commit} /> : null}
          </Fragment>
        );
      })}
      {blame.data.truncated ? (
        <p className="px-3 py-2 font-sans text-[11px] text-muted-foreground">
          Blame covers the first {lines.length} lines.
        </p>
      ) : null}
    </div>
  );
}

function BlameGutter({
  commitId,
  commit,
  now,
  open,
  onToggle,
}: {
  commitId: string | null;
  commit: CommitInfo | null;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (commitId === null) {
    return <span className="font-sans text-muted-foreground italic">not committed</span>;
  }
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Commit ${commit?.short ?? commitId.slice(0, 7)} details`}
        className="shrink-0 rounded-sm text-info-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onToggle}
      >
        {commit?.short ?? commitId.slice(0, 7)}
      </button>
      <span className="min-w-0 flex-1 truncate font-sans text-muted-foreground">
        {commit?.author ?? ""}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {commit === null ? "" : relativeAge(now - commit.date)}
      </span>
    </>
  );
}

function CommitDetail({ commit }: { commit: CommitInfo }) {
  return (
    <div
      className="mx-2 my-1 rounded-md border border-border bg-card px-3 py-2 font-sans"
      data-testid="commit-detail"
    >
      <p className="text-xs text-foreground">{commit.subject || "(no subject)"}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{commit.short}</span> · {commit.author} ·{" "}
        {new Date(commit.date * 1000).toLocaleString()}
      </p>
    </div>
  );
}

function HistoryTab({ projectPath, filePath }: { projectPath: string; filePath: string }) {
  const history = useQuery<CommitInfo[]>({
    queryKey: historyKeys.commits(projectPath, filePath),
    queryFn: () => fileHistory(projectPath, filePath, HISTORY_LIMIT),
  });
  if (history.isPending) return <PanelLoading />;
  if (history.isError) return <PanelError title="History is unavailable" error={history.error} />;
  if (history.data.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No commit has touched this file yet.
      </p>
    );
  }
  const now = Date.now() / 1000;
  return (
    <ol className="min-h-0 flex-1 overflow-auto py-1" aria-label="Commits that touched this file">
      {history.data.map((commit) => (
        <li
          key={commit.id}
          className="flex flex-col gap-0.5 border-b border-border/60 px-3 py-2"
          data-testid="history-commit"
        >
          <span className="truncate text-xs">{commit.subject || "(no subject)"}</span>
          <span className="flex gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono text-info-foreground" title={commit.id}>
              {commit.short}
            </span>
            <span className="truncate">{commit.author}</span>
            <span
              className="ml-auto shrink-0"
              title={new Date(commit.date * 1000).toLocaleString()}
            >
              {relativeAge(now - commit.date)}
            </span>
          </span>
        </li>
      ))}
      {history.data.length >= HISTORY_LIMIT ? (
        <li className="px-3 py-2 text-[11px] text-muted-foreground">
          Showing the newest {HISTORY_LIMIT} commits.
        </li>
      ) : null}
    </ol>
  );
}

function PanelLoading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Loading…
    </div>
  );
}

function PanelError({ title, error }: { title: string; error: Error }) {
  return (
    <div className="p-3">
      <Alert variant="error">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="font-mono text-xs">{error.message}</AlertDescription>
      </Alert>
    </div>
  );
}

/** A compact age: 45s, 12m, 3h, 5d, 2mo, 1y. */
function relativeAge(seconds: number): string {
  const units: [number, string][] = [
    [365 * 86400, "y"],
    [30 * 86400, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label}`;
  }
  return `${Math.max(0, Math.floor(seconds))}s`;
}
