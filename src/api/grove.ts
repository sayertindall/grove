import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { ProjectDiff, ProjectsChanged, ProjectStatus } from "@/types/grove";

export const PROJECTS_CHANGED_EVENT = "grove://projects-changed";

/** Repositories that directly contain git metadata, at most six levels down. */
export function scanForRepos(dir: string): Promise<string[]> {
  return invoke<string[]>("scan_for_repos", { dir });
}

/** Every registered project, in stored order. */
export function listProjects(): Promise<ProjectStatus[]> {
  return invoke<ProjectStatus[]>("list_projects");
}

/** Replaces the whole list and rewrites the watcher. */
export function setProjects(paths: string[]): Promise<void> {
  return invoke<void>("set_projects", { paths });
}

/** The worktree changes of one project against HEAD. */
export function getDiff(projectPath: string): Promise<ProjectDiff> {
  return invoke<ProjectDiff>("get_diff", { projectPath });
}

/** The one event Grove emits, after the watcher debounce. */
export function listenForProjectsChanged(
  onChange: (event: ProjectsChanged) => void,
): Promise<UnlistenFn> {
  return listen<ProjectsChanged>(PROJECTS_CHANGED_EVENT, (event) => onChange(event.payload));
}
