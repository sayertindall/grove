import type { ChangeSummary, TourFileRef, TourGroup, TourPlan } from "@/types/grove";

/** One changed file of the tour's scope. */
export interface TourCandidate {
  project: string;
  file: ChangeSummary;
}

/** A tour group in reading order, matched to the files it still covers. */
export interface TourSection {
  title: string;
  rationale: string;
  steps: TourCandidate[];
}

interface HeuristicGroup {
  title: string;
  rationale: string;
  matches: (path: string, file: ChangeSummary) => boolean;
}

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/i;
const SCHEMA_PATH =
  /(^|\/)(migrations?|migrate|alembic|schema|schemas|prisma)\/|\.(sql|prisma|proto|graphql|gql)$|(^|\/)schema\.[^/]+$/i;
const CONFIG_PATH =
  /(^|\/)(\.github|\.cargo|config)\/|(^|\/)(package\.json|cargo\.toml|tsconfig[^/]*\.json|dockerfile|makefile|\.env[^/]*|[^/]+\.config\.[^/]+|[^/]+\.(toml|ya?ml|ini))$/i;
const API_PATH =
  /(^|\/)(api|types|contracts?|interfaces?|dto|ipc)\/|\.d\.ts$|(^|\/)(types|api)\.[^/]+$/i;
const BACKEND_PATH =
  /(^|\/)(src-tauri|server|backend|crates|cmd|internal|pkg)\/|\.(rs|go|py|rb|java|kt|cs|php|ex|exs|scala|c|cc|cpp|h|hpp)$/i;
const UI_PATH =
  /\.(tsx|jsx|vue|svelte|css|scss|html|astro)$|(^|\/)(components?|hooks|pages|views|app|ui|styles)\/|\.(ts|js|mjs)$/i;

/** Deterministic reading order: what everything depends on first, mechanical output last. */
const HEURISTIC_GROUPS: readonly HeuristicGroup[] = [
  {
    title: "Schema & config",
    rationale: "Data shape and settings the rest of the change depends on.",
    matches: (path) => SCHEMA_PATH.test(path) || CONFIG_PATH.test(path),
  },
  {
    title: "Backend",
    rationale: "Behavior built on that shape, below the UI.",
    matches: (path) => BACKEND_PATH.test(path) && !API_PATH.test(path),
  },
  {
    title: "API & types",
    rationale: "The contract between the backend and what renders it.",
    matches: (path) => API_PATH.test(path),
  },
  { title: "UI", rationale: "What the user sees and does.", matches: (path) => UI_PATH.test(path) },
  { title: "Tests", rationale: "Proof the change holds.", matches: (path) => TEST_PATH.test(path) },
  {
    title: "Lockfiles & generated",
    rationale: "Mechanical output of the files above; skim.",
    matches: (_path, file) => file.risk.includes("lockfile") || file.risk.includes("generated"),
  },
];

const OTHER_GROUP = { title: "Other", rationale: "Docs, assets, and the rest." };

/** Tests and mechanical output win over their extension; the rest go in reading order. */
const CLASSIFY_ORDER = [5, 4, 0, 2, 1, 3] as const;

function heuristicGroupIndex(candidate: TourCandidate): number {
  const index = CLASSIFY_ORDER.find((groupIndex) =>
    HEURISTIC_GROUPS[groupIndex]!.matches(candidate.file.path, candidate.file),
  );
  return index ?? HEURISTIC_GROUPS.length;
}

/** The deterministic first pass: every candidate filed under one path-based group. */
export function heuristicTour(candidates: readonly TourCandidate[]): TourSection[] {
  const groups = [...HEURISTIC_GROUPS, OTHER_GROUP];
  const buckets = groups.map((): TourCandidate[] => []);
  for (const candidate of candidates) buckets[heuristicGroupIndex(candidate)]!.push(candidate);
  // Lockfiles/generated read last, after anything unclassified.
  const order = [0, 1, 2, 3, 4, 6, 5];
  return order
    .map((index) => ({ ...groups[index]!, steps: buckets[index]! }))
    .filter((section) => section.steps.length > 0)
    .map(({ title, rationale, steps }) => ({ title, rationale, steps }));
}

const refKey = (ref: TourFileRef) => `${ref.project}\0${ref.path}`;

/**
 * A supplied plan, reconciled with what is changed now: files no longer changed are
 * dropped, and changed files the plan does not name are appended under "Other".
 */
export function planTour(plan: TourPlan, candidates: readonly TourCandidate[]): TourSection[] {
  const byKey = new Map(
    candidates.map((candidate) => [
      refKey({ project: candidate.project, path: candidate.file.path }),
      candidate,
    ]),
  );
  const placed = new Set<string>();
  const take = (group: TourGroup): TourSection => ({
    title: group.title,
    rationale: group.rationale,
    steps: group.files.flatMap((ref) => {
      const key = refKey(ref);
      const candidate = byKey.get(key);
      if (candidate === undefined || placed.has(key)) return [];
      placed.add(key);
      return [candidate];
    }),
  });
  const sections = plan.groups.map(take);
  const rest = candidates.filter(
    (candidate) => !placed.has(refKey({ project: candidate.project, path: candidate.file.path })),
  );
  if (rest.length > 0) sections.push({ ...OTHER_GROUP, steps: rest });
  return sections.filter((section) => section.steps.length > 0);
}

/** The steps of every section, in reading order, with the section each belongs to. */
export function flattenTour(
  sections: readonly TourSection[],
): { step: TourCandidate; section: number }[] {
  return sections.flatMap((section, index) =>
    section.steps.map((step) => ({ step, section: index })),
  );
}
