// Launches the real debug binary (and the Vite dev server its debug build loads
// from), connects the automation bridge, and tears both down.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BridgeError, connectBridge } from "./bridge.mjs";

const DEV_URL = "http://localhost:1420/";
const VITE_READY_MS = 60_000;
const SOCKET_READY_MS = 30_000;
const PAGE_READY_MS = 30_000;

async function devServerUp() {
  try {
    const response = await fetch(DEV_URL, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Vite serves `/@fs/<path>` only inside its own root, so this proves which checkout it serves. */
async function servesCheckout(repoRoot) {
  try {
    const url = new URL(`/@fs${path.join(repoRoot, "src", "main.tsx")}`, DEV_URL);
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A debug build (`cargo build` without the custom-protocol feature) loads the
 * frontend from the dev URL, so the Vite server must be up. An already running
 * one (from `pnpm tauri dev`) is reused and left alone, but only if it serves
 * this checkout; one serving another directory would test the wrong frontend.
 */
export async function ensureDevServer(repoRoot, logPath) {
  if (await devServerUp()) {
    if (!(await servesCheckout(repoRoot))) {
      throw new Error(
        `${DEV_URL} is served by a Vite server for another directory; stop it (port 1420) and rerun`,
      );
    }
    return { started: false, stop: async () => {} };
  }
  const log = fs.openSync(logPath, "a");
  const vite = spawn("pnpm", ["dev", "--strictPort"], {
    cwd: repoRoot,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const started = Date.now();
  while (Date.now() - started < VITE_READY_MS) {
    if (vite.exitCode !== null)
      throw new Error(`pnpm dev exited with ${vite.exitCode}; see ${logPath}`);
    if (await devServerUp()) {
      return { started: true, stop: async () => stopGroup(vite) };
    }
    await sleep(250);
  }
  stopGroup(vite);
  throw new Error(
    `the Vite dev server was not serving ${DEV_URL} after ${VITE_READY_MS} ms; see ${logPath}`,
  );
}

function stopGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** Starts the app with the throwaway store and the automation socket. */
export async function launchApp({ binary, dataDir, socketPath, logPath, extraEnv = {} }) {
  if (!fs.existsSync(binary)) {
    throw new Error(
      `${binary} does not exist; run cargo build --manifest-path src-tauri/Cargo.toml`,
    );
  }
  const log = fs.openSync(logPath, "a");
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      GROVE_DATA_DIR: dataDir,
      GROVE_AUTOMATION_SOCKET: socketPath,
      ...extraEnv,
    },
    stdio: ["ignore", log, log],
  });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const isAlive = () => child.exitCode === null && child.signalCode === null;

  let bridge;
  try {
    bridge = await connectBridge(socketPath, { deadlineMs: SOCKET_READY_MS, isAlive });
    await waitForPage(bridge, isAlive);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n--- app log (${logPath}) ---\n${tail(logPath)}`);
  }
  return { child, bridge, exit, isAlive, logPath };
}

/** The page is ready once React has rendered the project list. */
async function waitForPage(bridge, isAlive) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < PAGE_READY_MS) {
    if (!isAlive()) throw new BridgeError("the app exited while the page was loading");
    try {
      const ready = await bridge.eval(
        `return document.readyState === "complete" && document.querySelector('ul[aria-label="Projects"]') !== null;`,
      );
      if (ready) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new BridgeError(
    `the project list never rendered after ${PAGE_READY_MS} ms` +
      (lastError ? ` (last error: ${lastError.message})` : ""),
  );
}

/** Asks the app to quit, then forces it if it does not exit in time. */
export async function stopApp(app) {
  if (app.isAlive()) {
    await app.bridge.quit().catch(() => {});
  }
  const exited = await Promise.race([app.exit, sleep(5000).then(() => null)]);
  if (exited === null) {
    app.child.kill("SIGKILL");
    return { forced: true, ...(await app.exit) };
  }
  return { forced: false, ...exited };
}

export function tail(logPath, lines = 40) {
  try {
    return fs.readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function binaryPath(repoRoot) {
  return (
    process.env.GROVE_E2E_BINARY ?? path.join(repoRoot, "src-tauri", "target", "debug", "grove")
  );
}
