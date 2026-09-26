// Writes the repeatable desktop E2E artifact: how to recreate the fixtures, the
// exact commands, and expected vs observed per scenario with its screenshot.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const fence = (text, lang = "") => `\`\`\`${lang}\n${text}\n\`\`\``;
const json = (value) => JSON.stringify(value);

function gitRevision(repoRoot) {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim() !==
      "";
    return `${head}${dirty ? " + uncommitted changes" : ""}`;
  } catch {
    return "unknown";
  }
}

function scenarioSection(result) {
  const lines = [
    `### ${result.status} — ${result.name}`,
    "",
    `**Expected:** ${result.expected}`,
    "",
  ];
  if (result.knownIssue && result.status !== "PASS")
    lines.push(`**Known issue (expected failure):** ${result.knownIssue}`, "");
  if (result.error) lines.push("**Error:**", "", fence(result.error), "");
  if (result.checks.length > 0) {
    lines.push("| check | expected | observed | |", "| --- | --- | --- | --- |");
    for (const c of result.checks) {
      const cell = (value) => `\`${json(value).replace(/\|/g, "\\|")}\``;
      lines.push(
        `| ${c.label} | ${cell(c.expected)} | ${cell(c.observed)} | ${c.pass ? "✓" : "✗"} |`,
      );
    }
    lines.push("");
  }
  if (result.observed !== undefined)
    lines.push(
      "<details><summary>Observed</summary>",
      "",
      fence(JSON.stringify(result.observed, null, 2), "json"),
      "",
      "</details>",
      "",
    );
  for (const extra of result.extraShots ?? []) {
    lines.push(
      extra.kind === "webkit-png"
        ? `![${extra.name}](${extra.path})`
        : `DOM snapshot for ${extra.name}: [${extra.path}](${extra.path})`,
      "",
    );
  }
  if (result.shot?.path) {
    lines.push(
      result.shot.kind === "webkit-png"
        ? `![${result.name}](${result.shot.path})`
        : `DOM snapshot (WebKit returned no pixels: ${result.shot.reason}): [${result.shot.path}](${result.shot.path})`,
    );
  } else {
    lines.push(`No capture: ${result.shot?.reason ?? "unknown"}`);
  }
  lines.push(`\nDuration: ${result.ms} ms`, "");
  return lines.join("\n");
}

export function writeReport(run) {
  const counts = { PASS: 0, XFAIL: 0, FAIL: 0 };
  for (const r of run.results) counts[r.status] += 1;
  const h = run.headless;
  const grovePids = h.launches.map((l) => l.pid);
  const summary = [
    `- Result: **${run.ok ? "PASS" : "FAIL"}** — ${counts.PASS} passed, ${counts.XFAIL} expected failures (known issues), ${counts.FAIL} unexpected failures${run.fatal ? ", run aborted" : ""}${h.invisible ? "" : ", **visibility check failed**"}`,
    `- Started: ${run.startedAt.toISOString()} on ${os.hostname()} (${os.type()} ${os.release()}, ${os.arch()})`,
    `- Source: ${gitRevision(run.repoRoot)}; binary \`${path.relative(run.repoRoot, run.binary)}\` (debug build); Vite dev server ${run.viteStarted ? "started by the harness" : "reused"}; chat turns ${run.chat ? "sent to the loopback stub (`GROVE_E2E_CHAT=1`)" : "not sent (set `GROVE_E2E_CHAT=1`)"}`,
    `- Invisible: ${h.invisible ? "yes" : "**NO**"} — ${h.launches.length} launch(es), LaunchServices type ${h.launches.map((l) => `\`${l.type}\``).join(", ")}; ${h.fronts.filter((f) => grovePids.includes(f.pid)).length} of ${h.fronts.length} \`lsappinfo front\` samples were grove; presence probes ${h.presence.every((p) => p.alpha === 0 && !p.keyWindow && !p.appActive) ? "all alpha 0, never key, app never active" : "**show a visible, key, or active window**"} (see [Invisibility checks](#invisibility-checks))`,
    `- App exits: ${run.appExits.map((e) => `${e.at}: code ${e.code} signal ${e.signal}${e.forced ? " (forced)" : ""}`).join("; ") || "not started"}; log: [app.log](app.log)`,
    `- Page responsiveness after captures: ${run.stalls.length === 0 ? "answered within 1 s after every capture" : run.stalls.map((s) => `after ${s.after}: ${s.ms} ms, ${s.attempts} attempts`).join("; ")}`,
  ];
  const invisibility = [
    "## Invisibility checks",
    "",
    "grove processes (spawned directly, never through `open`/LaunchServices, so the ASN is inferred with type `BackgroundOnly`: no Dock icon, no menu bar, cannot be frontmost):",
    "",
    "| launch | pid | ASN | type |",
    "| --- | --- | --- | --- |",
    ...h.launches.map((l) => `| ${l.at} | ${l.pid} | \`${l.asn}\` | \`${l.type}\` |`),
    "",
    "`lsappinfo front` samples (the owner switching apps changes the frontmost ASN; what must hold is that it is never grove's):",
    "",
    "| when | frontmost ASN | pid | grove? |",
    "| --- | --- | --- | --- |",
    ...h.fronts.map(
      (f) =>
        `| ${f.at} | \`${f.asn}\` | ${f.pid ?? "?"} | ${grovePids.includes(f.pid) ? "**YES**" : "no"} |`,
    ),
    "",
    "Window presence, read on the app's main thread:",
    "",
    "| when | alpha | keyWindow | appActive | listedOnScreen |",
    "| --- | --- | --- | --- | --- |",
    ...h.presence.map(
      (p) => `| ${p.at} | ${p.alpha} | ${p.keyWindow} | ${p.appActive} | ${p.listedOnScreen} |`,
    ),
    "",
    "`listedOnScreen` is true while the alpha-0 window is ordered in (so WebKit keeps rendering); it composites no pixels.",
    "",
  ];
  const latencies = [
    "## Watcher latencies",
    "",
    "From the external write (this process) to the page showing the change (polled every 5 ms in the page); both clocks are this machine's wall clock.",
    "",
    "| change | latency |",
    "| --- | --- |",
    ...run.latencies.map(
      (l) => `| ${l.label} | ${l.ms === null ? "not seen within 5 s" : `${l.ms} ms`} |`,
    ),
    "",
  ];
  const table = ["| # | scenario | status | capture |", "| --- | --- | --- | --- |"];
  run.results.forEach((r, i) =>
    table.push(
      `| ${i + 1} | ${r.name} | ${r.status} | ${r.shot?.path ? `[${r.shot.kind}](${r.shot.path})` : "—"} |`,
    ),
  );

  const body = [
    "# Grove desktop E2E report",
    "",
    "## Summary",
    "",
    ...summary,
    "",
    ...table,
    "",
    run.fatal ? `## Fatal error\n\n${fence(run.fatal)}\n` : "",
    "## How this run drives the app",
    "",
    "The debug binary is spawned directly (never via `open`/LaunchServices) with `GROVE_AUTOMATION_SOCKET` and a throwaway `GROVE_DATA_DIR`. In that mode it is invisible by construction: the activation policy is `Prohibited` before the event loop starts (no Dock icon, cannot become active or frontmost), window-state restore (which shows and focuses) is not registered, and the window is created hidden, then made fully transparent (alpha 0), click-through, shadowless, excluded from Exposé/⌘` and the Window menu, and ordered in behind other windows without becoming key. It is ordered in because WebKit runs `requestAnimationFrame` (which the diff view renders through) only for a visible page; WKWebView occlusion detection is turned off so the transparent window still counts as visible. The harness evaluates JavaScript in the real WKWebView (real IPC, real watcher) and clicks what a person would click; captures are WebKit's in-process `takeSnapshotWithConfiguration`, never a screen grab.",
    "",
    "## Commands",
    "",
    fence(run.commands.join("\n"), "sh"),
    "",
    "## Fixtures",
    "",
    `Work directory: \`${run.workDir}\` (repositories under \`repos/\`, store under \`data/\`). Registered projects, in stored order:`,
    "",
    ...run.registered.map((p) => `- \`${p}\``),
    "",
    "Recreate them (from `repos/`, with `GIT_CONFIG_GLOBAL=/dev/null`, author `Grove E2E <e2e@grove.invalid>`; `e2e/desktop/lib/fixtures.mjs` is the source of truth for file contents):",
    "",
    fence(run.fixtureSteps.join("\n"), "sh"),
    "",
    `Store: \`${path.join(run.dataDir, "projects.json")}\` = \`{"projects": [...the paths above]}\`.`,
    "",
    "## CLI oracle (`grove status --json`)",
    "",
    "| project | state | staged | unstaged | untracked | + | − | dirty age (s) | agent | risks (from `grove changes`) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...run.oracle.status.map(
      (p) =>
        `| ${p.displayName} | ${p.state} | ${p.stagedCount} | ${p.unstagedCount} | ${p.untrackedCount} | ${p.additions} | ${p.deletions} | ${p.dirtyAgeSeconds ?? "—"} | ${p.agent ?? "—"} | ${[...new Set((run.oracle.changes[p.path] ?? []).flatMap((f) => f.risk ?? []))].join(", ") || "—"} |`,
    ),
    "",
    ...invisibility,
    ...latencies,
    "## Scenarios",
    "",
    ...run.results.map(scenarioSection),
  ].join("\n");
  const reportPath = path.join(run.reportDir, "report.md");
  fs.writeFileSync(reportPath, body);
  return reportPath;
}
