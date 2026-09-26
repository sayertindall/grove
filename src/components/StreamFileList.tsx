import { CheckIcon } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { ProjectChangesState } from "@/hooks/useReviewState";
import { isViewed, type ReviewIndex } from "@/lib/triage";
import { cn } from "@/lib/utils";
import type { FileChangeStatus, ProjectStatus } from "@/types/grove";

const STATUS_LETTER: Record<FileChangeStatus, { letter: string; tone: string }> = {
  modified: { letter: "M", tone: "text-warning-foreground" },
  added: { letter: "A", tone: "text-success-foreground" },
  untracked: { letter: "A", tone: "text-success-foreground" },
  deleted: { letter: "D", tone: "text-destructive-foreground" },
  renamed: { letter: "R", tone: "text-info-foreground" },
  conflicted: { letter: "C", tone: "text-destructive-foreground" },
  submodule: { letter: "S", tone: "text-muted-foreground" },
};

/** The last two path segments: enough to tell `git/hunks.rs` from `ui/hunks.rs`. */
function shortPath(path: string): string {
  return path.split("/").slice(-2).join("/");
}

interface StreamFileListProps {
  projects: readonly ProjectStatus[];
  changes: ReadonlyMap<string, ProjectChangesState>;
  reviewIndex: ReviewIndex;
  activeProject: string | null;
  activeFile: string | null;
  width: number;
  onSelectFile: (projectPath: string, filePath: string) => void;
}

/** Stream mode's file pane: every changed file per repo, with a tick once viewed. */
export function StreamFileList({
  projects,
  changes,
  reviewIndex,
  activeProject,
  activeFile,
  width,
  onSelectFile,
}: StreamFileListProps) {
  const groups = projects.map((project) => {
    const files = changes.get(project.path)?.files ?? [];
    const viewed = files.filter((file) => isViewed(reviewIndex, project.path, file));
    return { project, files, viewedCount: viewed.length };
  });
  const total = groups.reduce((sum, group) => sum + group.files.length, 0);
  const viewedTotal = groups.reduce((sum, group) => sum + group.viewedCount, 0);

  return (
    <section
      aria-label="Changed files"
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-r border-border bg-background"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-[13px] font-semibold text-foreground">Files</h2>
        <span className="text-[11px] text-muted-foreground">
          {viewedTotal} / {total} viewed
        </span>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px px-2 py-1">
          {groups.map(({ project, files, viewedCount }) => (
            <div key={project.path} className="flex flex-col gap-px">
              <div className="flex items-center justify-between px-2 pt-3 pb-1">
                <span className="truncate text-[11px] font-semibold tracking-[0.04em] text-muted-foreground">
                  {project.displayName}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {viewedCount}/{files.length}
                </span>
              </div>
              {files.map((file) => {
                const viewed = isViewed(reviewIndex, project.path, file);
                const active = project.path === activeProject && file.path === activeFile;
                const status = STATUS_LETTER[file.status];
                return (
                  <button
                    key={file.path}
                    type="button"
                    title={file.path}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelectFile(project.path, file.path)}
                    className={cn(
                      "flex h-6.5 shrink-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent",
                      active && "bg-accent",
                    )}
                  >
                    {viewed ? (
                      <CheckIcon
                        size={14}
                        strokeWidth={2.5}
                        className="shrink-0 text-success-foreground"
                        aria-label="viewed"
                      />
                    ) : (
                      <span className="mx-[4.5px] size-[5px] shrink-0 rounded-full border border-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-xs",
                        viewed ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {shortPath(file.path)}
                    </span>
                    <span className={cn("shrink-0 font-mono text-[11px]", status.tone)}>
                      {status.letter}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
