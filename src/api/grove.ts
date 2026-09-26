import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeCommand, toError } from "@/api/invoke";
import type {
  BlameView,
  CommitInfo,
  DiffContext,
  DiffView,
  FileDiff,
  ProjectChanges,
  ProjectsChanged,
  ProjectStatus,
  ReviewedFile,
} from "@/types/grove";

export const PROJECTS_CHANGED_EVENT = "grove://projects-changed";

/** Repositories that directly contain git metadata, at most six levels down. */
export function scanForRepos(dir: string): Promise<string[]> {
  return invokeCommand<string[]>("scan_for_repos", { dir });
}

/** Every registered project, in stored order. */
export function listProjects(): Promise<ProjectStatus[]> {
  return invokeCommand<ProjectStatus[]>("list_projects");
}

/** One registered project's status, used to patch the list after a watch event. */
export function getProjectStatus(projectPath: string): Promise<ProjectStatus> {
  return invokeCommand<ProjectStatus>("get_project_status", { projectPath });
}

/** Replaces the whole list and rewrites the watcher. */
export function setProjects(paths: string[]): Promise<void> {
  return invokeCommand<void>("set_projects", { paths });
}

/** File summaries for one project. Counts are for the head view; no patches. */
export function listChanges(
  projectPath: string,
  ignoreWhitespace: boolean,
): Promise<ProjectChanges> {
  return invokeCommand<ProjectChanges>("list_changes", { projectPath, ignoreWhitespace });
}

/** One file's two sides for the requested view, with `context` unchanged lines per hunk. */
export function getFileDiff(
  projectPath: string,
  filePath: string,
  view: DiffView,
  ignoreWhitespace: boolean,
  context: DiffContext,
): Promise<FileDiff> {
  return invokeCommand<FileDiff>("get_file_diff", {
    projectPath,
    filePath,
    view,
    ignoreWhitespace,
    context,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invokeCommand<void>("reveal_in_finder", { path });
}

export function openPath(path: string): Promise<void> {
  return invokeCommand<void>("open_path", { path });
}

/** The file's current text (first 400 lines) beside the commit behind each line. */
export function blameFile(projectPath: string, filePath: string): Promise<BlameView> {
  return invokeCommand<BlameView>("blame_file", { projectPath, filePath });
}

/** Commits that touched one file, newest first; the backend caps `limit` at 50. */
export function fileHistory(
  projectPath: string,
  filePath: string,
  limit: number,
): Promise<CommitInfo[]> {
  return invokeCommand<CommitInfo[]>("file_history", { projectPath, filePath, limit });
}

/** The files of one project marked viewed, each with the content hash it was marked at. */
export function listReviewed(projectPath: string): Promise<ReviewedFile[]> {
  return invokeCommand<ReviewedFile[]>("list_reviewed", { projectPath });
}

/** Marks (or unmarks) one file viewed at its current `contentHash`. */
export function setReviewed(
  projectPath: string,
  filePath: string,
  contentHash: string,
  reviewed: boolean,
): Promise<void> {
  return invokeCommand<void>("set_reviewed", { projectPath, filePath, contentHash, reviewed });
}

/** The one event Grove emits, after the watcher debounce. */
export async function listenForProjectsChanged(
  onChange: (event: ProjectsChanged) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ProjectsChanged>(PROJECTS_CHANGED_EVENT, (event) => {
      onChange(event.payload);
    });
  } catch (error) {
    throw toError(error);
  }
}

export async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
  } catch (error) {
    throw toError(error);
  }
}
