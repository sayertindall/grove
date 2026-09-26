import type { TourFileRef, TourGroup, TourPlan } from "@/types/grove";

/** One piece of an assistant answer: prose, or a fenced block with its info string. */
export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; info: string; code: string };

/** Splits an answer into prose and fenced blocks; prose keeps inline citations. */
export function parseFences(text: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "code", info: (match[1] ?? "").trim(), code: match[2] ?? "" });
    last = start + match[0].length;
  }
  if (last >= text.length) return segments;
  // A fence still open mid-stream renders as code already, so closing it later never jumps layout.
  const openIndex = text.indexOf("```", last);
  if (openIndex === -1) {
    segments.push({ kind: "text", text: text.slice(last) });
    return segments;
  }
  if (openIndex > last) segments.push({ kind: "text", text: text.slice(last, openIndex) });
  const rest = text.slice(openIndex + 3);
  const newline = rest.indexOf("\n");
  segments.push({
    kind: "code",
    info: (newline === -1 ? rest : rest.slice(0, newline)).trim(),
    code: newline === -1 ? "" : rest.slice(newline + 1),
  });
  return segments;
}

/** What a `draft …` fence holds, for its header. */
export const DRAFT_LABELS: Record<string, string> = {
  "commit-message": "commit message",
  "pr-description": "PR description",
  standup: "standup",
};

function isFileRef(value: unknown): value is TourFileRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.project === "string" && typeof ref.path === "string";
}

function toGroup(value: unknown): TourGroup | null {
  if (typeof value !== "object" || value === null) return null;
  const group = value as Record<string, unknown>;
  if (typeof group.title !== "string" || !Array.isArray(group.files)) return null;
  const files = group.files.filter(isFileRef).map(({ project, path }) => ({ project, path }));
  if (files.length === 0) return null;
  return {
    title: group.title,
    rationale: typeof group.rationale === "string" ? group.rationale : "",
    files,
  };
}

/**
 * The model's proposed tour, when its ```tour block parses into at least one
 * group with at least one file. Malformed entries are dropped, not guessed at.
 */
export function parseTourPlan(code: string): TourPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const groups = (parsed as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) return null;
  const valid = groups.map(toGroup).filter((group): group is TourGroup => group !== null);
  return valid.length === 0 ? null : { groups: valid };
}
