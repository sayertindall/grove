import { useCallback, useMemo, useState } from "react";

import type { ProjectChangesState } from "@/hooks/useReviewState";
import { flattenTour, heuristicTour, planTour, type TourCandidate } from "@/lib/tour";
import type { ProjectStatus, TourPlan } from "@/types/grove";

const stepKey = (step: TourCandidate) => `${step.project}\0${step.file.path}`;

/**
 * The change tour across the dirty projects: the path heuristic, or an assistant plan
 * when one was applied. The current step is remembered by file, so a refreshed change
 * list keeps the reader on the same file.
 */
export function useTour(
  projects: readonly ProjectStatus[],
  changes: ReadonlyMap<string, ProjectChangesState>,
) {
  const [plan, setPlan] = useState<TourPlan | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      projects.flatMap((project) =>
        (changes.get(project.path)?.files ?? []).map((file) => ({ project: project.path, file })),
      ),
    [projects, changes],
  );
  const sections = useMemo(
    () => (plan === null ? heuristicTour(candidates) : planTour(plan, candidates)),
    [plan, candidates],
  );
  const steps = useMemo(() => flattenTour(sections), [sections]);
  const found = steps.findIndex((entry) => stepKey(entry.step) === currentKey);
  const current = found === -1 ? 0 : found;

  const select = useCallback(
    (index: number) => {
      const entry = steps[Math.max(0, Math.min(steps.length - 1, index))];
      if (entry !== undefined) setCurrentKey(stepKey(entry.step));
    },
    [steps],
  );
  const step = useCallback((direction: 1 | -1) => select(current + direction), [select, current]);
  const applyPlan = useCallback((next: TourPlan | null) => {
    setPlan(next);
    setCurrentKey(null);
  }, []);

  return {
    sections,
    steps,
    current,
    currentStep: steps[current]?.step ?? null,
    planSource: plan === null ? ("heuristic" as const) : ("assistant" as const),
    select,
    step,
    applyPlan,
  };
}
