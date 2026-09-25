import type { ProjectSort } from "@/lib/storage";
import type { ProjectState, ProjectStatus } from "@/types/grove";

export function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    next.push(path);
  }
  return next;
}

export function visibleProjects(
  projects: readonly ProjectStatus[],
  sort: ProjectSort,
  hideClean: boolean,
): ProjectStatus[] {
  const filtered = hideClean ? projects.filter((project) => project.state !== "clean") : [...projects];
  if (sort === "stored") return filtered;

  return filtered
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      if (sort === "dirty") {
        const rank = stateRank(left.project.state) - stateRank(right.project.state);
        if (rank !== 0) return rank;
      } else {
        const byName = left.project.displayName.localeCompare(right.project.displayName);
        if (byName !== 0) return byName;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.project);
}

function stateRank(state: ProjectState): number {
  return state === "dirty" ? 0 : 1;
}

/** Longest directory prefix shared by every registered project. */
export function commonParent(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const parents = paths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/"))));
  const split = parents.map((parent) => (parent === "" ? [] : parent.split("/")));
  const first = split[0];
  if (first === undefined) return "";

  let length = 0;
  while (length < first.length && split.every((parts) => parts[length] === first[length])) {
    length += 1;
  }
  return first.slice(0, length).join("/");
}

/**
 * Path under the common parent, when it says more than the project name
 * (a linked worktree's `worktrees/…`, for example).
 */
export function disambiguatingPath(path: string, parent: string): string | null {
  if (parent === "") return null;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (relative === "" || relative === name) return null;
  return relative;
}

export function pathName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function branchLabel(project: ProjectStatus): string | null {
  const branch = project.branch;
  if (branch === null) return null;
  if (branch.name !== null) return branch.name;
  if (branch.headShort !== null) return `detached @${branch.headShort}`;
  return "detached";
}

export function projectTitle(project: ProjectStatus): string {
  const counts = [
    project.stagedCount > 0 ? `${project.stagedCount} staged` : null,
    project.unstagedCount > 0 ? `${project.unstagedCount} unstaged` : null,
    project.untrackedCount > 0 ? `${project.untrackedCount} untracked` : null,
  ].filter((label): label is string => label !== null);
  return counts.length > 0 ? `${project.path} · ${counts.join(" · ")}` : project.path;
}

export function joinProjectFile(projectPath: string, filePath: string): string {
  const root = projectPath.endsWith("/") ? projectPath.slice(0, -1) : projectPath;
  const relative = filePath.replace(/^\/+/, "");
  return `${root}/${relative}`;
}

export function formatMode(mode: number): string {
  return mode.toString(8);
}

export function modeChangeLabel(oldMode: number | null, newMode: number | null): string | null {
  if (oldMode === null || newMode === null || oldMode === newMode) return null;
  return `mode ${formatMode(oldMode)} → ${formatMode(newMode)}`;
}

export function isReadable(project: ProjectStatus): boolean {
  return project.state === "clean" || project.state === "dirty";
}
