import type { LineDiffTypes } from "@pierre/diffs";

import type { DiffContext } from "@/types/grove";

/** How changed lines are compared inside one line: joined words, exact words, characters, or not at all. */
export type LineDiffType = LineDiffTypes;
export const LINE_DIFF_TYPES = [
  "word-alt",
  "word",
  "char",
  "none",
] as const satisfies readonly LineDiffType[];

/** A stored footer choice, or the default when the stored text is anything else. */
export function parseDiffContextChoice(raw: string | null): DiffContextChoice {
  return DIFF_CONTEXT_CHOICES.find((choice) => choice === raw) ?? DEFAULT_DIFF_CONTEXT;
}

/** The stored text for a footer choice. */
export function serializeDiffContextChoice(choice: DiffContextChoice): string {
  return choice;
}

/** Unchanged lines kept around each hunk, as the footer offers them. */
export type DiffContextChoice = "1" | "3" | "10" | "all";
export const DIFF_CONTEXT_CHOICES = [
  "1",
  "3",
  "10",
  "all",
] as const satisfies readonly DiffContextChoice[];
export const DEFAULT_DIFF_CONTEXT: DiffContextChoice = "3";

/** The `context` argument of `get_file_diff` for one footer choice. */
export function diffContextArgument(choice: DiffContextChoice): DiffContext {
  return choice === "all" ? "all" : Number(choice);
}

/** Lines of context for the in-page diff of both file sides; "all" keeps the whole file in one hunk. */
export function diffContextLines(choice: DiffContextChoice): number {
  return choice === "all" ? Number.MAX_SAFE_INTEGER : Number(choice);
}
