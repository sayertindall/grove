#!/usr/bin/env node
// Desktop E2E: builds fixture repositories, launches the real debug binary
// headless (hidden window, no Dock icon, never frontmost) with a throwaway store
// and the automation socket, runs every scenario, and writes
// e2e/desktop/reports/<timestamp>/report.md. Exits 1 on any unexpected failure.
//
// Usage: cargo build --manifest-path src-tauri/Cargo.toml && node e2e/desktop/run.mjs
// (or `pnpm e2e:desktop`). GROVE_E2E_CHAT=1 also sends one chat turn to a
// loopback SSE stub. GROVE_E2E_BINARY overrides the binary path.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { binaryPath, ensureDevServer, launchApp, stopApp, tail } from "./lib/app.mjs";
import { buildFixtures } from "./lib/fixtures.mjs";
import { writeReport } from "./lib/report.mjs";
import { scenarios } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = path.join(here, "reports", stamp);
const shotsDir = path.join(reportDir, "screenshots");
fs.mkdirSync(shotsDir, { recursive: true });

const binary = binaryPath(repoRoot);
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grove-e2e-")));
const reposDir = path.join(workDir, "repos");
const dataDir = path.join(workDir, "data");
const socketPath = path.join(workDir, "automation.sock");
const appLog = path.join(reportDir, "app.log");
const viteLog = path.join(reportDir, "vite.log");

function frontmost() {
  try {
    return execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  } catch (error) {
    return `lsappinfo failed: ${error.message}`;
  }
}

/** The frontmost app's ASN and pid, so a run can prove grove never was it. */
function frontSample(at) {
  const asn = frontmost();
  let pid = null;
  try {
    const match = /"pid"=(\d+)/.exec(
      execFileSync("lsappinfo", ["info", "-only", "pid", asn], { encoding: "utf8" }),
    );
    pid = match ? Number(match[1]) : null;
  } catch {
    // Reported as an unknown pid.
  }
  return { at, asn, pid };
}

/** How LaunchServices sees the grove process: its ASN and ApplicationType. */
function launchServicesEntry(pid) {
  try {
    const info = execFileSync("lsappinfo", ["info", String(pid)], { encoding: "utf8" });
    return {
      pid,
      asn: /ASN:[^\s:]+:/.exec(info)?.[0] ?? null,
      type: /type="([^"]+)"/.exec(info)?.[1] ?? null,
    };
  } catch (error) {
    return { pid, asn: null, type: `lsappinfo failed: ${error.message}` };
  }
}

function cli(args) {
  return JSON.parse(
    execFileSync(binary, [...args, "--json"], {
      env: { ...process.env, GROVE_DATA_DIR: dataDir },
      encoding: "utf8",
    }),
  );
}

/** A loopback OpenAI-compatible SSE provider that streams one fixed answer. */
async function startChatStub() {
  const answer = "Stubbed answer from the loopback provider.";
  const bodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const settings = {
    provider: "openai-compatible",
    baseUrl,
    model: "stub",
    maxTokens: 256,
    temperature: null,
    allowCloudEgress: false,
    previewBeforeSend: true,
  };
  return {
    answer,
    baseUrl,
    settings,
    requests: () => bodies.length,
    lastBody: () => bodies.at(-1) ?? null,
    close: () => server.close(),
  };
}

/** Serializes the DOM including open shadow roots, for when WebKit gives no pixels. */
const DOM_SNAPSHOT = `
const serialize = (node) => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const attrs = [...node.attributes].map((a) => " " + a.name + '="' + a.value.replace(/"/g, "&quot;") + '"').join("");
  const shadow = node.shadowRoot ? "<template shadowrootmode=\\"open\\">" + [...node.shadowRoot.childNodes].map(serialize).join("") + "</template>" : "";
  const tag = node.tagName.toLowerCase();
  if (tag === "script") return "";
  return "<" + tag + attrs + ">" + shadow + [...node.childNodes].map(serialize).join("") + "</" + tag + ">";
};
return "<!doctype html>" + serialize(document.documentElement);`;

/** Retries a trivial eval until the page answers; returns how long that took. */
async function waitForResponsive(bridge, ms = 30_000) {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started < ms) {
    attempts += 1;
    try {
      if ((await bridge.eval("return true;")) === true)
        return { ms: Date.now() - started, attempts };
    } catch {
      // A lost or timed-out eval; ask again.
    }
  }
  throw new Error(`the page did not answer a trivial eval for ${ms} ms (${attempts} attempts)`);
}

/** After a reload, retries until the page answers and has rendered project rows. */
async function waitForRows(bridge, ms = 30_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < ms) {
    try {
      const ready = await bridge.eval(
        `return document.readyState === "complete" && document.querySelectorAll('ul[aria-label="Projects"] li button').length > 0;`,
      );
      if (ready) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `project rows never rendered after reload${last ? ` (last error: ${last.message})` : ""}`,
  );
}

/**
 * A Vite server the harness just started re-optimizes dependencies on the first
 * page load and then reloads the page once. Marks the page and waits until the
 * mark survives a quiet period, so no scenario runs into that reload.
 */
async function waitForSettledPage(bridge, quietMs = 3000, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await waitForRows(bridge);
    await bridge.eval(`window.__groveHarnessMark = true; return true;`);
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    const kept = await bridge.eval(`return window.__groveHarnessMark === true;`).catch(() => false);
    if (kept) return attempt;
  }
  throw new Error(`the page kept reloading for ${attempts} quiet periods of ${quietMs} ms`);
}

async function main() {
  const startedAt = new Date();
  const fronts = [frontSample("before fixtures")];
  const fixtures = buildFixtures(reposDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const registered = Object.values(fixtures.projects);
  fs.writeFileSync(
    path.join(dataDir, "projects.json"),
    JSON.stringify({ projects: registered }, null, 2),
  );

  const chatStub = process.env.GROVE_E2E_CHAT === "1" ? await startChatStub() : null;
  // A key in the environment short-circuits key resolution, so the debug binary
  // never reads the Keychain (which could raise a system access prompt).
  const extraEnv = { GROVE_CHAT_KEY: "e2e-placeholder-key" };
  if (chatStub) {
    fs.writeFileSync(path.join(dataDir, "chat-settings.json"), JSON.stringify(chatStub.settings));
    extraEnv.GROVE_CHAT_KEY = "stub-key";
  }

  const oracle = { status: cli(["status"]), changes: {} };
  for (const project of oracle.status.filter((p) => p.state === "dirty")) {
    oracle.changes[project.path] = cli(["changes", project.path])[0]?.files ?? [];
  }

  const commands = [
    "cargo build --manifest-path src-tauri/Cargo.toml",
    `${chatStub ? "GROVE_E2E_CHAT=1 " : ""}node e2e/desktop/run.mjs   # or: ${chatStub ? "GROVE_E2E_CHAT=1 " : ""}pnpm e2e:desktop`,
    `GROVE_DATA_DIR=${dataDir} GROVE_AUTOMATION_SOCKET=${socketPath} GROVE_CHAT_KEY=<placeholder> ${path.relative(repoRoot, binary)}  # spawned directly, never via open/LaunchServices`,
    `GROVE_DATA_DIR=${dataDir} ${path.relative(repoRoot, binary)} status --json`,
    `GROVE_DATA_DIR=${dataDir} ${path.relative(repoRoot, binary)} changes <project> --json`,
  ];

  const vite = await ensureDevServer(repoRoot, viteLog);
  const results = [];
  const presence = [];
  const stalls = [];
  const launches = [];
  const appExits = [];
  const latencies = [];
  let app = null;
  let fatal = null;
  let savedStorage = null;

  const start = async (label) => {
    app = await launchApp({ binary, dataDir, socketPath, logPath: appLog, extraEnv });
    launches.push({ at: label, ...launchServicesEntry(app.child.pid) });
    fronts.push(frontSample(`after ${label}`));
    presence.push({ at: `after ${label}`, ...(await app.bridge.presence()) });
  };

  try {
    await start("launch");
    // The dev origin's localStorage is shared with `pnpm tauri dev`; keep the
    // owner's UI preferences and put them back before quitting.
    savedStorage = await app.bridge.eval(`return JSON.stringify(localStorage);`);
    await app.bridge.eval(
      `localStorage.clear(); setTimeout(() => location.reload(), 20); return true;`,
    );
    await waitForSettledPage(app.bridge);

    let shotIndex = 0;
    let extraShots = [];
    const ctx = {
      get bridge() {
        return app.bridge;
      },
      fixtures,
      oracle,
      dataDir,
      chatStub,
      cli,
      /** Records a watcher latency for the report. */
      latency(label, ms) {
        latencies.push({ label, ms });
      },
      /** Quits the app and launches it again on the same store, still invisible. */
      async relaunch() {
        presence.push({ at: "before relaunch", ...(await app.bridge.presence()) });
        appExits.push({ at: "relaunch", ...(await stopApp(app)) });
        await start("relaunch");
        await waitForRows(app.bridge);
      },
      async shot(name, { extra = true } = {}) {
        shotIndex += 1;
        const base = path.join(shotsDir, `${String(shotIndex).padStart(2, "0")}-${name}`);
        let capture;
        try {
          await app.bridge.screenshot(`${base}.png`);
          capture = { path: path.relative(reportDir, `${base}.png`), kind: "webkit-png" };
        } catch (error) {
          fs.writeFileSync(`${base}.html`, await app.bridge.eval(DOM_SNAPSHOT));
          capture = {
            path: path.relative(reportDir, `${base}.html`),
            kind: "dom-snapshot",
            reason: error.message,
          };
        }
        // An eval sent right after a WebKit snapshot has been seen to never run;
        // wait until the page answers a trivial eval before the next step.
        const stall = await waitForResponsive(app.bridge);
        if (stall.ms > 1000) stalls.push({ after: name, ...stall });
        if (extra) extraShots.push({ name, ...capture });
        return capture;
      },
    };

    for (const scenario of scenarios(ctx)) {
      const checks = [];
      extraShots = [];
      const knownIssue = scenario.knownIssue?.() ?? null;
      const started = Date.now();
      let observed;
      let error = null;
      try {
        observed = await scenario.run(checks);
      } catch (caught) {
        error = caught.message;
      }
      const pass = error === null && checks.every((c) => c.pass);
      const shot = app.isAlive()
        ? await ctx
            .shot(scenario.name, { extra: false })
            .catch((e) => ({ path: null, kind: "none", reason: e.message }))
        : { path: null, kind: "none", reason: "app not running" };
      fronts.push(frontSample(`after ${scenario.name}`));
      const status = pass ? "PASS" : knownIssue ? "XFAIL" : "FAIL";
      results.push({
        name: scenario.name,
        expected: scenario.expected,
        checks,
        observed,
        error,
        status,
        knownIssue,
        shot,
        extraShots,
        ms: Date.now() - started,
      });
      console.log(
        `${status.padEnd(5)} ${scenario.name}${error ? ` — ${error.split("\n")[0]}` : ""}`,
      );
      if (!app.isAlive()) throw new Error(`the app exited during ${scenario.name}`);
    }
    presence.push({ at: "after scenarios", ...(await app.bridge.presence()) });
  } catch (error) {
    fatal = `${error.message}\n--- app log tail ---\n${tail(appLog)}`;
    console.error(fatal);
  } finally {
    if (app?.isAlive() && savedStorage !== null) {
      await app.bridge
        .eval(
          `localStorage.clear(); for (const [key, value] of Object.entries(JSON.parse(${JSON.stringify(savedStorage)}))) localStorage.setItem(key, value); return true;`,
        )
        .catch((error) => console.error(`localStorage restore failed: ${error.message}`));
    }
    if (app) appExits.push({ at: "end", ...(await stopApp(app)) });
    await vite.stop();
    chatStub?.close();
  }
  fronts.push(frontSample("after quit"));

  const unexpected = results.filter((r) => r.status === "FAIL").length;
  const grovePids = new Set(launches.map((l) => l.pid));
  const groveAsns = new Set(launches.map((l) => l.asn).filter(Boolean));
  const invisible =
    launches.length > 0 &&
    launches.every((l) => l.type === "BackgroundOnly") &&
    fronts.every((f) => !grovePids.has(f.pid) && !groveAsns.has(f.asn)) &&
    presence.length > 0 &&
    presence.every((p) => p.alpha === 0 && !p.keyWindow && !p.appActive);
  const ok = fatal === null && unexpected === 0 && invisible;
  const reportPath = writeReport({
    reportDir,
    repoRoot,
    startedAt,
    binary,
    workDir,
    dataDir,
    registered,
    fixtureSteps: fixtures.steps,
    commands,
    oracle,
    results,
    fatal,
    headless: { fronts, launches, presence, invisible },
    appExits,
    latencies,
    stalls,
    chat: chatStub !== null,
    viteStarted: vite.started,
    ok,
  });
  console.log(`\nreport: ${path.relative(repoRoot, reportPath)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
