import { useEffect, useRef, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

import type { ChatPreview } from "@/types/grove";

function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function Row({ label, bytes, note }: { label: string; bytes: number; note?: ReactNode }) {
  return (
    <li className="flex flex-col border-t border-border px-4 py-2">
      <span className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-foreground">{label}</span>
        <span className="flex-1" />
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
          {kilobytes(bytes)}
        </span>
      </span>
      {note !== undefined && <span className="text-2xs text-muted-foreground">{note}</span>}
    </li>
  );
}

/**
 * The pre-send sheet: exactly what the next turn's first request carries and
 * where it goes, before it leaves the machine. Tool results the model asks for
 * later are counted live under the composer.
 */
export function PreSendSheet({
  preview,
  skipForSession,
  onSkipForSessionChange,
  onSend,
  onCancel,
  onNeverSend,
  onAllowEgress,
}: {
  preview: ChatPreview;
  skipForSession: boolean;
  onSkipForSessionChange: (skip: boolean) => void;
  onSend: () => void;
  onCancel: () => void;
  /** Adds the project in view to the never-send list; absent without one. */
  onNeverSend?: () => void;
  /** Present when the only block is that cloud egress is off. */
  onAllowEgress?: () => void;
}) {
  const sendRef = useRef<HTMLButtonElement>(null);
  const blocked = preview.blocked !== null;

  useEffect(() => {
    sendRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && event.metaKey && !blocked) {
        event.preventDefault();
        onSend();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocked, onCancel, onSend]);

  const system = preview.systemPromptBytes + preview.toolSchemaBytes;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pre-send-title"
      className="absolute right-3 bottom-3 left-3 z-20 flex flex-col overflow-hidden rounded-xl border border-input bg-popover shadow-[0_24px_64px_#00000099]"
    >
      <div className="flex flex-col gap-1.5 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <h2
            id="pre-send-title"
            className="text-[15px] font-semibold tracking-tight text-foreground"
          >
            {preview.loopback ? "Staying on this machine" : "Leaving this machine"}
          </h2>
          <span className="flex-1" />
          <span className="font-mono text-xs text-foreground">{kilobytes(preview.totalBytes)}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          to <span className="font-mono text-foreground">{preview.destination}</span>
          {` · ${[preview.provider, preview.model].filter((part) => part !== "").join(" · ")} · ~${preview.estimatedTokens.toLocaleString()} tokens`}
        </p>
      </div>
      <ul aria-label="What will be sent" className="flex max-h-64 flex-col overflow-y-auto">
        {preview.ambient !== null && (
          <Row
            label={preview.ambient.label}
            bytes={preview.ambient.bytes}
            note="Diffs attached by Grove"
          />
        )}
        <Row label="Your question" bytes={preview.questionBytes} />
        <Row
          label={preview.toolSchemaBytes > 0 ? "System prompt + tool schemas" : "System prompt"}
          bytes={system}
        />
        <Row
          label={`Conversation (${preview.historyTurns} ${preview.historyTurns === 1 ? "turn" : "turns"})`}
          bytes={preview.historyBytes}
          note={
            preview.omittedTurns > 0
              ? `${preview.omittedTurns} earlier ${preview.omittedTurns === 1 ? "turn" : "turns"} left out to fit the budget`
              : undefined
          }
        />
        {preview.ruleFiles.map((file) => (
          <Row key={file.label} label={`${file.label} (repo rules)`} bytes={file.bytes} />
        ))}
      </ul>
      {preview.hiddenProjects > 0 && (
        <p className="border-t border-border px-4 py-2 text-2xs text-muted-foreground">
          {preview.hiddenProjects} never-send{" "}
          {preview.hiddenProjects === 1 ? "project is" : "projects are"} left out of the workspace
          list and the tools.
        </p>
      )}
      {blocked && (
        <p
          role="alert"
          className="flex items-start gap-2 border-t border-border bg-warning/8 px-4 py-2.5 text-xs text-warning-foreground"
        >
          <ShieldAlert size={13} className="mt-px shrink-0" aria-hidden />
          <span>{preview.blocked}</span>
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="flex min-w-0 flex-col gap-1">
          {onNeverSend !== undefined && !preview.loopback && (
            <button
              type="button"
              onClick={onNeverSend}
              className="self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Never send this repo
            </button>
          )}
          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <input
              type="checkbox"
              checked={skipForSession}
              onChange={(event) => onSkipForSessionChange(event.target.checked)}
            />
            Don't ask again this session
          </label>
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="flex h-[30px] items-center rounded-md border border-input px-3 text-[13px] font-medium text-foreground"
        >
          Cancel
        </button>
        {onAllowEgress !== undefined ? (
          <button
            ref={sendRef}
            type="button"
            onClick={onAllowEgress}
            className="flex h-[30px] items-center rounded-md bg-foreground px-3 text-[13px] font-semibold text-background"
          >
            Allow cloud egress
          </button>
        ) : (
          <button
            ref={sendRef}
            type="button"
            disabled={blocked}
            onClick={onSend}
            className="flex h-[30px] items-center gap-2 rounded-md bg-foreground pr-2 pl-3 text-[13px] font-semibold text-background disabled:opacity-40"
          >
            Send
            <kbd className="flex h-[18px] items-center rounded-sm bg-black/10 px-1 text-[10px] font-semibold">
              ⌘⏎
            </kbd>
          </button>
        )}
      </div>
    </div>
  );
}
