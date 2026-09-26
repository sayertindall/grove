import type { SubmodulePointer } from "@/types/grove";

/** The first seven hex digits, or ∅ for a side the entry does not have. */
function shortCommit(commit: string | null): string {
  return commit === null ? "∅" : commit.slice(0, 7);
}

/** `old → new` in mono, old in the removed tone and new in the added tone. */
export function SubmodulePointerLabel({ pointer }: { pointer: SubmodulePointer }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 font-mono text-xs"
      aria-label={`submodule commit ${shortCommit(pointer.oldCommit)} to ${shortCommit(pointer.newCommit)}`}
    >
      <span className="text-destructive-foreground" title={pointer.oldCommit ?? "absent"}>
        {shortCommit(pointer.oldCommit)}
      </span>
      <span className="font-sans text-muted-foreground" aria-hidden>
        →
      </span>
      <span className="text-success-foreground" title={pointer.newCommit ?? "absent"}>
        {shortCommit(pointer.newCommit)}
      </span>
    </span>
  );
}

/** A submodule entry: the pointer moved; its contents are never read or diffed. */
export function SubmoduleView({ path, pointer }: { path: string; pointer: SubmodulePointer }) {
  const unchangedPointer = pointer.oldCommit === pointer.newCommit;
  return (
    <div
      className="flex h-13 shrink-0 items-center gap-3 border-b border-border px-4"
      data-testid="submodule-view"
    >
      <span className="inline-flex h-[18px] items-center rounded-sm border border-input px-1.5 text-[10px] font-semibold tracking-[0.04em] text-muted-foreground">
        submodule
      </span>
      <span className="truncate font-mono text-xs">{path}</span>
      <SubmodulePointerLabel pointer={pointer} />
      <span className="truncate text-xs text-muted-foreground">
        {unchangedPointer
          ? "same commit · the checkout has local changes, not diffed"
          : "pointer only, contents not diffed"}
      </span>
    </div>
  );
}
