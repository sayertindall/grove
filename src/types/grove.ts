/**
 * The wire contract of the four commands and the one event. Rust does not import
 * this file; serde is the mirror.
 */

export type ProjectState = "clean" | "dirty" | "missing" | "unreadable";

export type FileChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface ProjectStatus {
  path: string;
  displayName: string;
  state: ProjectState;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  additions: number;
  deletions: number;
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  staged: boolean;
  binary: boolean;
  patch: string;
  oldContents: string | null;
  newContents: string | null;
}

export interface ProjectDiff {
  path: string;
  files: FileChange[];
}

export interface ProjectsChanged {
  paths: string[];
}
