/**
 * The wire contract of Grove's commands and its one event. Rust does not import this
 * file; serde is the mirror (camelCase fields, lowercase enums).
 */

export type ProjectState = "clean" | "dirty" | "missing" | "unreadable";

export type FileChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

/**
 * Which comparison a file diff shows. `head` is the worktree against HEAD (staged and
 * unstaged together), `staged` is the index against HEAD, `unstaged` is the worktree
 * against the index.
 */
export type DiffView = "head" | "staged" | "unstaged";

export interface BranchInfo {
  /** Short branch name; null when HEAD is detached. */
  name: string | null;
  /** Abbreviated HEAD commit id; null in a repository without commits. */
  headShort: string | null;
  /** Short name of the upstream branch, read from local refs only. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ProjectStatus {
  path: string;
  displayName: string;
  state: ProjectState;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  additions: number;
  deletions: number;
  /** Null when the project is missing or unreadable. */
  branch: BranchInfo | null;
  /** The main worktree's path when this project is a linked worktree. */
  worktreeOf: string | null;
  /** Whether the filesystem watcher is armed on this root. */
  watching: boolean;
  /** Why a missing or unreadable project could not be read. */
  reason: string | null;
}

export interface ChangeSummary {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  /** The index differs from HEAD for this path. */
  staged: boolean;
  /** The worktree differs from the index for this path (untracked counts as unstaged). */
  unstaged: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  /** Git file modes (e.g. 0o100644); null for the absent side. */
  oldMode: number | null;
  newMode: number | null;
}

export interface ProjectChanges {
  path: string;
  files: ChangeSummary[];
}

export interface ImagePreview {
  /** `data:` URLs; null for the absent or oversized side. */
  oldDataUrl: string | null;
  newDataUrl: string | null;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  view: DiffView;
  binary: boolean;
  patch: string;
  oldContents: string | null;
  newContents: string | null;
  oldMode: number | null;
  newMode: number | null;
  /** Set for png, jpg, jpeg, gif, webp, and svg files. */
  image: ImagePreview | null;
}

export interface ProjectsChanged {
  paths: string[];
}
