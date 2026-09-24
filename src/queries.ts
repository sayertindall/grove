import { useQuery, type QueryClient } from "@tanstack/react-query";

import { getDiff, listProjects } from "@/api/grove";
import type { ProjectDiff, ProjectStatus } from "@/types/grove";

/** Two keys only. A project's identity is its canonical absolute path. */
export const projectKeys = {
  all: ["projects"] as const,
};

export const diffKeys = {
  all: ["diff"] as const,
  for: (path: string) => ["diff", path] as const,
};

export function useProjects() {
  return useQuery<ProjectStatus[]>({
    queryKey: projectKeys.all,
    queryFn: listProjects,
    staleTime: Infinity,
  });
}

export function useDiff(path: string | null) {
  return useQuery<ProjectDiff>({
    queryKey: diffKeys.for(path ?? ""),
    queryFn: () => getDiff(path ?? ""),
    enabled: path !== null,
    staleTime: Infinity,
  });
}

/** The watcher saw one of these projects change. */
export function invalidateWatchedProjects(client: QueryClient, paths: string[]): void {
  void client.invalidateQueries({ queryKey: projectKeys.all });

  for (const path of paths) {
    void client.invalidateQueries({ queryKey: diffKeys.for(path) });
  }
}

/** The list itself was replaced, so every open diff is stale. */
export function invalidateAllProjects(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: projectKeys.all });
  void client.invalidateQueries({ queryKey: diffKeys.all });
}
