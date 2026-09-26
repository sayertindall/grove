// Scenarios for the review cockpit: the change stream, viewed marks, the tour,
// the command palette, context and hunk navigation, image modes, conflicts,
// history, settings, deep links, and the assistant's quick actions.

import fs from "node:fs";
import path from "node:path";

import {
  WATCH_BUDGET_MS,
  check,
  openFile,
  readJson,
  timedExternalEdit,
  triageOrder,
  waitForStore,
} from "./lib/kit.mjs";
import { page } from "./lib/page.mjs";

const J = JSON.stringify;

/** Stream-layout scenarios; the app starts in this layout. */
export function cockpitScenarios(ctx) {
  const { projects } = ctx.fixtures;
  const reviewState = path.join(ctx.dataDir, "review-state.json");
  const viewedMarks = () => {
    try {
      return readJson(reviewState).reviewed ?? [];
    } catch {
      return [];
    }
  };
  const streamRow = (project, file) =>
    ctx.bridge.eval(
      page(
        `await setLayout("Stream"); return readStreamRow(await findStreamFile(${J(project)}, ${J(file)}));`,
      ),
    );
  return [
    {
      name: "stream-repo-headers",
      expected:
        "The Stream layout (the default) renders exactly one repo header per dirty project, each with the CLI's +n −n, and the header reads “N repos · M files”.",
      async run(checks) {
        const o = await ctx.bridge.eval(
          page(`
const layout = [...group("Layout").querySelectorAll("button")].find((b) => b.getAttribute("aria-pressed") === "true");
const defaultLayout = textOf(layout);
await setLayout("Stream");
const rows = await sweepStream();
return { defaultLayout, header: textOf(streamSection().querySelector("header")), repos: rows.filter((r) => r.kind === "repo"), files: rows.filter((r) => r.kind === "file").length };`),
        );
        const dirty = ctx.oracle.status.filter((p) => p.state === "dirty");
        const fileTotal = dirty.reduce((sum, p) => sum + ctx.oracle.changes[p.path].length, 0);
        check(checks, "default layout", "Stream", o.defaultLayout);
        check(
          checks,
          "one header per dirty project",
          dirty.map((p) => p.path).sort(),
          o.repos.map((r) => r.project).sort(),
        );
        for (const project of dirty) {
          const header = o.repos.find((r) => r.project === project.path);
          check(
            checks,
            `${project.displayName} +n −n`,
            [`+${project.additions}`, `−${project.deletions}`],
            [
              header?.leaves.includes(`+${project.additions}`) ||
              header?.text.includes(`+${project.additions}`)
                ? `+${project.additions}`
                : (header?.text ?? null),
              header?.text.includes(`−${project.deletions}`)
                ? `−${project.deletions}`
                : (header?.text ?? null),
            ],
          );
        }
        check(
          checks,
          "stream header counts",
          `${dirty.length} repos · ${fileTotal} files`,
          /\d+ repos · \d+ files/.exec(o.header)?.[0] ?? o.header,
        );
        check(checks, "file headers rendered while scrolling", fileTotal, o.files);
        return o;
      },
    },
    {
      name: "risk-chips",
      expected:
        "review-repo's .env (which gains an AWS-shaped key) carries the “secret?” and “env” chips, package-lock.json carries “lockfile” (and starts collapsed), long.txt carries none — matching `grove changes --json` risk.",
      async run(checks) {
        const chips = (row) =>
          row.leaves.filter((leaf) =>
            [
              "secret?",
              "env",
              "auth",
              "migration",
              "no-tests",
              "large",
              "lockfile",
              "generated",
            ].includes(leaf),
          );
        const env = await streamRow(projects.review, ".env");
        const lock = await streamRow(projects.review, "package-lock.json");
        const long = await streamRow(projects.review, "long.txt");
        const collapsed = await ctx.bridge.eval(
          page(`
const row = await findStreamFile(${J(projects.review)}, "package-lock.json");
row.scrollIntoView({ block: "center" });
await sleep(300);
return textOf(streamSection()).includes("Lockfile diff collapsed");`),
        );
        await ctx.shot("risk-chips-lockfile");
        check(checks, ".env chips", ["secret?", "env"], chips(env));
        check(checks, "package-lock.json chips", ["lockfile"], chips(lock));
        check(checks, "long.txt chips", [], chips(long));
        check(checks, "lockfile starts collapsed", true, collapsed);
        const cli = Object.fromEntries(
          ctx.oracle.changes[projects.review].map((file) => [file.path, file.risk]),
        );
        check(
          checks,
          "CLI risk",
          { ".env": ["secret", "env"], "package-lock.json": ["lockfile"], "long.txt": [] },
          {
            ".env": cli[".env"],
            "package-lock.json": cli["package-lock.json"],
            "long.txt": cli["long.txt"],
          },
        );
        return { env: env.text, lock: lock.text, long: long.text };
      },
    },
    {
      name: "submodule-stream-row",
      expected:
        "super-repo's vendor/sub stream row shows the “submodule” chip and old → new short commits equal to the fixture's commits.",
      async run(checks) {
        const row = await streamRow(projects.superRepo, "vendor/sub");
        const { oldCommit, newCommit } = ctx.fixtures.submodule;
        check(checks, "submodule chip", true, row.leaves.includes("submodule"));
        check(
          checks,
          "old → new",
          `submodule commit ${oldCommit.slice(0, 7)} to ${newCommit.slice(0, 7)}`,
          row.submodule,
        );
        check(
          checks,
          "visible shas",
          [oldCommit.slice(0, 7), newCommit.slice(0, 7)],
          row.leaves.filter((leaf) => /^[0-9a-f]{7}$/.test(leaf)),
        );
        return row;
      },
    },
    {
      name: "viewed-toggle",
      expected:
        "Ticking Viewed on review-repo's viewed.txt checks the box, the repo header reads 1 viewed, and review-state.json records the mark at the file's CLI contentHash.",
      async run(checks) {
        const hash = ctx.oracle.changes[projects.review].find(
          (f) => f.path === "viewed.txt",
        )?.contentHash;
        const o = await ctx.bridge.eval(
          page(`
const row = await findStreamFile(${J(projects.review)}, "viewed.txt");
row.querySelector('[role="checkbox"][aria-label="Viewed"]').click();
await waitFor(() => streamFileRow(${J(projects.review)}, "viewed.txt")?.querySelector('[role="checkbox"][aria-label="Viewed"]')?.getAttribute("aria-checked") === "true", "viewed checked");
const repo = [...streamSection().querySelectorAll('[data-stream-row="repo"]')].find((r) => r.dataset.project === ${J(projects.review)});
return { checked: true, progress: document.querySelector('[role="progressbar"][aria-label="review-repo viewed"]')?.getAttribute("aria-valuenow") ?? null, repoText: repo ? textOf(repo) : null };`),
        );
        const stored = await waitForStore(() =>
          viewedMarks().some(
            (mark) =>
              mark.projectPath === projects.review &&
              mark.filePath === "viewed.txt" &&
              mark.contentHash === hash,
          ),
        );
        check(checks, "box checked", true, o.checked);
        check(checks, "repo progress", "1", o.progress);
        check(checks, "mark stored at the CLI contentHash", true, stored);
        return { ...o, store: viewedMarks() };
      },
    },
    {
      name: "unviewed-filter",
      expected:
        "With the stream filter on Unviewed, viewed.txt disappears from the stream while review-repo's other files stay; All brings it back.",
      async run(checks) {
        const o = await ctx.bridge.eval(
          page(`
const filesOf = (rows) => rows.filter((r) => r.kind === "file" && r.project === ${J(projects.review)}).map((r) => r.file).sort();
await choose("Stream filter", "Unviewed");
await sleep(300);
const unviewed = filesOf(await sweepStream());
await choose("Stream filter", "All");
await sleep(300);
const all = filesOf(await sweepStream());
return { unviewed, all };`),
        );
        const reviewFiles = ctx.oracle.changes[projects.review].map((f) => f.path).sort();
        check(
          checks,
          "Unviewed hides the ticked file",
          reviewFiles.filter((f) => f !== "viewed.txt"),
          o.unviewed,
        );
        check(checks, "All shows every file", reviewFiles, o.all);
        return o;
      },
    },
    {
      name: "viewed-survives-relaunch",
      expected:
        "After quitting and relaunching the app (same store, still invisible), viewed.txt's Viewed box is still ticked.",
      async run(checks) {
        await ctx.relaunch();
        const row = await streamRow(projects.review, "viewed.txt");
        check(checks, "still viewed after relaunch", "true", row.viewed);
        return row;
      },
    },
    {
      name: "viewed-resets-on-external-edit",
      expected: `An external edit to viewed.txt changes its content hash, so its Viewed box clears (within ${WATCH_BUDGET_MS} ms of the write).`,
      async run(checks) {
        const edit = await timedExternalEdit(
          ctx,
          "edit to a viewed file → Viewed box clears",
          () => fs.appendFileSync(path.join(projects.review, "viewed.txt"), "viewed line 7\n"),
          `
await setLayout("Stream");
const row = await findStreamFile(${J(projects.review)}, "viewed.txt");
row.scrollIntoView({ block: "start" });
await sleep(200);
const box = () => streamFileRow(${J(projects.review)}, "viewed.txt")?.querySelector('[role="checkbox"][aria-label="Viewed"]')?.getAttribute("aria-checked");
if (box() !== "true") throw new Error("viewed.txt is not viewed before the edit: " + box());
return { probe: () => box() === "false" };`,
        );
        check(checks, "Viewed cleared", true, edit.updated);
        check(
          checks,
          `latency ≤ ${WATCH_BUDGET_MS} ms`,
          true,
          edit.latencyMs !== null && edit.latencyMs <= WATCH_BUDGET_MS,
        );
        return edit;
      },
    },
    {
      name: "tour-steps",
      expected:
        "The Tour layout covers every changed file across dirty projects; k steps forward and j steps back, and the step bar reads “file k of n”.",
      async run(checks) {
        const total = ctx
          .cli(["status"])
          .filter((p) => p.state === "dirty")
          .reduce((sum, p) => sum + ctx.cli(["changes", p.path])[0].files.length, 0);
        const o = await ctx.bridge.eval(
          page(`
await setLayout("Tour");
const bar = () => document.querySelector('[role="progressbar"][aria-label="Tour progress"]');
const read = () => ({ now: Number(bar()?.getAttribute("aria-valuenow")), max: Number(bar()?.getAttribute("aria-valuemax")), label: /file \\d+ of \\d+/.exec(textOf(document.body))?.[0] ?? null });
await waitFor(() => read().max > 0 && read().label, "tour steps");
const start = read();
press("k");
await waitFor(() => read().now === start.now + 1, "k steps forward");
const forward = read();
await sleep(300);
press("j");
await waitFor(() => read().now === start.now, "j steps back");
return { start, forward, back: read() };`),
        );
        check(checks, "n = changed files across dirty projects", total, o.start.max);
        check(checks, "start", `file ${o.start.now} of ${total}`, o.start.label);
        check(checks, "k", `file ${o.start.now + 1} of ${total}`, o.forward.label);
        check(checks, "j", `file ${o.start.now} of ${total}`, o.back.label);
        return o;
      },
    },
  ];
}

/** Scenarios in the File layout that need the viewer's newer controls. */
export function fileLayoutCockpitScenarios(ctx) {
  const { projects } = ctx.fixtures;
  return [
    {
      name: "command-palette",
      expected:
        "⌘K opens the palette; the Files scope lists review-repo's long.txt for “long”; Enter opens it in the File layout.",
      async run(checks) {
        const o = await ctx.bridge.eval(
          page(`
await setLayout("File");
await selectProject(${J(projects.dirty)});
press("k", { metaKey: true, code: "KeyK" });
const dialog = await waitFor(() => document.querySelector('[aria-label="Command palette"]'), "palette");
const tab = await waitFor(() => [...dialog.querySelectorAll('[role="tab"]')].find((t) => textOf(t).startsWith("Files")), "Files tab");
tab.click();
await waitFor(() => tab.getAttribute("aria-selected") === "true", "Files scope");
const input = dialog.querySelector('input[aria-label="Search repositories, files, and actions"]');
input.focus();
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "long");
input.dispatchEvent(new Event("input", { bubbles: true }));
const option = await waitFor(() => [...dialog.querySelectorAll('[role="option"]')].find((o) => textOf(o).includes("long.txt")), "long.txt option");
const listed = [...dialog.querySelectorAll('[role="option"]')].map(textOf);
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
await waitFor(() => !document.querySelector('[aria-label="Command palette"]'), "palette closed");
await waitFor(() => diffSection()?.getAttribute("aria-label") === "Diff of long.txt", "long.txt opened");
return { listed, opened: diffSection().getAttribute("aria-label"), selected: projectRow(${J(projects.review)})?.getAttribute("aria-current") ?? null };`),
        );
        check(
          checks,
          "Files scope lists long.txt",
          true,
          o.listed.some((t) => t.includes("long.txt")),
        );
        check(checks, "Enter opens it", "Diff of long.txt", o.opened);
        check(checks, "its project is selected", "true", o.selected);
        return o;
      },
    },
    {
      name: "context-lines",
      expected:
        "On long.txt (unchanged lines 1–19, edits on 20–59 and 280), Context 1 / 3 / All render 1 / 3 / 19 context rows above the first change, and the pane's summary reads 2 hunks · 255 hidden / 2 hunks · 247 hidden / 1 hunk · 0 hidden (the diff is virtualized, so rows are counted where they render: above the first hunk).",
      async run(checks) {
        await openFile(ctx, projects.review, "long.txt");
        const o = await ctx.bridge.eval(
          page(`
const read = () => {
  const lines = [...(diffRoot()?.querySelectorAll("[data-line]") ?? [])];
  const firstChange = lines.findIndex((n) => n.getAttribute("data-line-type").startsWith("change"));
  return {
    leading: lines.slice(0, firstChange).filter((n) => n.getAttribute("data-line-type").startsWith("context")).length,
    firstLine: Number(lines[0]?.getAttribute("data-line")),
    summary: /\\d+ hunks? · \\d+ lines? hidden/.exec(textOf(diffSection()))?.[0] ?? null,
  };
};
const result = {};
for (const choice of ["1", "All", "3"]) {
  const before = JSON.stringify(read());
  await choose("Context lines", choice, diffSection());
  await waitFor(() => JSON.stringify(read()) !== before, "context " + choice, 3000).catch(() => null);
  await sleep(300);
  result[choice] = read();
}
return result;`),
        );
        check(
          checks,
          "context rows above the first change",
          { 1: 1, 3: 3, All: 19 },
          { 1: o["1"]?.leading, 3: o["3"]?.leading, All: o.All?.leading },
        );
        check(
          checks,
          "first rendered line",
          { 1: 19, 3: 17, All: 1 },
          { 1: o["1"]?.firstLine, 3: o["3"]?.firstLine, All: o.All?.firstLine },
        );
        check(
          checks,
          "summary",
          {
            1: "2 hunks · 255 lines hidden",
            3: "2 hunks · 247 lines hidden",
            All: "1 hunk · 0 lines hidden",
          },
          { 1: o["1"]?.summary, 3: o["3"]?.summary, All: o.All?.summary },
        );
        return o;
      },
    },
    {
      name: "hunk-navigation",
      expected:
        "On long.txt, n moves the diff pane's scroll container down to hunk 2 of 2 and p moves it back up to hunk 1.",
      async run(checks) {
        await openFile(ctx, projects.review, "long.txt");
        const o = await ctx.bridge.eval(
          page(`
const position = () => textOf(diffSection().querySelector("[data-hunk-position]"));
const scroller = await waitFor(diffScroller, "scrolling diff pane");
scroller.scrollTop = 0;
await sleep(200);
const start = { position: position(), top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
press("n");
await waitFor(() => position() === "hunk 2 of 2", "hunk 2");
await waitFor(() => scroller.scrollTop > start.top + 100, "scrolled down", 3000).catch(() => null);
await sleep(300);
const next = { position: position(), top: scroller.scrollTop };
press("p");
await waitFor(() => position() === "hunk 1 of 2", "hunk 1");
await waitFor(() => scroller.scrollTop < next.top - 100, "scrolled up", 3000).catch(() => null);
await sleep(300);
return { start, next, back: { position: position(), top: scroller.scrollTop } };`),
        );
        check(checks, "starts at hunk 1", "hunk 1 of 2", o.start.position);
        check(checks, "n → hunk 2", "hunk 2 of 2", o.next.position);
        check(checks, "n scrolled down", true, o.next.top > o.start.top + 100);
        check(checks, "p → hunk 1", "hunk 1 of 2", o.back.position);
        check(checks, "p scrolled up", true, o.back.top < o.next.top - 100);
        return o;
      },
    },
    {
      name: "image-modes",
      expected:
        "logo.png (green → red) renders Swipe (divider slider), Onion (opacity slider), and Difference (a canvas and “100% of pixels changed”).",
      async run(checks) {
        await openFile(ctx, projects.dirty, "logo.png");
        const modes = {};
        for (const mode of ["Swipe", "Onion", "Difference"]) {
          modes[mode] = await ctx.bridge.eval(
            page(`
await choose("Image comparison", ${J(mode)}, diffSection());
const view = await waitFor(() => diffSection().querySelector('[data-testid="image-diff"][data-mode=${J(mode.toLowerCase())}]'), "mode ${mode}");
await sleep(300);
if (${J(mode)} === "Difference") await waitFor(() => /% of pixels changed/.test(textOf(view.querySelector('[data-testid="changed-share"]'))), "difference computed", 3000).catch(() => null);
const canvas = view.querySelector('canvas[data-testid="difference-canvas"]');
return {
  mode: view.dataset.mode,
  divider: view.querySelector('[role="slider"][aria-label="Swipe divider"]') !== null,
  opacity: view.querySelector('input[aria-label="After opacity"]') !== null,
  canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
  share: textOf(view.querySelector('[data-testid="changed-share"]')) || null,
};`),
          );
          await ctx.shot(`image-modes-${mode.toLowerCase()}`);
        }
        await ctx.bridge.eval(
          page(`await choose("Image comparison", "2-up", diffSection()); return true;`),
        );
        check(
          checks,
          "Swipe divider",
          { mode: "swipe", divider: true },
          { mode: modes.Swipe.mode, divider: modes.Swipe.divider },
        );
        check(
          checks,
          "Onion opacity",
          { mode: "onion", opacity: true },
          { mode: modes.Onion.mode, opacity: modes.Onion.opacity },
        );
        check(
          checks,
          "Difference canvas",
          { mode: "difference", canvas: true, share: "100% of pixels changed" },
          {
            mode: modes.Difference.mode,
            canvas: (modes.Difference.canvas?.width ?? 0) > 0,
            share: modes.Difference.share,
          },
        );
        return modes;
      },
    },
    {
      name: "conflict-view",
      expected:
        "conflict-repo's conflict.txt (a stopped merge) renders the three-column conflict view: every row has ours/base/theirs cells and the conflict row holds “ours line 4”, “shared line 4”, “theirs line 4” in that order.",
      async run(checks) {
        await openFile(ctx, projects.conflict, "conflict.txt");
        const o = await ctx.bridge.eval(
          page(`
const view = await waitFor(() => diffSection().querySelector('[data-testid="conflict-view"]'), "conflict view");
const table = view.querySelector('[role="table"]');
const rows = [...(table?.querySelectorAll('[role="row"]') ?? [])];
const cells = rows.map((row) => [...row.querySelectorAll('[role="cell"]')].map(textOf));
return {
  tableLabel: table?.getAttribute("aria-label") ?? null,
  columnCounts: [...new Set(cells.map((c) => c.length))],
  conflictRows: rows.filter((row) => row.hasAttribute("data-conflict")).map((row) => [...row.querySelectorAll('[role="cell"]')].map(textOf)),
  header: textOf(view).slice(0, 200),
};`),
        );
        check(checks, "table", "Conflict sides: ours, base, theirs", o.tableLabel);
        check(checks, "three cells per row", [3], o.columnCounts);
        const line4 = o.conflictRows.find((cells) => cells.some((c) => c.includes("line 4")));
        check(
          checks,
          "ours | base | theirs",
          [true, true, true],
          [
            line4?.[0]?.includes("ours line 4") ?? false,
            line4?.[1]?.includes("shared line 4") ?? false,
            line4?.[2]?.includes("theirs line 4") ?? false,
          ],
        );
        return o;
      },
    },
    {
      name: "history-panel",
      expected:
        "⌘Y opens the history panel for unstaged.txt; Blame lists one line per line of the working copy, the committed lines with a commit and the uncommitted ones as “not committed”; ⌘Y closes it. In a fresh Stream with no click or scroll, ⌘Y still opens the first file of the first dirty project.",
      async run(checks) {
        // Cold stream: ⌘Y with no click and no scroll must not be a silent no-op.
        // The stream's first row belongs to the first dirty project in sidebar
        // (triage) order, not raw CLI status order.
        const firstProject = triageOrder(ctx.oracle.status, ctx.oracle.changes).find(
          (projectPath) => (ctx.oracle.changes[projectPath]?.length ?? 0) > 0,
        );
        const firstFile = ctx.oracle.changes[firstProject][0].path;
        const cold = await ctx.bridge.eval(
          page(`
await setLayout("Stream");
await sleep(300);
press("y", { metaKey: true, code: "KeyY" });
const panel = await waitFor(() => document.querySelector('[data-testid="history-panel"]'), "history panel without any click or scroll");
const fileLayout = buttonNamed("File", group("Layout"))?.getAttribute("aria-pressed") === "true";
const label = panel.getAttribute("aria-label");
await sleep(300);
press("y", { metaKey: true, code: "KeyY" });
await waitFor(() => !document.querySelector('[data-testid="history-panel"]'), "cold history closed");
return { fileLayout, label };`),
        );
        await ctx.shot("history-panel-cold-stream");
        check(checks, "cold stream ⌘Y switches to the File layout", true, cold.fileLayout);
        check(
          checks,
          `cold stream ⌘Y opens the first file (${firstFile})`,
          `History of ${firstFile}`,
          cold.label,
        );
        await openFile(ctx, projects.dirty, "unstaged.txt");
        const lines = fs
          .readFileSync(path.join(projects.dirty, "unstaged.txt"), "utf8")
          .split("\n")
          .filter((line, index, all) => index < all.length - 1 || line !== "");
        const o = await ctx.bridge.eval(
          page(`
press("y", { metaKey: true, code: "KeyY" });
const panel = await waitFor(() => document.querySelector('[data-testid="history-panel"]'), "history panel");
await waitFor(() => panel.querySelectorAll('[data-testid="blame-line"]').length > 0, "blame lines");
await sleep(200);
const blame = [...panel.querySelectorAll('[data-testid="blame-line"]')].map((row) => [...row.querySelectorAll('[role="cell"]')].map(textOf));
return { label: panel.getAttribute("aria-label"), blame };`),
        );
        await ctx.shot("history-panel-open");
        o.closed = await ctx.bridge.eval(
          page(`
await sleep(300);
press("y", { metaKey: true, code: "KeyY" });
await waitFor(() => !document.querySelector('[data-testid="history-panel"]'), "history closed");
return true;`),
        );
        check(checks, "⌘Y closes it", true, o.closed);
        // From the stream, ⌘Y opens the focused file in the File layout with history showing.
        const fromStream = await ctx.bridge.eval(
          page(`
await setLayout("Stream");
const row = await findStreamFile(${J(projects.dirty)}, "unstaged.txt");
row.click();
await sleep(200);
press("y", { metaKey: true, code: "KeyY" });
const panel = await waitFor(() => document.querySelector('[data-testid="history-panel"]'), "history panel from stream");
const fileLayout = buttonNamed("File", group("Layout"))?.getAttribute("aria-pressed") === "true";
const label = panel.getAttribute("aria-label");
await sleep(300);
press("y", { metaKey: true, code: "KeyY" });
await waitFor(() => !document.querySelector('[data-testid="history-panel"]'), "history closed again");
return { fileLayout, label };`),
        );
        await ctx.shot("history-panel-from-stream");
        check(checks, "stream ⌘Y switches to the File layout", true, fromStream.fileLayout);
        check(
          checks,
          "stream ⌘Y shows that file's history",
          "History of unstaged.txt",
          fromStream.label,
        );
        check(checks, "panel label", "History of unstaged.txt", o.label);
        check(
          checks,
          "one blame line per working-copy line",
          lines,
          o.blame.map((cells) => cells[2]),
        );
        check(
          checks,
          "uncommitted lines marked",
          true,
          o.blame.some((cells) => cells[0].includes("not committed")),
        );
        check(
          checks,
          "committed lines carry a commit",
          true,
          o.blame.some((cells) => /[0-9a-f]{7}/.test(cells[0])),
        );
        return { label: o.label, lines: o.blame.length, first: o.blame.slice(0, 3) };
      },
    },
    {
      name: "settings-panel",
      expected: "⌘, opens the Settings panel with its sections; Close settings dismisses it.",
      async run(checks) {
        const o = await ctx.bridge.eval(
          page(`
press(",", { metaKey: true, code: "Comma" });
const panel = await waitFor(() => document.querySelector('[aria-label="Settings"]'), "settings panel");
const sections = [...(panel.querySelector('nav[aria-label="Settings sections"]')?.querySelectorAll("button, a") ?? [])].map(textOf);
return { sections, text: textOf(panel).slice(0, 200) };`),
        );
        await ctx.shot("settings-panel-open");
        const closed = await ctx.bridge.eval(
          page(`
document.querySelector('[aria-label="Close settings"]').click();
await waitFor(() => !document.querySelector('[aria-label="Settings"]'), "settings closed");
return true;`),
        );
        check(
          checks,
          "sections",
          true,
          o.sections.includes("General") &&
            o.sections.includes("Keyboard") &&
            o.sections.includes("About"),
        );
        check(checks, "closes", true, closed);
        return o;
      },
    },
    {
      name: "deep-link-navigate",
      expected:
        "A `grove://navigate` event (the one deep links emit, dispatched through the webview's event IPC so nothing is brought forward) selects review-repo and opens viewed.txt; an unregistered project shows the inline notice instead.",
      async run(checks) {
        await ctx.bridge.eval(
          page(`await setLayout("File"); await selectProject(${J(projects.dirty)}); return true;`),
        );
        await ctx.bridge.invoke("plugin:event|emit", {
          event: "grove://navigate",
          payload: { project: projects.review, file: "viewed.txt", registered: true },
        });
        const o = await ctx.bridge.eval(
          page(`
await waitFor(() => diffSection()?.getAttribute("aria-label") === "Diff of viewed.txt", "viewed.txt opened");
return { opened: diffSection().getAttribute("aria-label"), selected: projectRow(${J(projects.review)})?.getAttribute("aria-current") ?? null };`),
        );
        const missing = path.join(path.dirname(projects.review), "not-registered-repo");
        await ctx.bridge.invoke("plugin:event|emit", {
          event: "grove://navigate",
          payload: { project: missing, file: null, registered: false },
        });
        const notice = await ctx.bridge.eval(
          page(
            `return await waitFor(() => textOf(document.body).includes("which is not a registered project") ? textOf(document.body).match(/A grove:\\/\\/ link asked for [^.]*\\./)?.[0] ?? true : null, "unregistered notice");`,
          ),
        );
        check(checks, "file opened", "Diff of viewed.txt", o.opened);
        check(checks, "project selected", "true", o.selected);
        check(
          checks,
          "unregistered notice",
          `A grove:// link asked for ${missing}, which is not a registered project.`,
          notice,
        );
        return { ...o, notice };
      },
    },
  ];
}

/** The assistant: a loopback quick action, and the cloud refusal sheet. */
export function chatScenarios(ctx) {
  const { projects } = ctx.fixtures;
  // `__TAURI_INTERNALS__.invoke` is read-only, so a turn is observed through the
  // events every chat_send emits (egress per request, then done or error).
  const spy = `
if (!window.__groveChatEvents) {
  window.__groveChatEvents = [];
  for (const event of ["grove://chat-egress", "grove://chat-done", "grove://chat-error"]) {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event,
      target: { kind: "Any" },
      handler: window.__TAURI_INTERNALS__.transformCallback((e) => window.__groveChatEvents.push({ event: e.event, loopback: e.payload?.loopback ?? null })),
    });
  }
}
window.__groveChatEvents.length = 0;
window.__grovePreSendSeen = false;
window.__grovePreSendObserver?.disconnect();
window.__grovePreSendObserver = new MutationObserver(() => {
  if (document.querySelector('[role="dialog"][aria-labelledby="pre-send-title"]')) window.__grovePreSendSeen = true;
});
window.__grovePreSendObserver.observe(document.body, { childList: true, subtree: true });`;
  const openAssistant = `
const toggle = document.querySelector('button[aria-label="Toggle chat"]');
if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
const panel = await waitFor(() => document.querySelector('aside[aria-label="Assistant"]'), "assistant panel");`;
  return [
    {
      name: "chat-quick-action",
      expected: ctx.chatStub
        ? "With unstaged.txt open, the Assistant's “Explain file” quick action sends one turn to the loopback stub without the pre-send sheet (loopback never leaves the machine) and renders the stubbed answer."
        : "Toggle chat opens the Assistant with its quick actions (no turn is sent; set GROVE_E2E_CHAT=1 to send one to a loopback stub).",
      async run(checks) {
        await openFile(ctx, projects.dirty, "unstaged.txt");
        const opened = await ctx.bridge.eval(
          page(`${openAssistant}
return [...(panel.querySelector('[role="toolbar"][aria-label="Quick actions"]')?.querySelectorAll("button") ?? [])].map(textOf);`),
        );
        check(checks, "quick actions", true, opened.includes("Explain file"));
        if (!ctx.chatStub) return opened;
        const before = ctx.chatStub.requests();
        const o = await ctx.bridge.eval(
          page(`${spy}
${openAssistant}
buttonNamed("Explain file", panel.querySelector('[role="toolbar"][aria-label="Quick actions"]')).click();
const answer = await waitFor(() => [...panel.querySelectorAll('[aria-label="Assistant answer"]')].find((node) => textOf(node).includes(${J(ctx.chatStub.answer)})), "stub answer", 8000);
await sleep(300);
window.__grovePreSendObserver.disconnect();
return { answer: textOf(answer), question: textOf([...panel.querySelectorAll('[aria-label="Your question"]')].at(-1)), sheetSeen: window.__grovePreSendSeen, events: [...window.__groveChatEvents] };`),
        );
        check(checks, "stub answer rendered", true, o.answer.includes(ctx.chatStub.answer));
        check(checks, "pre-send sheet never shown (loopback)", false, o.sheetSeen);
        check(
          checks,
          "turn events: egress (loopback) then done",
          [
            { event: "grove://chat-egress", loopback: true },
            { event: "grove://chat-done", loopback: null },
          ],
          o.events,
        );
        check(checks, "stub received one request", before + 1, ctx.chatStub.requests());
        check(
          checks,
          "request carries the templated question",
          true,
          (ctx.chatStub.lastBody() ?? "").includes("Explain the changes to unstaged.txt"),
        );
        return { ...o, stubRequests: ctx.chatStub.requests() };
      },
    },
    {
      name: "chat-cloud-sheet",
      expected:
        "With settings pointing at a cloud host (baseUrl http://example.invalid, allowCloudEgress=false), “Explain file” measures the turn locally and shows the “Leaving this machine” sheet with its parts and the egress refusal; Cancel closes it, no turn starts (no chat-egress/done/error event), and nothing reaches any provider.",
      async run(checks) {
        const restore = ctx.chatStub
          ? ctx.chatStub.settings
          : await ctx.bridge.invoke("chat_settings", {});
        const current = await ctx.bridge.invoke("chat_settings", {});
        await ctx.bridge.invoke("set_chat_settings", {
          settings: {
            ...current,
            provider: "openai-compatible",
            baseUrl: "http://example.invalid",
            model: "cloud-model",
            allowCloudEgress: false,
            previewBeforeSend: true,
          },
        });
        const before = ctx.chatStub?.requests() ?? 0;
        let o;
        try {
          // The panel reads settings when it mounts; reload so it sees the cloud host.
          await ctx.bridge.eval(`setTimeout(() => location.reload(), 20); return true;`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          for (let started = Date.now(); Date.now() - started < 20_000;) {
            const ready = await ctx.bridge
              .eval(
                `return document.readyState === "complete" && document.querySelectorAll('ul[aria-label="Projects"] li button').length > 0;`,
              )
              .catch(() => false);
            if (ready) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          await openFile(ctx, projects.dirty, "unstaged.txt");
          o = await ctx.bridge.eval(
            page(`${spy}
${openAssistant}
await sleep(300);
const answersBefore = panel.querySelectorAll('[aria-label="Assistant answer"]').length;
buttonNamed("Explain file", panel.querySelector('[role="toolbar"][aria-label="Quick actions"]')).click();
const sheet = await waitFor(() => document.querySelector('[role="dialog"][aria-labelledby="pre-send-title"]'), "pre-send sheet", 8000);
await sleep(300);
const result = {
  title: textOf(sheet.querySelector("#pre-send-title")),
  refusal: textOf(sheet.querySelector('[role="alert"]')) || null,
  rows: [...(sheet.querySelector('ul[aria-label="What will be sent"]')?.querySelectorAll("li") ?? [])].map(textOf),
  buttons: [...sheet.querySelectorAll("button")].map(textOf),
  answersBefore,
};
return result;`),
          );
          await ctx.shot("chat-cloud-sheet-open");
          const after = await ctx.bridge.eval(
            page(`
const sheet = document.querySelector('[role="dialog"][aria-labelledby="pre-send-title"]');
buttonNamed("Cancel", sheet).click();
await waitFor(() => !document.querySelector('[role="dialog"][aria-labelledby="pre-send-title"]'), "sheet closed");
await sleep(500);
window.__grovePreSendObserver.disconnect();
return { events: [...window.__groveChatEvents], answers: document.querySelectorAll('[aria-label="Assistant answer"]').length };`),
          );
          o = { ...o, ...after };
        } finally {
          await ctx.bridge.invoke("set_chat_settings", { settings: { ...current, ...restore } });
        }
        check(checks, "sheet title", "Leaving this machine", o.title);
        check(checks, "egress refusal shown", true, /cloud egress is off/i.test(o.refusal ?? ""));
        check(
          checks,
          "sheet lists the measured parts",
          true,
          o.rows.some((row) => row.startsWith("Your question")) &&
            o.rows.some((row) => row.includes("unstaged.txt")),
        );
        check(checks, "no turn started (no chat events)", [], o.events);
        check(checks, "no answer added", o.answersBefore, o.answers);
        check(checks, "loopback stub untouched", before, ctx.chatStub?.requests() ?? 0);
        return o;
      },
    },
  ];
}
