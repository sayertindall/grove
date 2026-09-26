import { shortcutKeys } from "@/lib/commands";
import { cn } from "@/lib/utils";

/** A shortcut as keycaps; screen readers hear it once as words, not glyph by glyph. */
export function Keycaps({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      <span className="sr-only">{shortcut.replace("Mod", "Command").replaceAll("+", " ")}</span>
      {shortcutKeys(shortcut).map((key) => (
        <kbd
          key={key}
          aria-hidden="true"
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-input px-1 font-sans text-[10px] leading-[14px] font-medium text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
