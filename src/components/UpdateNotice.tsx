import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { UpdateCheck } from "@/hooks/useUpdateCheck";

/** One-line update status under the title bar; renders nothing while idle. */
export function UpdateNotice({ updates }: { updates: UpdateCheck }) {
  const { state, install, dismiss } = updates;
  if (state.phase === "idle") return null;

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-muted px-4 text-xs text-muted-foreground"
    >
      {state.phase === "checking" && (
        <>
          <Spinner className="size-3.5" />
          <span>Checking for updates…</span>
        </>
      )}
      {state.phase === "current" && <span>Grove is up to date.</span>}
      {state.phase === "available" && (
        <>
          <span className="text-foreground">Grove {state.update.version} is available</span>
          <span>(you have {state.update.currentVersion})</span>
          <Button size="xs" variant="outline" onClick={install}>
            Install and relaunch
          </Button>
        </>
      )}
      {state.phase === "installing" && (
        <>
          <Spinner className="size-3.5" />
          <span>Installing Grove {state.update.version}; Grove relaunches when it finishes…</span>
        </>
      )}
      {state.phase === "failed" && (
        <span className="text-destructive-foreground">Update check failed: {state.message}</span>
      )}
      <span className="flex-1" />
      {state.phase !== "checking" && state.phase !== "installing" && (
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss update notice" onClick={dismiss}>
          <XIcon />
        </Button>
      )}
    </div>
  );
}
