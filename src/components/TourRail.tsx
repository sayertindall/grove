import { CheckIcon, ChevronLeftIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { ViewedToggle } from "@/components/RiskChips";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TourCandidate, TourSection } from "@/lib/tour";
import { cn } from "@/lib/utils";

/** One step of the flattened tour: the file and the section it is read under. */
export interface TourStep {
  step: TourCandidate;
  section: number;
}

function Keycap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-border px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface TourRailProps {
  sections: readonly TourSection[];
  steps: readonly TourStep[];
  current: number;
  /** Subtitle under "Tour": the project and branch, or the repo count of a cross-repo tour. */
  scope: string;
  width: number;
  /** `assistant` when an assistant-proposed plan overrides the path heuristic. */
  planSource: "heuristic" | "assistant";
  isViewed: (step: TourCandidate) => boolean;
  onSelect: (index: number) => void;
  onResetPlan: () => void;
}

/**
 * The ordered reading plan: sections in order, their files, the current step, and
 * progress. j/k step through it (bound by App); a click jumps.
 */
export function TourRail({
  sections,
  steps,
  current,
  scope,
  width,
  planSource,
  isViewed,
  onSelect,
  onResetPlan,
}: TourRailProps) {
  const currentRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const currentSection = steps[current]?.section ?? -1;
  let offset = 0;
  return (
    <nav
      aria-label="Tour"
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-r border-border bg-background"
    >
      <div className="flex flex-col gap-2 border-b border-border px-4 pt-3 pb-4">
        <div className="flex items-center gap-1">
          <h2 className="flex-1 text-[13px] font-semibold text-foreground">Tour</h2>
          <Keycap>j</Keycap>
          <Keycap>k</Keycap>
          <span className="ml-1 text-[11px] text-muted-foreground">step</span>
        </div>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{scope}</span>
        {planSource === "assistant" ? (
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            Order proposed by the assistant
            <button
              type="button"
              className="font-medium text-info-foreground hover:underline"
              onClick={onResetPlan}
            >
              Use path order
            </button>
          </span>
        ) : null}
        <span className="flex items-baseline gap-1.5">
          <span className="text-xl font-medium text-foreground">
            {steps.length === 0 ? 0 : current + 1}
          </span>
          <span className="text-xs text-muted-foreground">of {steps.length} files</span>
        </span>
        <span
          role="progressbar"
          aria-label="Tour progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={steps.length === 0 ? 0 : current + 1}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-foreground"
            style={{ width: `${steps.length === 0 ? 0 : ((current + 1) / steps.length) * 100}%` }}
          />
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col gap-1 p-2">
          {sections.map((section, sectionIndex) => {
            const start = offset;
            offset += section.steps.length;
            const active = sectionIndex === currentSection;
            return (
              <li
                key={`${sectionIndex}:${section.title}`}
                className={cn(
                  "flex flex-col gap-0.5 rounded-md border-l-2 border-transparent py-2 pr-2 pl-2",
                  active && "border-info bg-muted/60",
                )}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-px flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                      active
                        ? "border-info bg-info text-white"
                        : "border-muted-foreground/60 text-muted-foreground",
                    )}
                  >
                    {sectionIndex + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] font-medium text-foreground">{section.title}</span>
                    <span className="text-xs text-muted-foreground">{section.rationale}</span>
                  </span>
                </div>
                <ul className="mt-1 flex flex-col">
                  {section.steps.map((step, stepIndex) => {
                    const index = start + stepIndex;
                    const isCurrent = index === current;
                    const viewed = isViewed(step);
                    return (
                      <li key={`${step.project}\0${step.file.path}`}>
                        <button
                          ref={isCurrent ? currentRef : undefined}
                          type="button"
                          aria-current={isCurrent ? "step" : undefined}
                          title={step.file.path}
                          onClick={() => onSelect(index)}
                          className={cn(
                            "flex h-6.5 w-full items-center gap-2 rounded-md pr-2 pl-6 text-left hover:bg-accent",
                            isCurrent && "bg-accent",
                          )}
                        >
                          {viewed ? (
                            <CheckIcon
                              size={13}
                              strokeWidth={2.5}
                              className="shrink-0 text-success-foreground"
                              aria-label="viewed"
                            />
                          ) : (
                            <span
                              className={cn(
                                "mx-[4px] size-[5px] shrink-0 rounded-full",
                                isCurrent ? "bg-info" : "border border-muted-foreground",
                              )}
                            />
                          )}
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate font-mono text-xs",
                              viewed && !isCurrent ? "text-muted-foreground" : "text-foreground",
                            )}
                          >
                            {fileName(step.file.path)}
                          </span>
                          {isCurrent ? (
                            <span className="shrink-0 text-[10px] font-medium text-info-foreground">
                              now
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </nav>
  );
}

interface TourStepBarProps {
  steps: readonly TourStep[];
  sections: readonly TourSection[];
  current: number;
  viewed: boolean;
  onToggleViewed: (viewed: boolean) => void;
}

/** Above the tour's diff: which step this is, why it is read here, and its viewed box. */
export function TourStepBar({
  steps,
  sections,
  current,
  viewed,
  onToggleViewed,
}: TourStepBarProps) {
  const entry = steps[current];
  if (entry === undefined) return null;
  const section = sections[entry.section];
  const { file } = entry.step;
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border px-4 pt-3 pb-3">
      <span className="flex items-center gap-2 text-[11px]">
        <span className="font-semibold tracking-wide text-info-foreground uppercase">
          Step {entry.section + 1} · {section?.title}
        </span>
        <span className="text-muted-foreground">
          file {current + 1} of {steps.length}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm text-foreground">{file.path}</span>
        <span className="font-mono text-[11px] text-success-foreground">+{file.additions}</span>
        <span className="font-mono text-[11px] text-destructive-foreground">−{file.deletions}</span>
        <span className="flex-1" />
        <ViewedToggle viewed={viewed} onChange={onToggleViewed} />
      </span>
      {section !== undefined ? (
        <span className="text-xs text-muted-foreground">{section.rationale}</span>
      ) : null}
    </div>
  );
}

interface TourFooterProps {
  steps: readonly TourStep[];
  sections: readonly TourSection[];
  current: number;
  onStep: (direction: 1 | -1) => void;
}

/** Below the tour's diff: Prev (j), what comes next, and Next (k). */
export function TourFooter({ steps, sections, current, onStep }: TourFooterProps) {
  const next = steps[current + 1];
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-t border-border px-4">
      <button
        type="button"
        disabled={current <= 0}
        onClick={() => onStep(-1)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        <ChevronLeftIcon size={12} />
        Prev
        <Keycap>j</Keycap>
      </button>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {next === undefined ? "Last file" : "Up next"}
        </span>
        {next !== undefined ? (
          <span className="truncate text-xs text-foreground">
            {next.step.file.path} · {sections[next.section]?.title}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        disabled={next === undefined}
        onClick={() => onStep(1)}
        className="flex h-8 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-semibold text-background disabled:opacity-50"
      >
        Next
        <kbd className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-sm bg-background/15 px-1 font-mono text-[10px]">
          k
        </kbd>
      </button>
    </div>
  );
}
