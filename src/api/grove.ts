import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  DiffView,
  FileDiff,
  ProjectChanges,
  ProjectsChanged,
  ProjectStatus,
} from "@/types/grove";

export const PROJECTS_CHANGED_EVENT = "grove://projects-changed";

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Something went wrong");
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toError(error);
  }
}

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

/** One file's two sides for the requested view. */
export function getFileDiff(
  projectPath: string,
  filePath: string,
  view: DiffView,
  ignoreWhitespace: boolean,
): Promise<FileDiff> {
  return invokeCommand<FileDiff>("get_file_diff", {
    projectPath,
    filePath,
    view,
    ignoreWhitespace,
  });
}

export function revealInFinder(path: string): Promise<void> {
  return invokeCommand<void>("reveal_in_finder", { path });
}

export function openPath(path: string): Promise<void> {
  return invokeCommand<void>("open_path", { path });
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
