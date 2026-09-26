// Builds throwaway Git repositories that cover every file kind the diff pane
// renders, and records each step so the report can say how to recreate them.
// Fixture mutation uses the git CLI; Grove itself only ever reads these repos.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Grove E2E",
  GIT_AUTHOR_EMAIL: "e2e@grove.invalid",
  GIT_COMMITTER_NAME: "Grove E2E",
  GIT_COMMITTER_EMAIL: "e2e@grove.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** Just over the 512 KiB per-side content cap. */
export const OVERSIZED_BYTES = 512 * 1024 + 4096;

export class FixtureBuilder {
  constructor(root) {
    this.root = root;
    this.steps = [];
  }

  path(...parts) {
    return path.join(this.root, ...parts);
  }

  git(repo, ...args) {
    const shown = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg));
    this.steps.push(`(cd ${repo} && git ${shown.join(" ")})`);
    return execFileSync("git", args, {
      cwd: this.path(repo),
      env: { ...process.env, ...GIT_ENV },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** A git step whose non-zero exit is the point (a merge that must conflict). */
  gitExpectingFailure(repo, ...args) {
    try {
      this.git(repo, ...args);
    } catch {
      return;
    }
    throw new Error(`expected \`git ${args.join(" ")}\` in ${repo} to fail`);
  }

  mkdir(repo, dir, note) {
    fs.mkdirSync(this.path(repo, dir), { recursive: true });
    this.steps.push(`mkdir ${repo}/${dir}${note ? ` (${note})` : ""}`);
  }

  write(repo, file, contents, note) {
    const target = this.path(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    this.steps.push(`write ${repo}/${file}${note ? ` (${note})` : ""}`);
  }

  init(repo) {
    fs.mkdirSync(this.path(repo), { recursive: true });
    this.git(repo, "init", "-q", "-b", "main");
  }

  commitAll(repo, message) {
    this.git(repo, "add", "-A");
    this.git(repo, "commit", "-q", "-m", message);
  }
}

const lines = (count, label) =>
  Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`).join("\n") + "\n";

/** A committed README and nothing else. */
function buildClean(fx) {
  fx.init("clean-repo");
  fx.write("clean-repo", "README.md", "# clean\n");
  fx.commitAll("clean-repo", "initial");
}

/** Staged, unstaged, partially staged, renamed, untracked, binary, image, oversized, whitespace. */
function buildDirty(fx) {
  const repo = "dirty-repo";
  fx.init(repo);
  fx.write(repo, "staged.txt", lines(6, "staged"));
  fx.write(repo, "unstaged.txt", lines(12, "unstaged"));
  fx.write(repo, "partial.txt", lines(10, "partial"));
  fx.write(repo, "old-name.txt", lines(8, "renamed"));
  fx.write(repo, "data.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]), "8 bytes with NULs");
  fx.write(repo, "logo.png", solidPng(24, 24, [16, 185, 129]), "24x24 green PNG");
  fx.write(repo, "spacing.txt", ["alpha", "beta", "gamma", "delta", "epsilon", ""].join("\n"));
  fx.write(repo, "live.txt", lines(3, "live"));
  fx.commitAll(repo, "initial");

  fx.write(repo, "staged.txt", lines(6, "staged").replace("staged line 2", "staged line 2 edited"));
  fx.git(repo, "add", "staged.txt");
  fx.write(
    repo,
    "unstaged.txt",
    lines(12, "unstaged").replace("unstaged line 5", "unstaged line 5 edited") +
      "unstaged line 13\n",
  );
  fx.write(
    repo,
    "partial.txt",
    lines(10, "partial").replace("partial line 1", "partial line 1 staged"),
  );
  fx.git(repo, "add", "partial.txt");
  fx.write(
    repo,
    "partial.txt",
    lines(10, "partial")
      .replace("partial line 1", "partial line 1 staged")
      .replace("partial line 9", "partial line 9 unstaged"),
  );
  fx.git(repo, "mv", "old-name.txt", "new-name.txt");
  fx.write(repo, "data.bin", Buffer.from([0, 9, 8, 7, 0, 1, 1, 0, 42]), "different binary bytes");
  fx.write(repo, "logo.png", solidPng(24, 24, [241, 87, 87]), "24x24 red PNG");
  fx.write(
    repo,
    "spacing.txt",
    ["  alpha", "beta  ", "\tgamma", "delta changed", "epsilon", ""].join("\n"),
    "three whitespace-only edits, one real edit",
  );
  fx.write(repo, "untracked.txt", "a new file\n");
  fx.write(
    repo,
    "large.txt",
    "x".repeat(OVERSIZED_BYTES - 1) + "\n",
    `${OVERSIZED_BYTES} bytes, over the 512 KiB cap`,
  );
}

/** `git init` with one staged and one untracked file, no commit. */
function buildUnborn(fx) {
  fx.init("unborn-repo");
  fx.write("unborn-repo", "first.txt", "staged before any commit\n");
  fx.git("unborn-repo", "add", "first.txt");
  fx.write("unborn-repo", "notes.txt", "untracked before any commit\n");
}

/** A main repository and a linked worktree with its own edit. */
function buildWorktree(fx) {
  fx.init("main-repo");
  fx.write("main-repo", "app.txt", lines(4, "app"));
  fx.commitAll("main-repo", "initial");
  fx.git("main-repo", "worktree", "add", "-q", "-b", "feature", "../linked-worktree");
  fx.write("linked-worktree", "app.txt", lines(4, "app") + "feature line\n");
}

/** A superproject whose submodule checkout moved to a new commit. */
function buildSubmodule(fx) {
  fx.init("sub-origin");
  fx.write("sub-origin", "lib.txt", "v1\n");
  fx.commitAll("sub-origin", "v1");
  fx.init("super-repo");
  fx.write("super-repo", "main.txt", "super\n");
  fx.commitAll("super-repo", "initial");
  fx.git(
    "super-repo",
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    fx.path("sub-origin"),
    "vendor/sub",
  );
  fx.commitAll("super-repo", "add submodule");
  fx.write("super-repo", "vendor/sub/lib.txt", "v2\n");
  fx.commitAll("super-repo/vendor/sub", "v2");
  const head = (repo) => fx.git(repo, "rev-parse", "HEAD").trim();
  return { oldCommit: head("sub-origin"), newCommit: head("super-repo/vendor/sub") };
}

/**
 * Triage and review signals: an env file gaining a credential-shaped line, a
 * lockfile, a long file with two distant hunks (lines 20–59 and line 280, so the
 * first hunk is taller than the pane and hunk navigation has to scroll), a file
 * reserved for the viewed-mark scenario, and an agent marker directory.
 */
function buildReview(fx) {
  const repo = "review-repo";
  fx.init(repo);
  fx.write(repo, ".env", "APP_MODE=dev\n");
  fx.write(repo, "package-lock.json", lockfile("1.0.0"));
  fx.write(repo, "long.txt", lines(300, "long"));
  fx.write(repo, "viewed.txt", lines(5, "viewed"));
  fx.commitAll(repo, "initial");
  fx.write(
    repo,
    ".env",
    "APP_MODE=dev\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
    "adds AWS's documented example access key id",
  );
  fx.write(repo, "package-lock.json", lockfile("1.1.0"));
  fx.write(repo, "long.txt", longEdited(), "lines 20–59 and 280 edited");
  fx.write(repo, "viewed.txt", lines(5, "viewed") + "viewed line 6\n");
  fx.mkdir(repo, ".claude", "agent marker, empty so git ignores it");
}

/** long.txt with lines 20–59 and line 280 rewritten: two hunks far apart. */
function longEdited() {
  return lines(300, "long")
    .split("\n")
    .map((line, index) => {
      const number = index + 1;
      return (number >= 20 && number <= 59) || number === 280 ? `${line} edited` : line;
    })
    .join("\n");
}

function lockfile(version) {
  return `${JSON.stringify({ name: "fixture", version, lockfileVersion: 3, packages: { "": { version } } }, null, 2)}\n`;
}

/** A merge stopped on a conflict in conflict.txt; the index holds all three stages. */
function buildConflict(fx) {
  const repo = "conflict-repo";
  fx.init(repo);
  fx.write(repo, "conflict.txt", lines(8, "shared"));
  fx.commitAll(repo, "base");
  fx.git(repo, "checkout", "-q", "-b", "incoming");
  fx.write(repo, "conflict.txt", lines(8, "shared").replace("shared line 4", "theirs line 4"));
  fx.commitAll(repo, "theirs");
  fx.git(repo, "checkout", "-q", "main");
  fx.write(repo, "conflict.txt", lines(8, "shared").replace("shared line 4", "ours line 4"));
  fx.commitAll(repo, "ours");
  fx.gitExpectingFailure(repo, "merge", "-q", "incoming");
}

/**
 * Builds every fixture under `root` and returns the registered project paths in
 * sidebar order, plus a path that is registered but does not exist.
 */
export function buildFixtures(root) {
  const fx = new FixtureBuilder(root);
  buildClean(fx);
  buildDirty(fx);
  buildUnborn(fx);
  buildWorktree(fx);
  const submodule = buildSubmodule(fx);
  buildReview(fx);
  buildConflict(fx);
  const projects = {
    clean: fx.path("clean-repo"),
    dirty: fx.path("dirty-repo"),
    unborn: fx.path("unborn-repo"),
    main: fx.path("main-repo"),
    worktree: fx.path("linked-worktree"),
    superRepo: fx.path("super-repo"),
    review: fx.path("review-repo"),
    conflict: fx.path("conflict-repo"),
    missing: fx.path("missing-repo"),
  };
  return { projects, submodule, steps: fx.steps };
}

// --- A tiny PNG encoder, so the image fixture needs no dependency --------------

function solidPng(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set([r, g, b, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
