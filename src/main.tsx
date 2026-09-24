import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { DIFF_THEMES, createDiffsWorker } from "./diffsWorker";
import "./index.css";

/**
 * Refresh is by invalidation only, so a query never goes stale on its own and a
 * failure renders its inline row immediately instead of after three retries.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory: createDiffsWorker }}
        highlighterOptions={{ theme: DIFF_THEMES }}
      >
        <App />
      </WorkerPoolContextProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
