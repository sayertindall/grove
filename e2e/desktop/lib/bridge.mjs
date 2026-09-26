// Client for the debug-build automation socket (src-tauri/src/automation.rs):
// newline-delimited JSON requests, one response line per request, matched by id.

import net from "node:net";

const REQUEST_TIMEOUT_MS = 15_000;

export class BridgeError extends Error {}

/** Connects to the socket, retrying until `deadlineMs` passes. */
export async function connectBridge(socketPath, { deadlineMs, isAlive }) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < deadlineMs) {
    if (!isAlive()) throw new BridgeError("the app exited before the automation socket was ready");
    try {
      return await openBridge(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new BridgeError(
    `the automation socket ${socketPath} was never ready after ${deadlineMs} ms` +
      (lastError ? ` (last error: ${lastError.message})` : ""),
  );
}

function openBridge(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(new Bridge(socket));
    });
  });
}

class Bridge {
  #socket;
  #buffer = "";
  #nextId = 1;
  #waiting = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("close", () => this.#failAll(new BridgeError("the automation socket closed")));
    socket.on("error", (error) => this.#failAll(new BridgeError(error.message)));
  }

  /** Runs `body` as an async function body in the webview and returns its JSON value. */
  eval(body) {
    return this.#request({ op: "eval", js: body });
  }

  /** Calls a registered Tauri command through the webview's IPC. */
  invoke(command, args = {}) {
    return this.#request({ op: "invoke", command, args });
  }

  screenshot(path) {
    return this.#request({ op: "screenshot", path });
  }

  /** `{ alpha, keyWindow, appActive, listedOnScreen }`, read on the app's main thread. */
  presence() {
    return this.#request({ op: "presence" });
  }

  quit() {
    return this.#request({ op: "quit" });
  }

  close() {
    this.#socket.end();
  }

  #request(fields) {
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new BridgeError(`${fields.op} got no response within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#socket.write(`${JSON.stringify({ id, ...fields })}\n`);
    });
  }

  #receive(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== "") this.#settle(JSON.parse(line));
    }
  }

  #settle(response) {
    const waiter = this.#waiting.get(response.id);
    if (waiter === undefined) return;
    this.#waiting.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.ok) waiter.resolve(response.value);
    else waiter.reject(new BridgeError(response.error));
  }

  #failAll(error) {
    for (const { reject, timer } of this.#waiting.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#waiting.clear();
  }
}
