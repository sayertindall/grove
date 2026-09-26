import { BanIcon } from "lucide-react";

const PROMISES = [
  {
    title: "Never stage, commit, or push",
    detail: "Grove reads working trees. It has no write path into Git.",
  },
  {
    title: "Never edit your files",
    detail: "Not even the assistant. Its nine tools are read-only.",
  },
  {
    title: "Never phone home",
    detail: "No telemetry, no analytics. Updates are checked only when you ask.",
  },
] as const;

/** What Grove will never do: shown on first run and in Settings › About. */
export function ReadOnlyPromises({ headingId }: { headingId: string }) {
  return (
    <ul aria-labelledby={headingId} className="flex flex-col border-t border-border">
      {PROMISES.map((promise) => (
        <li
          key={promise.title}
          className="flex gap-3 border-b border-border py-3.5 last:border-b-0"
        >
          <BanIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm text-foreground">{promise.title}</span>
            <span className="text-xs text-muted-foreground">{promise.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
