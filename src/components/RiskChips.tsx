import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { RISK_LABEL, RISK_TONE, type RiskTone } from "@/lib/triage";
import type { RiskSignal } from "@/types/grove";

const TONE_CLASS: Record<RiskTone | "neutral", string> = {
  destructive: "bg-destructive/16 text-destructive-foreground",
  warning: "bg-warning/16 text-warning-foreground",
  muted: "bg-muted text-muted-foreground",
  neutral: "bg-muted text-muted-foreground",
};

/** One small tinted label: a risk signal or a file state such as `untracked`. */
export function Chip({ tone, children }: { tone: RiskTone | "neutral"; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm px-[5px] text-[10px] leading-[14px] font-medium",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

export function RiskChips({
  risks,
  className,
}: {
  risks: readonly RiskSignal[];
  className?: string;
}) {
  if (risks.length === 0) return null;
  return (
    <span className={cn("flex shrink-0 flex-wrap items-center gap-1", className)}>
      {risks.map((risk) => (
        <Chip key={risk} tone={RISK_TONE[risk]}>
          {RISK_LABEL[risk]}
        </Chip>
      ))}
    </span>
  );
}

/** The "Viewed" box of a file header; checked iff the file's current content is marked. */
export function ViewedToggle({
  viewed,
  onChange,
}: {
  viewed: boolean;
  onChange: (viewed: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2 text-xs font-medium select-none",
        viewed ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Checkbox
        checked={viewed}
        aria-label="Viewed"
        onCheckedChange={(checked) => onChange(checked === true)}
      />
      Viewed
    </label>
  );
}
