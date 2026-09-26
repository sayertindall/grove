// Each scenario drives the real app through the automation bridge the way a
// person would (click a row, press a key, edit a file on disk) and compares what
// the window shows against the CLI, which reads the same store.
//
// Order matters: the app starts in the Stream layout (the shipped default), so
// the stream, review and tour scenarios run first; the single-file scenarios
// then switch the Layout control to File.

import fs from "node:fs";
import path from "node:path";

import { cockpitScenarios, chatScenarios, fileLayoutCockpitScenarios } from "./cockpit.mjs";
import {
  WATCH_BUDGET_MS,
  check,
  dirtyCount,
  formatAge,
  openFile,
  projectRisks,
  RISK_LABEL,
  summaryOf,
  timedExternalEdit,
  titleCounts,
  triageOrder,
  waitForStore,
} from "./lib/kit.mjs";
import { page } from "./lib/page.mjs";

export function scenarios(ctx) {
  return [
    sidebarMatchesCli(ctx),
    ...cockpitScenarios(ctx),
    ...viewerScenarios(ctx),
    ...fileLayoutCockpitScenarios(ctx),
    ...lifecycleScenarios(ctx),
    ...chatScenarios(ctx),
  ];
}

function sidebarMatchesCli(ctx) {
  return {
    name: "sidebar-matches-cli",
    expected:
      "One sidebar row per registered project in the default triage order (clean projects last, in the CLEAN section), whose staged/unstaged/untracked counts, +/− totals, “N dirty · age · agent” facts, risk chips, worktree label, and missing state equal `grove status --json` / `grove changes --json` (dirtyAgeSeconds, agent, risk).",
    async run(checks) {
      const rows = await ctx.bridge.eval(
        page(`
await expandClean();
return projectRows().map((row) => ({ title: row.title, text: textOf(row), leaves: leafTexts(row) }));`),
      );
      const fresh = ctx.cli(["status"]);
      const pathOf = (row) => row.title.split(" · ")[0];
      check(
        checks,
        "row order (triage: dirty × risk × age, clean last)",
        triageOrder(ctx.oracle.status, ctx.oracle.changes),
        rows.map(pathOf),
      );
      const labels = new Set(Object.values(RISK_LABEL));
      for (const project of ctx.oracle.status) {
        const row = rows.find((r) => pathOf(r) === project.path);
        const name = project.displayName;
        check(
          checks,
          `${name} counts`,
          {
            staged: project.stagedCount,
            unstaged: project.unstagedCount,
            untracked: project.untrackedCount,
          },
          row ? titleCounts(row.title) : null,
        );
        const plus = project.additions > 0 ? `+${project.additions}` : null;
        const minus = project.deletions > 0 ? `−${project.deletions}` : null;
        check(
          checks,
          `${name} line totals`,
          [plus, minus],
          [
            plus && row?.text.includes(plus) ? plus : null,
            minus && row?.text.includes(minus) ? minus : null,
          ],
        );
        if (project.state === "dirty") {
          check(
            checks,
            `${name} dirty count`,
            `${dirtyCount(project)} dirty`,
            /(\d+ dirty) · /.exec(row?.text ?? "")?.[1] ?? null,
          );
          const now = fresh.find((p) => p.path === project.path)?.dirtyAgeSeconds ?? 0;
          const allowed = new Set();
          for (let age = project.dirtyAgeSeconds ?? 0; age <= now + 2; age += 1)
            allowed.add(formatAge(age));
          const shown = /dirty · (\d+[smhdw])/.exec(row?.text ?? "")?.[1] ?? null;
          check(
            checks,
            `${name} dirty age (CLI ${project.dirtyAgeSeconds}s at start, ${now}s now)`,
            true,
            shown !== null && allowed.has(shown),
          );
          check(
            checks,
            `${name} risk chips`,
            projectRisks(ctx.oracle.changes[project.path] ?? []).map((r) => RISK_LABEL[r]),
            (row?.leaves ?? []).filter((leaf) => labels.has(leaf)),
          );
        }
        check(
          checks,
          `${name} agent`,
          project.agent === null ? false : `agent: ${project.agent}`,
          project.agent === null
            ? (row?.text.includes("agent:") ?? false)
            : row?.text.includes(`agent: ${project.agent}`)
              ? `agent: ${project.agent}`
              : (row?.text ?? null),
        );
        if (project.worktreeOf !== null)
          check(
            checks,
            `${name} worktree label`,
            true,
            row?.text.includes(`worktree of ${path.basename(project.worktreeOf)}`) ?? false,
          );
        if (project.state === "missing")
          check(checks, `${name} missing label`, true, row?.text.includes("missing") ?? false);
      }
      return rows.map((r) => r.text);
    },
  };
}

function viewerScenarios(ctx) {
  const { projects } = ctx.fixtures;
  return [
    {
      name: "clean-project",
      expected: "In the File layout, selecting clean-repo shows “Working tree matches HEAD”.",
      async run(checks) {
        const text = await ctx.bridge.eval(
          page(
            `await setLayout("File"); await selectProject(${JSON.stringify(projects.clean)}); await waitFor(() => textOf(document.body).includes("Working tree matches HEAD"), "empty state", 3000).catch(() => null); return textOf(document.querySelector("#grove-main") ?? document.body);`,
          ),
        );
        check(checks, "empty state", true, text.includes("Working tree matches HEAD"));
        return text.slice(0, 400);
      },
    },
    {
      name: "dirty-project-tree",
      expected:
        "Selecting dirty-repo lists exactly the files `grove changes --json` lists, and the header count equals their number.",
      async run(checks) {
        const observed = await ctx.bridge.eval(
          page(`
await setLayout("File");
await selectProject(${JSON.stringify(projects.dirty)});
await waitFor(() => changesCount() !== null && treePaths().length > 0, "changes count");
await sleep(200);
return { count: changesCount(), paths: treePaths().sort() };`),
        );
        const expected = ctx.oracle.changes[projects.dirty].map((c) => c.path).sort();
        check(checks, "header count", expected.length, observed.count);
        check(checks, "tree paths", expected, observed.paths);
        return observed;
      },
    },
    {
      name: "text-diff-unstaged",
      expected:
        "unstaged.txt renders a unified text diff whose added/removed rows equal the CLI's +/− for that file.",
      async run(checks) {
        const s = summaryOf(ctx, projects.dirty, "unstaged.txt");
        const o = await openFile(ctx, projects.dirty, "unstaged.txt");
        check(
          checks,
          "rendered rows",
          { additions: s.additions, deletions: s.deletions, layout: "single" },
          { additions: o.rows?.additions, deletions: o.rows?.deletions, layout: o.rows?.layout },
        );
        check(
          checks,
          "header totals",
          true,
          o.header.includes(`+${s.additions}`) && o.header.includes(`−${s.deletions}`),
        );
        return o.header;
      },
    },
    {
      name: "staged-file",
      expected: "staged.txt carries the “staged” badge and renders its one-line change.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "staged.txt");
        check(
          checks,
          "staged badge",
          true,
          / staged( |$)/.test(o.header) && !o.header.includes("partially staged"),
        );
        check(
          checks,
          "rendered rows",
          { additions: 1, deletions: 1 },
          { additions: o.rows?.additions, deletions: o.rows?.deletions },
        );
        return o.header;
      },
    },
    {
      name: "partially-staged-views",
      expected:
        "partial.txt shows “partially staged” and Head/Staged/Unstaged; Head renders both edits, Staged and Unstaged one each.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "partial.txt");
        check(checks, "badge", true, o.header.includes("partially staged"));
        const views = await ctx.bridge.eval(
          page(`
const result = {};
for (const view of ["Staged", "Unstaged", "Head"]) {
  await choose("Diff view", view, diffSection());
  await waitFor(() => !diffBody().includes("Loading…"), view + " loaded");
  await sleep(300);
  const rows = diffRows();
  result[view] = { additions: rows?.additions, deletions: rows?.deletions };
}
return result;`),
        );
        check(
          checks,
          "per-view rows",
          {
            Staged: { additions: 1, deletions: 1 },
            Unstaged: { additions: 1, deletions: 1 },
            Head: { additions: 2, deletions: 2 },
          },
          views,
        );
        return views;
      },
    },
    {
      name: "renamed-file",
      expected: "new-name.txt shows “old-name.txt → new-name.txt”.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "new-name.txt");
        check(checks, "rename header", true, o.header.includes("old-name.txt → new-name.txt"));
        return o.header;
      },
    },
    {
      name: "untracked-file",
      expected: "untracked.txt renders as one added row.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "untracked.txt");
        check(
          checks,
          "rendered rows",
          { additions: 1, deletions: 0 },
          { additions: o.rows?.additions, deletions: o.rows?.deletions },
        );
        return o.header;
      },
    },
    {
      name: "oversized-file",
      expected:
        "large.txt (over the 512 KiB cap) shows the “truncated by policy” badge; `get_file_diff` withholds both content sides, so the pane renders only the patch.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "large.txt");
        const file = await ctx.bridge.invoke("get_file_diff", {
          projectPath: projects.dirty,
          filePath: "large.txt",
          view: "head",
          ignoreWhitespace: false,
          context: "default",
        });
        check(checks, "truncated badge", true, o.header.includes("truncated by policy"));
        check(
          checks,
          "content sides withheld",
          { oldContents: null, newContents: null },
          { oldContents: file.oldContents, newContents: file.newContents },
        );
        return { header: o.header, rows: o.rows };
      },
    },
    {
      name: "binary-file",
      expected: "data.bin is listed and shows “Binary files differ” with the binary badge.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "data.bin");
        check(checks, "binary message", true, o.body.includes("Binary files differ"));
        check(checks, "binary badge", true, o.header.includes("binary"));
        return o.header;
      },
    },
    {
      name: "image-file",
      expected:
        "logo.png renders its Before (HEAD) and After (working tree) images, 24×24 each, in the 2-up mode.",
      async run(checks) {
        const o = await openFile(ctx, projects.dirty, "logo.png");
        check(
          checks,
          "images",
          [
            { alt: "Before · HEAD logo.png", width: 24 },
            { alt: "After · working tree logo.png", width: 24 },
          ],
          o.images,
        );
        return o.images;
      },
    },
    {
      name: "split-toggle",
      expected:
        "On unstaged.txt, Split renders two code columns with the same changed rows; Unified returns to one column.",
      async run(checks) {
        await openFile(ctx, projects.dirty, "unstaged.txt");
        const o = await ctx.bridge.eval(
          page(`
await choose("Diff style", "Split", diffSection());
await waitFor(() => diffRows()?.layout === "split", "split layout");
const split = diffRows();
await choose("Diff style", "Unified", diffSection());
await waitFor(() => diffRows()?.layout === "single", "unified layout");
return { split, unified: diffRows() };`),
        );
        check(
          checks,
          "split",
          { layout: "split", columns: 2, additions: 2, deletions: 1 },
          {
            layout: o.split.layout,
            columns: o.split.columns,
            additions: o.split.additions,
            deletions: o.split.deletions,
          },
        );
        check(
          checks,
          "unified",
          { layout: "single", columns: 1 },
          { layout: o.unified.layout, columns: o.unified.columns },
        );
        return o;
      },
    },
    {
      name: "hide-whitespace",
      expected:
        "spacing.txt has three whitespace-only edits and one real edit: 4/4 rows shown; with Hide whitespace, 1/1 rows and header +1 −1; unchecking restores 4/4.",
      async run(checks) {
        const before = await openFile(ctx, projects.dirty, "spacing.txt");
        const o = await ctx.bridge.eval(
          page(`
whitespaceBox().click();
await waitFor(() => whitespaceBox()?.getAttribute("aria-checked") === "true", "checkbox checked");
await waitFor(() => diffHeader().includes("+1") && diffRows()?.additions === 1, "whitespace hidden", 3000).catch(() => null);
const hidden = { rows: diffRows(), header: diffHeader() };
whitespaceBox().click();
await waitFor(() => whitespaceBox()?.getAttribute("aria-checked") === "false", "checkbox unchecked");
await waitFor(() => diffRows()?.additions === 4, "whitespace shown", 3000).catch(() => null);
return { hidden, restored: diffRows() };`),
        );
        check(
          checks,
          "shown",
          { additions: 4, deletions: 4 },
          { additions: before.rows?.additions, deletions: before.rows?.deletions },
        );
        check(
          checks,
          "hidden rows",
          { additions: 1, deletions: 1 },
          { additions: o.hidden.rows?.additions, deletions: o.hidden.rows?.deletions },
        );
        check(
          checks,
          "hidden header",
          true,
          o.hidden.header.includes("+1") && o.hidden.header.includes("−1"),
        );
        check(
          checks,
          "restored",
          { additions: 4, deletions: 4 },
          { additions: o.restored?.additions, deletions: o.restored?.deletions },
        );
        return o;
      },
    },
    {
      name: "unborn-head",
      expected:
        "unborn-repo (no commits) lists its staged and untracked files and diffs first.txt against the empty tree.",
      async run(checks) {
        const o = await openFile(ctx, projects.unborn, "first.txt");
        const paths = await ctx.bridge.eval(page(`return treePaths().sort();`));
        check(
          checks,
          "tree paths",
          ctx.oracle.changes[projects.unborn].map((c) => c.path).sort(),
          paths,
        );
        check(
          checks,
          "rendered rows",
          { additions: 1, deletions: 0 },
          { additions: o.rows?.additions, deletions: o.rows?.deletions },
        );
        return o.header;
      },
    },
    {
      name: "linked-worktree",
      expected: "linked-worktree shows its own edit to app.txt (one added row).",
      async run(checks) {
        const o = await openFile(ctx, projects.worktree, "app.txt");
        check(
          checks,
          "rendered rows",
          { additions: 1, deletions: 0 },
          { additions: o.rows?.additions, deletions: o.rows?.deletions },
        );
        return o.header;
      },
    },
    {
      name: "submodule-pointer",
      expected:
        "super-repo's vendor/sub opens the submodule view: badge, path, and the old → new short commits equal to the fixture's sub-origin HEAD and the moved checkout HEAD.",
      async run(checks) {
        await openFile(ctx, projects.superRepo, "vendor/sub");
        const o = await ctx.bridge.eval(
          page(`
const view = await waitFor(() => diffSection()?.querySelector('[data-testid="submodule-view"]'), "submodule view");
return { text: textOf(view), pointer: view.querySelector('[aria-label^="submodule commit"]')?.getAttribute("aria-label") ?? null, error: textOf(diffSection().querySelector('[role="alert"]')) || null };`),
        );
        const { oldCommit, newCommit } = ctx.fixtures.submodule;
        check(
          checks,
          "pointer",
          `submodule commit ${oldCommit.slice(0, 7)} to ${newCommit.slice(0, 7)}`,
          o.pointer,
        );
        check(checks, "no error", null, o.error);
        return o;
      },
    },
    {
      name: "missing-project",
      expected:
        "Selecting missing-repo shows “Project is missing” with its path and Remove/Locate actions.",
      async run(checks) {
        const text = await ctx.bridge.eval(
          page(
            `await setLayout("File"); await selectProject(${JSON.stringify(projects.missing)}); await waitFor(() => textOf(document.body).includes("Project is missing"), "missing state", 3000).catch(() => null); return textOf(document.querySelector("#grove-main") ?? document.body);`,
          ),
        );
        check(
          checks,
          "missing state",
          true,
          text.includes("Project is missing") &&
            text.includes(projects.missing) &&
            text.includes("Remove") &&
            text.includes("Locate"),
        );
        return text.slice(0, 400);
      },
    },
  ];
}

function lifecycleScenarios(ctx) {
  const { projects } = ctx.fixtures;
  return [
    {
      name: "live-external-edit",
      expected: `An external append to the unchanged live.txt adds it to the tree and bumps the sidebar unstaged count within ${WATCH_BUDGET_MS} ms; an external edit to the open unstaged.txt re-renders its rows within ${WATCH_BUDGET_MS} ms. No focus change is made.`,
      async run(checks) {
        await openFile(ctx, projects.dirty, "unstaged.txt");
        const liveFile = path.join(projects.dirty, "live.txt");
        const tree = await timedExternalEdit(
          ctx,
          "new file in the open project → tree row + sidebar count",
          () => fs.appendFileSync(liveFile, "external edit\n"),
          `
const before = { count: changesCount(), title: projectRow(${JSON.stringify(projects.dirty)}).title };
return { probe: () => changesCount() === before.count + 1 && titleCounts(projectRow(${JSON.stringify(projects.dirty)}).title).unstaged === titleCounts(before.title).unstaged + 1 };`,
        );
        check(checks, "tree + sidebar updated", true, tree.updated);
        check(
          checks,
          `tree + sidebar latency ≤ ${WATCH_BUDGET_MS} ms`,
          true,
          tree.latencyMs !== null && tree.latencyMs <= WATCH_BUDGET_MS,
        );
        const openFileEdit = await timedExternalEdit(
          ctx,
          "edit to the open file → diff rows",
          () => fs.appendFileSync(path.join(projects.dirty, "unstaged.txt"), "unstaged line 14\n"),
          `
const before = diffRows().additions;
return { probe: () => diffRows()?.additions === before + 1 };`,
        );
        check(checks, "open diff re-rendered", true, openFileEdit.updated);
        check(
          checks,
          `open diff latency ≤ ${WATCH_BUDGET_MS} ms`,
          true,
          openFileEdit.latencyMs !== null && openFileEdit.latencyMs <= WATCH_BUDGET_MS,
        );
        check(checks, "focus unchanged", tree.focusBefore, openFileEdit.focusAfter);
        return { tree, openFileEdit };
      },
    },
    {
      name: "remove-and-undo",
      expected:
        "Right-click clean-repo → Remove drops the row and unregisters it in projects.json; the toast's Undo restores the row and the stored path at the same index.",
      async run(checks) {
        const storePath = path.join(ctx.dataDir, "projects.json");
        const stored = () => JSON.parse(fs.readFileSync(storePath, "utf8")).projects;
        const indexBefore = stored().indexOf(projects.clean);
        const removed = await ctx.bridge.eval(
          page(`
await expandClean();
const row = await waitFor(() => projectRow(${JSON.stringify(projects.clean)}), "clean-repo row");
const rect = row.getBoundingClientRect();
row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.x + 8, clientY: rect.y + 8 }));
const item = await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find((node) => textOf(node) === "Remove"), "Remove menu item");
item.click();
await waitFor(() => projectRow(${JSON.stringify(projects.clean)}) === undefined, "row removed");
await waitFor(() => buttonNamed("Undo"), "Undo toast");
return true;`),
        );
        await waitForStore(() => !stored().includes(projects.clean));
        const afterRemove = stored();
        await ctx.shot("remove-and-undo-removed");
        await ctx.bridge.eval(
          page(
            `buttonNamed("Undo").click(); await expandClean().catch(() => null); await waitFor(async () => { await expandClean().catch(() => null); return projectRow(${JSON.stringify(projects.clean)}); }, "row restored"); return true;`,
          ),
        );
        await waitForStore(() => stored().includes(projects.clean));
        check(checks, "row removed", true, removed);
        check(checks, "store after remove", false, afterRemove.includes(projects.clean));
        check(checks, "store index after undo", indexBefore, stored().indexOf(projects.clean));
        return { indexBefore, afterRemove: afterRemove.length, afterUndo: stored().length };
      },
    },
  ];
}
