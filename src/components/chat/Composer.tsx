import { Check } from "lucide-react";

import { ApprovalCard, LoadingState, PromptBar } from "@/components/beautiful";
import { Button } from "@/components/ui/button";
import type { ChatEgressEvent } from "@/types/grove";

/** 1234 → "1.2k"; small counts stay exact. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

/** The live counter: what this turn has sent so far, against the per-turn cap. */
function EgressCounter({
  egress,
  perTurnCap,
}: {
  egress: ChatEgressEvent;
  perTurnCap: number | null;
}) {
  const sent = compactCount(egress.estimatedTokens);
  const label =
    perTurnCap === null
      ? `${sent} tokens sent this turn`
      : `${sent} / ${compactCount(perTurnCap)} tokens this turn`;
  return (
    <span
      aria-live="polite"
      title={`${egress.sentBytes.toLocaleString()} bytes ${egress.loopback ? "sent to a server on this machine" : "left this machine"} this turn`}
      className="shrink-0 font-mono text-2xs text-muted-foreground"
    >
      {egress.loopback ? `${label} · local` : label}
    </span>
  );
}

export function Composer({
  placeholder,
  onSend,
  working,
  onStop,
  failure,
  onRetry,
  onDismiss,
  previewBeforeSend,
  onPreviewChange,
  egress,
  perTurnCap,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  working: boolean;
  onStop: () => void;
  /** The last turn's error, when it may be retried. */
  failure: string | null;
  onRetry: () => void;
  onDismiss: () => void;
  previewBeforeSend: boolean;
  onPreviewChange: (enabled: boolean) => void;
  egress: ChatEgressEvent | null;
  perTurnCap: number | null;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-sidebar-border px-4 pt-3 pb-3.5">
      {failure !== null && (
        <ApprovalCard
          questions={[
            {
              q: `The last turn failed: ${failure}`,
              type: "radio",
              options: ["Retry the request", "Dismiss"],
            },
          ]}
          onSubmitted={(answers) => (answers[0]?.includes(0) ? onRetry() : onDismiss())}
        />
      )}
      {working && (
        <div className="flex items-center justify-between gap-2">
          <LoadingState label="Working" variant="Drive" />
          <Button size="sm" variant="outline" onClick={onStop}>
            Stop
          </Button>
        </div>
      )}
      <PromptBar placeholder={placeholder} onSend={onSend} />
      <div className="flex items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
          Preview before send
          <input
            type="checkbox"
            checked={previewBeforeSend}
            onChange={(event) => onPreviewChange(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className={`flex size-3.5 items-center justify-center rounded-sm border peer-focus-visible:ring-2 peer-focus-visible:ring-ring ${previewBeforeSend ? "border-success bg-success" : "border-input"}`}
          >
            {previewBeforeSend && <Check size={10} strokeWidth={3} className="text-sidebar" />}
          </span>
        </label>
        <span className="flex-1" />
        {egress !== null && <EgressCounter egress={egress} perTurnCap={perTurnCap} />}
      </div>
    </div>
  );
}
