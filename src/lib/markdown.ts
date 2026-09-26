/** Hand-rolled markdown block/inline parser for assistant answers. No dependencies. */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: InlineToken[] }
  | { kind: "italic"; children: InlineToken[] }
  | { kind: "citation"; label: string };

export type TableAlign = "left" | "center" | "right";

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineToken[] }
  | { kind: "paragraph"; children: InlineToken[] }
  | { kind: "list"; ordered: boolean; start: number; items: InlineToken[][] }
  | { kind: "blockquote"; blocks: Block[] }
  | { kind: "rule" }
  | {
      kind: "table";
      aligns: TableAlign[];
      header: InlineToken[][];
      rows: InlineToken[][][];
    };

/** `path/to/file.ts:12` and `path/to/file.ts:12-34` tokens in prose */
const CITATION = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/y;

const RULE = /^(?:\*{3,}|-{3,}|_{3,})$/;
const BULLET = /^[-*+]\s+/;
const ORDERED = /^(\d{1,9})[.)]\s+/;

/** The plain text of inline tokens, for measuring how wide a table cell renders. */
export function inlineText(tokens: InlineToken[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.kind) {
      case "bold":
      case "italic":
        out += inlineText(token.children);
        break;
      case "citation":
        out += token.label;
        break;
      default:
        out += token.text;
    }
  }
  return out;
}

/** Parses one line of prose into text, inline code, bold, italic, and citation tokens. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") {
      tokens.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index) {
        flush();
        tokens.push({ kind: "code", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (character === "*") {
      if (text[index + 1] === "*") {
        const end = text.indexOf("**", index + 2);
        if (end > index) {
          flush();
          tokens.push({ kind: "bold", children: parseInline(text.slice(index + 2, end)) });
          index = end + 2;
          continue;
        }
      }
      const end = text.indexOf("*", index + 1);
      if (end > index) {
        flush();
        tokens.push({ kind: "italic", children: parseInline(text.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }
    CITATION.lastIndex = index;
    const citation = CITATION.exec(text);
    if (citation !== null) {
      flush();
      tokens.push({ kind: "citation", label: citation[0] });
      index += citation[0].length;
      continue;
    }
    buffer += character;
    index += 1;
  }
  flush();
  return tokens;
}

/** GFM pipe row → cells; `\|` is a literal pipe. Null when the line has no pipes. */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** `| --- | :-: |` delimiter row → column alignments, or null. */
function delimiterAligns(line: string): TableAlign[] | null {
  const cells = splitRow(line);
  if (cells === null || cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const match = /^:?-+:?$/.exec(cell);
    if (match === null) return null;
    aligns.push(
      cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
    );
  }
  return aligns;
}

function startsBlock(line: string): boolean {
  return (
    line.trim() === "" ||
    RULE.test(line.trim()) ||
    /^#{1,6}\s/.test(line) ||
    line.startsWith(">") ||
    BULLET.test(line.trimStart()) ||
    ORDERED.test(line.trimStart())
  );
}

/** Parses non-fenced markdown text into blocks: headings, paragraphs, lists, quotes, rules, tables. */
export function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }
    if (RULE.test(trimmed)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quoted.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", blocks: parseMarkdownBlocks(quoted.join("\n")) });
      continue;
    }
    const headerCells = splitRow(line);
    const next = index + 1 < lines.length ? delimiterAligns(lines[index + 1]) : null;
    if (headerCells !== null && next !== null && headerCells.length === next.length) {
      const header = headerCells.map((cell) => parseInline(cell));
      index += 2;
      const rows: InlineToken[][][] = [];
      while (index < lines.length) {
        const cells = splitRow(lines[index]);
        if (cells === null || cells.length === 0) break;
        rows.push(
          Array.from({ length: next.length }, (_, column) => parseInline(cells[column] ?? "")),
        );
        index += 1;
      }
      blocks.push({ kind: "table", aligns: next, header, rows });
      continue;
    }
    if (BULLET.test(trimmed) || ORDERED.test(trimmed)) {
      const ordered = ORDERED.test(trimmed);
      const start = ordered ? Number(ORDERED.exec(trimmed)?.[1] ?? 1) : 1;
      const items: InlineToken[][] = [];
      while (index < lines.length) {
        const current = lines[index].trimStart();
        const bullet = BULLET.exec(current);
        const orderedMatch = ORDERED.exec(current);
        if (bullet === null && orderedMatch === null) {
          if (lines[index].trim() === "" || startsBlock(lines[index])) break;
          if (items.length > 0) {
            // Lazy continuation: append wrapped prose to the open list item.
            const last = items[items.length - 1];
            const tail = parseInline(` ${lines[index].trim()}`);
            items[items.length - 1] = [...last, ...tail];
          }
          index += 1;
          continue;
        }
        const marker = bullet ?? orderedMatch;
        if (items.length > 0 && (bullet === null) !== ordered) break;
        items.push(parseInline(current.slice(marker?.[0].length ?? 0)));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}
