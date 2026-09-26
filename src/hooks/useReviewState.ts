import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { listChanges, listReviewed, setReviewed } from "@/api/grove";
import { indexReviewed, type ReviewIndex } from "@/lib/triage";
import { changeKeys } from "@/queries";
import type { ChangeSummary, ProjectChanges, ReviewedFile } from "@/types/grove";

export const reviewKeys = {
  all: ["reviewed"] as const,
  for: (projectPath: string) => ["reviewed", projectPath] as const,
};

/** One dirty project's change list as the stream and sidebar read it. */
export interface ProjectChangesState {
  files: ChangeSummary[];
  isPending: boolean;
  error: Error | null;
}

/**
 * The change lists of several projects at once, sharing the cache (and the watch
 * invalidation) of the single-project `useChanges`.
 */
export function useProjectsChanges(
  projectPaths: readonly string[],
  ignoreWhitespace: boolean,
): ReadonlyMap<string, ProjectChangesState> {
  const results = useQueries({
    queries: projectPaths.map((path) => ({
      queryKey: changeKeys.for(path, ignoreWhitespace),
      queryFn: (): Promise<ProjectChanges> => listChanges(path, ignoreWhitespace),
    })),
  });
  const signature = results.map((result) => result.dataUpdatedAt + ":" + result.status).join();
  // `useQueries` returns a new array every render; rebuild the map only when a result moved.
  return useMemo(
    () =>
      new Map(
        projectPaths.map((path, index) => {
          const result = results[index];
          return [
            path,
            {
              files: result?.data?.files ?? [],
              isPending: result?.isPending ?? true,
              error: result?.error ?? null,
            },
          ];
        }),
      ),
    [projectPaths, signature],
  );
}

/** Stored "viewed" marks of each project, indexed by file. */
export function useReviewIndex(projectPaths: readonly string[]): ReviewIndex {
  const results = useQueries({
    queries: projectPaths.map((path) => ({
      queryKey: reviewKeys.for(path),
      queryFn: () => listReviewed(path),
      staleTime: Infinity,
    })),
  });
  const signature = results.map((result) => result.dataUpdatedAt).join();
  return useMemo(
    () => indexReviewed(projectPaths.map((path, index) => [path, results[index]?.data] as const)),
    [projectPaths, signature],
  );
}

interface ReviewToggle {
  projectPath: string;
  file: ChangeSummary;
  viewed: boolean;
}

/** Marks or unmarks a file viewed at its current content; the checkbox flips at once. */
export function useSetViewed(): (toggle: ReviewToggle) => void {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ projectPath, file, viewed }: ReviewToggle) =>
      setReviewed(projectPath, file.path, file.contentHash, viewed),
    onMutate: async ({ projectPath, file, viewed }: ReviewToggle) => {
      const key = reviewKeys.for(projectPath);
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<ReviewedFile[]>(key, (current = []) => {
        const others = current.filter((mark) => mark.filePath !== file.path);
        return viewed
          ? [...others, { filePath: file.path, contentHash: file.contentHash }]
          : others;
      });
    },
    onSettled: (_data, _error, { projectPath }) =>
      client.invalidateQueries({ queryKey: reviewKeys.for(projectPath) }),
  });
  return mutation.mutate;
}
