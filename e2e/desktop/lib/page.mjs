// Helpers evaluated inside the real webview before each scenario step. They only
// read the DOM and dispatch the clicks and keys a person would make.

export const PAGE_HELPERS = String.raw`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (node) => (node?.innerText ?? node?.textContent ?? "").replace(/\s+/g, " ").trim();
const waitFor = async (probe, label, ms = 5000) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < ms) {
    last = await probe();
    if (last) return last;
    await sleep(25);
  }
  throw new Error("timed out after " + ms + " ms waiting for " + label);
};
const buttonNamed = (name, scope = document) =>
  [...(scope?.querySelectorAll("button") ?? [])].find((button) => textOf(button) === name);
const group = (label, scope = document) => scope?.querySelector('[role="group"][aria-label="' + label + '"]') ?? null;
const pressed = (label, name) => buttonNamed(name, group(label))?.getAttribute("aria-pressed") === "true";
const choose = async (label, name, scope = document) => {
  const button = await waitFor(() => buttonNamed(name, group(label, scope)), label + " › " + name);
  if (button.getAttribute("aria-pressed") !== "true") button.click();
  await waitFor(() => buttonNamed(name, group(label, scope))?.getAttribute("aria-pressed") === "true", label + " › " + name + " pressed");
};
/** A key press as the window's keydown listeners see it (target: the body). */
const press = (key, init = {}) => {
  const code = init.code ?? (key.length === 1 && /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : key);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...init }));
};
const leafTexts = (scope) =>
  [...(scope?.querySelectorAll("span") ?? [])].filter((node) => node.children.length === 0).map(textOf);

// --- Sidebar ---------------------------------------------------------------
const projectList = () => document.querySelector('ul[aria-label="Projects"]');
const projectRows = () => [...(projectList()?.querySelectorAll("li button[title]") ?? [])];
const projectRow = (path) =>
  projectRows().find((row) => row.title === path || row.title.startsWith(path + " · "));
const cleanToggle = () => projectList()?.querySelector("li > button[aria-expanded]") ?? null;
const expandClean = async () => {
  const toggle = cleanToggle();
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
    toggle.click();
    await waitFor(() => cleanToggle()?.getAttribute("aria-expanded") === "true", "CLEAN expanded");
  }
};
const selectProject = async (path) => {
  if (!projectRow(path)) await expandClean();
  const row = await waitFor(() => projectRow(path), "sidebar row " + path);
  row.click();
  await waitFor(() => projectRow(path)?.getAttribute("aria-current") === "true", "row selected " + path);
};

// --- Layout ----------------------------------------------------------------
const setLayout = async (name) => {
  await choose("Layout", name);
  // A clean or missing project has no changed-files pane in the File layout.
  if (name === "Stream") await waitFor(() => document.querySelector('section[aria-label="Change stream"]'), "stream layout");
  if (name === "Tour") await waitFor(() => document.querySelector('nav[aria-label="Tour"]'), "tour layout");
};

// --- File layout: tree and diff pane ---------------------------------------
const treeHost = () => document.querySelector("file-tree-container");
const changesSection = () => document.querySelector('section[aria-label="Changed files"]');
const changesCount = () => {
  const match = /(\d+) files?/.exec(textOf(changesSection()?.querySelector("header")));
  return match ? Number(match[1]) : null;
};
const treePaths = () =>
  [...(treeHost()?.shadowRoot?.querySelectorAll('[data-item-type="file"]') ?? [])].map((row) =>
    row.getAttribute("data-item-path"),
  );
const treeRow = (path) => treeHost()?.shadowRoot?.querySelector('[data-item-path="' + CSS.escape(path) + '"]');
const diffSection = () => document.querySelector('section[aria-label^="Diff of"]');
const diffHeader = () => textOf(diffSection()?.querySelector("header"));
const diffBody = () => textOf(diffSection());
const diffRoot = () => diffSection()?.querySelector("diffs-container")?.shadowRoot ?? null;
const diffRows = () => {
  const root = diffRoot();
  if (!root) return null;
  const count = (selector) => root.querySelectorAll("[data-line]" + selector).length;
  return {
    additions: count('[data-line-type="change-addition"]'),
    deletions: count('[data-line-type="change-deletion"]'),
    context: count('[data-line-type^="context"]'),
    layout: root.querySelector("pre")?.getAttribute("data-diff-type") ?? null,
    columns: root.querySelectorAll("[data-code]").length,
  };
};
/** The element that scrolls the open diff (the pane, not the page). */
const diffScroller = () =>
  [diffSection(), ...(diffSection()?.querySelectorAll("*") ?? [])].find(
    (node) => node && node.scrollHeight > node.clientHeight + 4 && ["auto", "scroll"].includes(getComputedStyle(node).overflowY),
  ) ?? null;
const whitespaceBox = () =>
  [...(diffSection()?.querySelectorAll("label") ?? [])]
    .find((label) => textOf(label).includes("Hide whitespace"))
    ?.querySelector('[role="checkbox"]');
const selectFile = async (path) => {
  const row = await waitFor(() => treeRow(path), "tree row " + path);
  row.click();
  await waitFor(() => diffSection()?.getAttribute("aria-label") === "Diff of " + path, "diff pane for " + path);
  await waitFor(() => !diffBody().includes("Loading…"), "diff loaded for " + path);
  await sleep(150);
};

// --- Stream layout ---------------------------------------------------------
const streamSection = () => document.querySelector('section[aria-label="Change stream"]');
const streamScroller = () =>
  [...(streamSection()?.querySelectorAll("div") ?? [])].find((node) => ["auto", "scroll"].includes(getComputedStyle(node).overflowY)) ?? null;
const streamFileRow = (project, file) =>
  [...(streamSection()?.querySelectorAll('[data-stream-row="file"]') ?? [])].find(
    (row) => row.dataset.project === project && row.querySelector('[title="' + CSS.escape(file) + '"]'),
  ) ?? null;
const readStreamRow = (row) => ({
  kind: row.dataset.streamRow,
  id: row.dataset.id,
  project: row.dataset.project,
  file: row.dataset.streamRow === "file" ? row.querySelector("span[title]")?.getAttribute("title") ?? null : null,
  text: textOf(row),
  leaves: leafTexts(row),
  viewed: row.querySelector('[role="checkbox"][aria-label="Viewed"]')?.getAttribute("aria-checked") ?? null,
  submodule: row.querySelector('[aria-label^="submodule commit"]')?.getAttribute("aria-label") ?? null,
});
/** Scrolls the virtualized stream top to bottom and returns every row it rendered, once each. */
const sweepStream = async () => {
  const scroller = await waitFor(streamScroller, "stream scroller");
  const seen = new Map();
  scroller.scrollTop = 0;
  await sleep(250);
  for (let guard = 0; guard < 200; guard++) {
    for (const row of streamSection().querySelectorAll("[data-stream-row]")) {
      const entry = readStreamRow(row);
      seen.set(entry.id, entry);
    }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
    scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.7));
    await sleep(120);
  }
  scroller.scrollTop = 0;
  await sleep(150);
  return [...seen.values()];
};
/** Scrolls until the file's header row is rendered and returns it. */
const findStreamFile = async (project, file) => {
  const scroller = await waitFor(streamScroller, "stream scroller");
  scroller.scrollTop = 0;
  await sleep(200);
  for (let guard = 0; guard < 200; guard++) {
    const row = streamFileRow(project, file);
    if (row) return row;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
    scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.7));
    await sleep(120);
  }
  throw new Error("stream row for " + file + " never rendered");
};
`;

/** Wraps a scenario step so it runs after the helpers. */
export function page(body) {
  return `${PAGE_HELPERS}\n${body}`;
}
