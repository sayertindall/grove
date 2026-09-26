import type { ChangeSummary, ProjectStatus, ReviewedFile, RiskSignal } from "@/types/grove";

/** How a risk chip is tinted; severity decides, not the signal's name. */
export type RiskTone = "destructive" | "warning" | "muted";

export const RISK_TONE: Record<RiskSignal, RiskTone> = {
  secret: "destructive",
  env: "destructive",
  auth: "destructive",
  migration: "destructive",
  "no-tests": "warning",
  large: "warning",
  lockfile: "warning",
  generated: "muted",
};

/** Chip text. A secret is a pattern match, so it reads as a question. */
export const RISK_LABEL: Record<RiskSignal, string> = {
  secret: "secret?",
  env: "env",
  auth: "auth",
  migration: "migration",
  "no-tests": "no-tests",
  large: "large",
  lockfile: "lockfile",
  generated: "generated",
};

/** Weight of each signal in the triage rank; the sum over a project's distinct signals. */
const RISK_WEIGHT: Record<RiskSignal, number> = {
  secret: 8,
  env: 4,
  auth: 4,
  migration: 5,
  "no-tests": 2,
  large: 2,
  lockfile: 1,
  generated: 0.5,
};

const RISK_ORDER: readonly RiskSignal[] = [
  "secret",
  "env",
  "auth",
  "migration",
  "no-tests",
  "large",
  "lockfile",
  "generated",
];

/** Distinct signals across a project's changed files, most severe first. */
export function projectRisks(files: readonly ChangeSummary[]): RiskSignal[] {
  const present = new Set(files.flatMap((file) => file.risk));
  return RISK_ORDER.filter((signal) => present.has(signal));
}

export function dirtyCount(project: ProjectStatus): number {
  return project.stagedCount + project.unstagedCount + project.untrackedCount;
}

/**
 * Triage rank: the dirty count, scaled by the severity of the project's signals and
 * by how long it has sat dirty (logarithmically, so a week does not drown a secret).
 */
export function triageScore(project: ProjectStatus, risks: readonly RiskSignal[]): number {
  if (project.state !== "dirty") return 0;
  const severity = risks.reduce((sum, signal) => sum + RISK_WEIGHT[signal], 0);
  const ageHours = (project.dirtyAgeSeconds ?? 0) / 3600;
  return dirtyCount(project) * (1 + severity) * (1 + Math.log1p(ageHours));
}

/** `45s`, `12m`, `5h`, `3d`, `2w`. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 1_209_600) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / 604_800)}w`;
}

/** Lockfiles and generated output start collapsed in the stream. */
export function collapsedByDefault(file: ChangeSummary): boolean {
  return file.risk.includes("lockfile") || file.risk.includes("generated");
}

/** A project's viewed marks, by file path. */
export type ReviewIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function indexReviewed(
  entries: ReadonlyArray<readonly [string, readonly ReviewedFile[] | undefined]>,
): ReviewIndex {
  return new Map(
    entries.map(([project, marks]) => [
      project,
      new Map((marks ?? []).map((mark) => [mark.filePath, mark.contentHash])),
    ]),
  );
}

/** Viewed iff the stored mark was made at the file's current content. */
export function isViewed(index: ReviewIndex, projectPath: string, file: ChangeSummary): boolean {
  return index.get(projectPath)?.get(file.path) === file.contentHash;
}
