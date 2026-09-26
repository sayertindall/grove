import type { DiffContextChoice, LineDiffType } from "@/components/diff/diffPreferences";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";

const CONTEXT_OPTIONS: SegmentedOption<DiffContextChoice>[] = [
  { value: "1", label: "1" },
  { value: "3", label: "3" },
  { value: "10", label: "10" },
  { value: "all", label: "All" },
];

const LINE_DIFF_OPTIONS: SegmentedOption<LineDiffType>[] = [
  { value: "word-alt", label: "Words" },
  { value: "word", label: "Exact words" },
  { value: "char", label: "Chars" },
  { value: "none", label: "Off" },
];

interface DiffFooterProps {
  diffContext: DiffContextChoice;
  ignoreWhitespace: boolean;
  lineDiffType: LineDiffType;
  hunkCount: number;
  hiddenLines: number;
  onDiffContextChange: (context: DiffContextChoice) => void;
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void;
  onLineDiffTypeChange: (lineDiffType: LineDiffType) => void;
}

/** Context lines, whitespace, and intra-line comparison, with the hunk summary on the right. */
export function DiffFooter({
  diffContext,
  ignoreWhitespace,
  lineDiffType,
  hunkCount,
  hiddenLines,
  onDiffContextChange,
  onIgnoreWhitespaceChange,
  onLineDiffTypeChange,
}: DiffFooterProps) {
  return (
    <footer className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-t border-border px-4 text-xs text-muted-foreground">
      <span className="shrink-0">Context</span>
      <SegmentedControl
        aria-label="Context lines"
        value={diffContext}
        options={CONTEXT_OPTIONS}
        onValueChange={onDiffContextChange}
      />
      <label className="flex shrink-0 items-center gap-1.5 text-foreground">
        <Checkbox
          checked={ignoreWhitespace}
          onCheckedChange={(checked) => onIgnoreWhitespaceChange(checked === true)}
        />
        Hide whitespace
      </label>
      <span className="shrink-0">Inline</span>
      <SegmentedControl
        aria-label="Inline changes"
        value={lineDiffType}
        options={LINE_DIFF_OPTIONS}
        onValueChange={onLineDiffTypeChange}
      />
      <span className="ml-auto shrink-0" data-hunk-summary>
        {hunkCount} {hunkCount === 1 ? "hunk" : "hunks"} · {hiddenLines}{" "}
        {hiddenLines === 1 ? "line" : "lines"} hidden
      </span>
      <span className="flex shrink-0 items-center gap-1" aria-hidden>
        <kbd className="rounded-sm border border-border px-1 font-sans text-2xs">n</kbd>
        <kbd className="rounded-sm border border-border px-1 font-sans text-2xs">p</kbd>
        hunk
      </span>
    </footer>
  );
}
