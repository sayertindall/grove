// Shared pieces of the scenarios: the check recorder, the diff-pane reader, the
// CLI-derived expectations, and the timed external edit.

import fs from "node:fs";

import { page } from "./page.mjs";

export const WATCH_BUDGET_MS = 1000;

/** Chip text per risk signal, as src/lib/triage.ts renders it. */
export const RISK_LABEL = {
  secret: "secret?",
  env: "env",
  auth: "auth",
  migration: "migration",
  "no-tests": "no-tests",
  large: "large",
  lockfile: "lockfile",
  generated: "generated",
};
const RISK_ORDER = Object.keys(RISK_LABEL);
const RISK_WEIGHT = {
  secret: 8,
  env: 4,
  auth: 4,
  migration: 5,
  "no-tests": 2,
  large: 2,
  lockfile: 1,
  generated: 0.5,
};

/** Parses `path · 3 staged · 5 unstaged · 2 untracked` from a sidebar row title. */
export function titleCounts(title) {
  const count = (label) => Number(new RegExp(`(\\d+) ${label}`).exec(title)?.[1] ?? 0);
  return { staged: count("staged"), unstaged: count("unstaged"), untracked: count("untracked") };
}

/** Object key order is not part of any expectation; array order is. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function check(checks, label, expected, observed) {
  const pass = JSON.stringify(canonical(expected)) === JSON.stringify(canonical(observed));
  checks.push({ label, expected, observed, pass });
  return pass;
}

/** Distinct risk signals across a project's changed files, most severe first. */
export function projectRisks(files) {
  const present = new Set(files.flatMap((file) => file.risk ?? []));
  return RISK_ORDER.filter((signal) => present.has(signal));
}

/** `45s`, `12m`, `5h`, `3d`, `2w` — src/lib/triage.ts `formatAge`. */
export function formatAge(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 1_209_600) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / 604_800)}w`;
}

const dirtyCount = (project) =>
  project.stagedCount + project.unstagedCount + project.untrackedCount;

/**
 * The sidebar's default (triage) order computed from CLI data: clean projects
 * last, then dirty count × (1 + risk weight) × (1 + ln(1 + age hours)), ties in
 * stored order.
 */
export function triageOrder(status, changes) {
  const score = (project) => {
    if (project.state !== "dirty") return 0;
    const severity = projectRisks(changes[project.path] ?? []).reduce(
      (sum, signal) => sum + RISK_WEIGHT[signal],
      0,
    );
    const ageHours = (project.dirtyAgeSeconds ?? 0) / 3600;
    return dirtyCount(project) * (1 + severity) * (1 + Math.log1p(ageHours));
  };
  const cleanRank = (project) => (project.state === "clean" ? 1 : 0);
  return status
    .map((project, index) => ({ project, index }))
    .sort(
      (a, b) =>
        cleanRank(a.project) - cleanRank(b.project) ||
        score(b.project) - score(a.project) ||
        a.index - b.index,
    )
    .map((entry) => entry.project.path);
}

export { dirtyCount };

export function summaryOf(ctx, projectPath, file) {
  return ctx.oracle.changes[projectPath]?.find((change) => change.path === file) ?? null;
}

/** The diff pane state for one file in the File layout, read after clicking its tree row. */
export async function openFile(ctx, projectPath, file) {
  return ctx.bridge.eval(
    page(`
await setLayout("File");
await selectProject(${JSON.stringify(projectPath)});
await selectFile(${JSON.stringify(file)});
const images = [...(diffSection()?.querySelectorAll("img") ?? [])];
await Promise.all(images.map((image) => image.decode().catch(() => null)));
return {
  header: diffHeader(),
  body: diffBody(),
  rows: diffRows(),
  images: images.map((image) => ({ alt: image.alt, width: image.naturalWidth })),
  error: textOf(diffSection()?.querySelector('[role="alert"]')) || null,
};`),
  );
}

export async function waitForStore(probe, ms = 3000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      if (probe()) return true;
    } catch {
      // The store is rewritten in place; retry a torn read.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Prepares a probe in the page, starts polling it, then edits the file from this
 * process and reports how long after the write the page showed the change. Both
 * clocks are this machine's wall clock. `setup` is an async function body that
 * returns `{ probe }`; it runs in its own eval first, because the bridge answers
 * one request at a time and the poll must already be running at the write.
 */
export async function timedExternalEdit(ctx, label, edit, setup) {
  await ctx.bridge.eval(
    page(`
const titleCounts = (title) => {
  const count = (label) => Number(new RegExp("(\\\\d+) " + label).exec(title)?.[1] ?? 0);
  return { staged: count("staged"), unstaged: count("unstaged"), untracked: count("untracked") };
};
window.__groveProbe = (await (async () => { ${setup} })()).probe;
return true;`),
  );
  const polling = ctx.bridge.eval(`
const probe = window.__groveProbe;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const focusBefore = document.hasFocus();
const started = Date.now();
while (Date.now() - started < 5000) {
  if (probe()) return { updated: true, seenAt: Date.now(), focusBefore, focusAfter: document.hasFocus(), visibility: document.visibilityState };
  await sleep(5);
}
return { updated: false, seenAt: null, focusBefore, focusAfter: document.hasFocus(), visibility: document.visibilityState };`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const writtenAt = Date.now();
  edit();
  const result = await polling;
  const latencyMs = result.seenAt === null ? null : result.seenAt - writtenAt;
  ctx.latency(label, latencyMs);
  return { ...result, writtenAt, latencyMs };
}
