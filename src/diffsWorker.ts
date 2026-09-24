import DiffsWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";

/** The Shiki themes the pool resolves. Grove only ever switches between these two. */
export const DIFF_THEMES = { dark: "pierre-dark", light: "pierre-light" } as const;

/**
 * One highlighting worker. Vite hands back the URL of the built worker bundle, so the
 * pool never blocks the render thread while a patch is tokenized.
 */
export function createDiffsWorker(): Worker {
  return new Worker(DiffsWorkerUrl, { type: "module" });
}
