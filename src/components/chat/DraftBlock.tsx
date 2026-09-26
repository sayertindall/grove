import { useEffect, useState } from "react";

import { DRAFT_LABELS } from "@/lib/assistant-blocks";

/**
 * A draft the assistant wrote (commit message, PR description, standup) with a
 * copy button. Grove never commits or posts it; the clipboard is the only exit.
 */
export function DraftBlock({ kind, text }: { kind: string; text: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const body = text.replace(/\n$/, "");

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard
      .writeText(body)
      .then(() => setCopied("copied"))
      .catch(() => setCopied("failed"));
  };

  return (
    <div
      role="group"
      aria-label={`Draft ${DRAFT_LABELS[kind] ?? kind}`}
      className="flex flex-col rounded-lg border border-border bg-background"
    >
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className="text-2xs font-semibold text-muted-foreground">
          Draft · {DRAFT_LABELS[kind] ?? (kind === "" ? "text" : kind)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={copy}
          className="flex h-[22px] items-center rounded-md bg-input px-2 text-2xs font-medium text-foreground transition-opacity hover:opacity-85"
        >
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy draft"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground">
        {body}
      </pre>
    </div>
  );
}
