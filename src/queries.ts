import { useQuery, type QueryClient } from "@tanstack/react-query";

import { getFileDiff, getProjectStatus, listChanges, listProjects } from "@/api/grove";
import { diffContextArgument, type DiffContextChoice } from "@/components/diff/diffPreferences";
import { historyKeys } from "@/components/HistoryPanel";
import type { DiffView, FileDiff, ProjectChanges, ProjectStatus } from "@/types/grove";

export const projectKeys = {
  all: ["projects"] as const,
};

export const changeKeys = {
  all: ["changes"] as const,
  forProject: (path: string) => ["changes", path] as const,
  for: (path: string, ignoreWhitespace: boolean) => ["changes", path, ignoreWhitespace] as const,
};

export const fileDiffKeys = {
  all: ["fileDiff"] as const,
  forProject: (path: string) => ["fileDiff", path] as const,
  for: (
    path: string,
    file: string,
    view: DiffView,
    ignoreWhitespace: boolean,
    context: DiffContextChoice,
  ) => ["fileDiff", path, file, view, ignoreWhitespace, context] as const,
};

export function useProjects() {
  return useQuery<ProjectStatus[]>({
    queryKey: projectKeys.all,
    queryFn: listProjects,
  });
}

export function useChanges(path: string | null, ignoreWhitespace: boolean) {
  return useQuery<ProjectChanges>({
    queryKey: changeKeys.for(path ?? "", ignoreWhitespace),
    queryFn: () => listChanges(path ?? "", ignoreWhitespace),
    enabled: path !== null,
  });
}

export function useFileDiff(
  projectPath: string | null,
  filePath: string | null,
  view: DiffView,
  ignoreWhitespace: boolean,
  context: DiffContextChoice,
) {
  return useQuery<FileDiff>({
    queryKey: fileDiffKeys.for(projectPath ?? "", filePath ?? "", view, ignoreWhitespace, context),
    queryFn: () =>
      getFileDiff(
        projectPath ?? "",
        filePath ?? "",
        view,
        ignoreWhitespace,
        diffContextArgument(context),
      ),
    enabled: projectPath !== null && filePath !== null,
    // Keep the same file's diff on screen while a context or whitespace change refetches it.
    placeholderData: (previous) => (previous?.path === filePath ? previous : undefined),
  });
}

/**
 * A watch event names the projects that changed. Patch those rows in place and
 * drop only their change lists and file diffs — never refetch the whole list.
 */
export async function patchChangedProjects(client: QueryClient, paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      try {
        const status = await getProjectStatus(path);
        client.setQueryData<ProjectStatus[]>(projectKeys.all, (current) =>
          current?.map((project) => (project.path === path ? status : project)),
        );
      } catch {
        // A failed status read leaves the row. The change list shows its own error.
      }
      await client.invalidateQueries({ queryKey: changeKeys.forProject(path) });
      await client.invalidateQueries({ queryKey: fileDiffKeys.forProject(path) });
      await client.invalidateQueries({ queryKey: historyKeys.blameForProject(path) });
      await client.invalidateQueries({ queryKey: historyKeys.commitsForProject(path) });
    }),
  );
}

/** The registered list itself was replaced, so every open read is stale. */
export function invalidateAllProjects(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: projectKeys.all });
  void client.invalidateQueries({ queryKey: changeKeys.all });
  void client.invalidateQueries({ queryKey: fileDiffKeys.all });
  void client.invalidateQueries({ queryKey: ["blame"] });
  void client.invalidateQueries({ queryKey: ["fileHistory"] });
}

/** ⌘R: refetch every active query, including ones a watch event would skip. */
export function invalidateEverything(client: QueryClient): void {
  void client.invalidateQueries();
}
