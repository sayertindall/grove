/**
 * A small subsequence matcher for the command palette: every query character
 * must appear in order. Matches on word starts and in consecutive runs score
 * higher, so "qry" ranks `query.ts` above `quarterly.ts`.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate text of each matched query character. */
  indices: number[];
}

const BOUNDARY = /[\s/._\-:]/;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] ?? "";
  if (BOUNDARY.test(previous)) return true;
  const current = text[index] ?? "";
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

/** Leftmost positions of each query char, or null when the query is not a subsequence. */
function forwardIndices(lowerText: string, lowerQuery: string): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (const char of lowerQuery) {
    const at = lowerText.indexOf(char, from);
    if (at === -1) return null;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

/** Walks back from the last match so the matched span is as tight as possible. */
function tightenIndices(lowerText: string, lowerQuery: string, forward: number[]): number[] {
  const indices = [...forward];
  let limit = forward[forward.length - 1] ?? 0;
  for (let q = lowerQuery.length - 1; q >= 0; q -= 1) {
    const at = lowerText.lastIndexOf(lowerQuery[q] ?? "", limit);
    indices[q] = at;
    limit = at - 1;
  }
  return indices;
}

function scoreIndices(text: string, indices: number[]): number {
  let score = 0;
  indices.forEach((index, position) => {
    score += 1;
    if (isWordStart(text, index)) score += 8;
    if (position > 0 && index === (indices[position - 1] ?? -2) + 1) score += 5;
  });
  const span = (indices[indices.length - 1] ?? 0) - (indices[0] ?? 0);
  return score - span * 0.5 - (indices[0] ?? 0) * 0.2 - text.length * 0.05;
}

/** Scores `text` against `query`; null when some query character is missing. */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const trimmed = query.trim();
  if (trimmed === "") return { score: 0, indices: [] };
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const forward = forwardIndices(lowerText, lowerQuery);
  if (forward === null) return null;
  const tight = tightenIndices(lowerText, lowerQuery, forward);
  const forwardScore = scoreIndices(text, forward);
  const tightScore = scoreIndices(text, tight);
  return tightScore > forwardScore
    ? { score: tightScore, indices: tight }
    : { score: forwardScore, indices: forward };
}

export interface TextRun {
  text: string;
  matched: boolean;
}

/** Splits `text` into alternating matched and unmatched runs for highlighting. */
export function matchRuns(text: string, indices: readonly number[]): TextRun[] {
  const marked = new Set(indices);
  const runs: TextRun[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const matched = marked.has(index);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.matched === matched) {
      last.text += text[index];
    } else {
      runs.push({ text: text[index] ?? "", matched });
    }
  }
  return runs;
}
