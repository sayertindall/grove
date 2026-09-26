import { cn } from "@/lib/utils";
import type { ChatCitation, ChatFinding, FindingSeverity } from "@/types/grove";

const SEVERITY: Record<FindingSeverity, { badge: string; edge: string; label: string }> = {
  P0: { badge: "bg-destructive", edge: "var(--color-destructive)", label: "P0 · breaks something" },
  P1: { badge: "bg-warning", edge: "var(--color-warning)", label: "P1 · likely bug" },
  P2: { badge: "bg-info", edge: "var(--color-info)", label: "P2 · worth a look" },
};

/** The line range a finding covers, as the viewer's citation. */
export function findingCitation(finding: ChatFinding): ChatCitation {
  const range =
    finding.endLine > finding.startLine
      ? `${finding.startLine}-${finding.endLine}`
      : `${finding.startLine}`;
  return {
    projectPath: finding.projectPath,
    filePath: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    label: `${finding.path}:${range}`,
  };
}

/** One review finding, anchored to a changed hunk; the line link opens it in the diff. */
export function FindingCard({
  finding,
  onOpen,
}: {
  finding: ChatFinding;
  onOpen: (citation: ChatCitation) => void;
}) {
  const severity = SEVERITY[finding.severity];
  const citation = findingCitation(finding);
  const lines =
    finding.endLine > finding.startLine
      ? `L${finding.startLine}–${finding.endLine}`
      : `L${finding.startLine}`;
  return (
    <div
      role="group"
      aria-label={`Finding ${finding.severity}: ${finding.title}`}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5"
      style={{ boxShadow: `${severity.edge} 3px 0 0 inset` }}
    >
      <div className="flex items-center gap-2">
        <span
          title={severity.label}
          className={cn(
            "flex h-4 shrink-0 items-center rounded-sm px-[5px] text-[10px] leading-[14px] font-bold text-white",
            severity.badge,
          )}
        >
          {finding.severity}
        </span>
        <span className="min-w-0 truncate text-[13px] leading-[18px] font-semibold text-foreground">
          {finding.title}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          title={`Show ${citation.label} in the diff pane`}
          onClick={() => onOpen(citation)}
          className="shrink-0 font-mono text-2xs text-info-foreground transition-opacity hover:opacity-85"
        >
          {finding.path.split("/").pop()} · {lines} →
        </button>
      </div>
      {finding.detail !== "" && (
        <p className="text-xs leading-[18px] text-muted-foreground">{finding.detail}</p>
      )}
    </div>
  );
}
