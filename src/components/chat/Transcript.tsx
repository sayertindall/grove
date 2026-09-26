import { useMemo, useState } from "react";

import {
  CodeBlock,
  EntityChip,
  LoadingState,
  ThinkingState,
  ToolChips,
  ValuePill,
} from "@/components/beautiful";
import { DraftBlock } from "@/components/chat/DraftBlock";
import { FindingCard } from "@/components/chat/FindingCard";
import { parseFences, parseTourPlan, type AnswerSegment } from "@/lib/assistant-blocks";
import {
  INLINE_CITATION,
  inlineText,
  parseMarkdownBlocks,
  type Block,
  type InlineToken,
  type TableAlign,
} from "@/lib/markdown";
import type { ChatCitation, ChatContext, ChatMessage, ChatToolRun, TourPlan } from "@/types/grove";

function toolIcon(name: string): string {
  return ["read_diff", "read_file", "blame", "file_history"].includes(name) ? "read" : "think";
}

/** Unified-diff text → the CodeBlock diff rows. Unparsable lines become context. */
function parseDiffRows(code: string) {
  let oldLine = 0;
  let newLine = 0;
  return code
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("@@"))
    .map((line) => {
      if (line.startsWith("+")) {
        newLine += 1;
        return {
          old: null,
          cur: newLine,
          type: "add" as const,
          pieces: [{ text: line.slice(1), change: "add" as const }],
        };
      }
      if (line.startsWith("-")) {
        oldLine += 1;
        return {
          old: oldLine,
          cur: null,
          type: "del" as const,
          pieces: [{ text: line.slice(1), change: "del" as const }],
        };
      }
      oldLine += 1;
      newLine += 1;
      return {
        old: oldLine,
        cur: newLine,
        type: "ctx" as const,
        pieces: [{ text: line.replace(/^ "/, " ") }],
      };
    });
}

function CitationChips({
  citations,
  fallbackProject,
  onCitationClick,
}: {
  citations: ChatCitation[];
  fallbackProject: string | null;
  onCitationClick: (citation: ChatCitation) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {citations.map((citation, index) => (
        <button
          key={`${citation.label}:${index}`}
          type="button"
          title={`Show ${citation.label} in the diff pane`}
          onClick={() =>
            onCitationClick(
              citation.filePath === null && fallbackProject !== null
                ? { ...citation, projectPath: fallbackProject }
                : citation,
            )
          }
          className="rounded-full transition-opacity duration-100 hover:opacity-85"
        >
          {citation.filePath === null ? (
            <ValuePill tone="accent">{citation.label}</ValuePill>
          ) : (
            <EntityChip name={citation.label} />
          )}
        </button>
      ))}
    </span>
  );
}

/** Inline markdown with citations clickable when the merged citation row knows the label. */
function InlineRun({
  tokens,
  citations,
  onCitationClick,
}: {
  tokens: InlineToken[];
  citations: Map<string, ChatCitation>;
  onCitationClick: (citation: ChatCitation) => void;
}) {
  return tokens.map((token, index) => {
    if (token.kind === "text") return <span key={index}>{token.text}</span>;
    if (token.kind === "code")
      return (
        <code key={index} className="rounded bg-field px-1 py-0.5 font-mono text-[11.5px]">
          {token.text}
        </code>
      );
    if (token.kind === "bold")
      return (
        <strong key={index} className="font-semibold">
          <InlineRun
            tokens={token.children}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        </strong>
      );
    if (token.kind === "italic")
      return (
        <em key={index}>
          <InlineRun
            tokens={token.children}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        </em>
      );
    const citation = citations.get(token.label);
    if (citation === undefined)
      return (
        <span key={index} className="font-mono text-[11.5px]">
          {token.label}
        </span>
      );
    return (
      <button
        key={index}
        type="button"
        title={`Show ${token.label} in the diff pane`}
        className="rounded px-0.5 font-mono text-[11.5px] text-accent underline decoration-dotted transition-opacity duration-100 hover:opacity-85"
        onClick={() => onCitationClick(citation)}
      >
        {token.label}
      </button>
    );
  });
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-[15px] font-semibold",
  2: "text-[14px] font-semibold",
  3: "text-[13px] font-semibold",
  4: "text-[12.5px] font-semibold",
  5: "text-[12.5px] font-medium",
  6: "text-[12.5px] font-medium",
};

const ALIGN_CLASS: Record<TableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function MarkdownBlock({
  block,
  citations,
  onCitationClick,
}: {
  block: Block;
  citations: Map<string, ChatCitation>;
  onCitationClick: (citation: ChatCitation) => void;
}) {
  const inline = (tokens: InlineToken[]) => (
    <InlineRun tokens={tokens} citations={citations} onCitationClick={onCitationClick} />
  );
  switch (block.kind) {
    case "heading":
      return <p className={HEADING_CLASS[block.level]}>{inline(block.children)}</p>;
    case "paragraph":
      return <p>{inline(block.children)}</p>;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="pl-1">
          {inline(item)}
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal space-y-0.5 pl-5" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">{items}</ul>
      );
    }
    case "blockquote":
      return (
        <blockquote className="border-l-2 border-border pl-2 text-ink-2">
          {block.blocks.map((nested, index) => (
            <MarkdownBlock
              key={index}
              block={nested}
              citations={citations}
              onCitationClick={onCitationClick}
            />
          ))}
        </blockquote>
      );
    case "rule":
      return <hr className="border-border" />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11.5px]">
            <thead>
              <tr>
                {block.aligns.map((align, index) => (
                  <th
                    key={index}
                    className={`border-b border-border px-1.5 py-1 font-medium ${ALIGN_CLASS[align]}${inlineText(block.header[index] ?? []).length <= 18 ? " whitespace-nowrap" : ""}`}
                  >
                    {inline(block.header[index] ?? [])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border/60 last:border-b-0">
                  {block.aligns.map((align, columnIndex) => (
                    <td
                      key={columnIndex}
                      className={`px-1.5 py-1 align-top ${ALIGN_CLASS[align]}${inlineText(row[columnIndex] ?? []).length <= 18 ? " whitespace-nowrap" : ""}`}
                    >
                      {inline(row[columnIndex] ?? [])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** The growing answer text. */
function MarkdownAnswer({
  text,
  citations,
  onCitationClick,
}: {
  text: string;
  citations: Map<string, ChatCitation>;
  onCitationClick: (citation: ChatCitation) => void;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-ink">
      {blocks.map((block, index) => (
        <MarkdownBlock
          key={`${block.kind}-${index}`}
          block={block}
          citations={citations}
          onCitationClick={onCitationClick}
        />
      ))}
    </div>
  );
}

/** A proposed review order; applying it hands the plan to the tour rail. */
function TourCard({ plan, onApply }: { plan: TourPlan; onApply?: (plan: TourPlan) => void }) {
  const [applied, setApplied] = useState(false);
  const files = plan.groups.reduce((total, group) => total + group.files.length, 0);
  return (
    <div
      role="group"
      aria-label="Tour proposed"
      className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
    >
      <span className="min-w-0 flex-1 text-xs text-foreground">
        <span className="font-semibold">Tour proposed</span>
        <span className="text-muted-foreground">
          {" "}
          · {plan.groups.length} {plan.groups.length === 1 ? "group" : "groups"} · {files}{" "}
          {files === 1 ? "file" : "files"}
        </span>
        <span className="block truncate text-2xs text-muted-foreground">
          {plan.groups.map((group) => group.title).join(" → ")}
        </span>
      </span>
      <button
        type="button"
        disabled={onApply === undefined || applied}
        onClick={() => {
          onApply?.(plan);
          setApplied(true);
        }}
        className="flex h-[26px] shrink-0 items-center rounded-md bg-foreground px-2.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {applied ? "Applied" : "Apply"}
      </button>
    </div>
  );
}

/** One fenced block: a draft, a tour, a diff, or code. Findings render as cards instead. */
function FencedSegment({
  segment,
  onTourPlan,
}: {
  segment: Extract<AnswerSegment, { kind: "code" }>;
  onTourPlan?: (plan: TourPlan) => void;
}) {
  const [language, ...rest] = segment.info.split(/\s+/);
  if (language === "findings") return null;
  if (language === "draft") return <DraftBlock kind={rest.join(" ")} text={segment.code} />;
  if (language === "tour") {
    const plan = parseTourPlan(segment.code);
    return plan === null ? null : <TourCard plan={plan} onApply={onTourPlan} />;
  }
  if (language?.startsWith("diff"))
    return (
      <CodeBlock variant="Diff" filename={`${language} patch`} diff={parseDiffRows(segment.code)} />
    );
  return (
    <CodeBlock
      variant="Code"
      filename={language === "" || language === undefined ? "code" : language}
      lines={segment.code.replace(/\n$/, "").split("\n")}
    />
  );
}

function AssistantAnswer({
  message,
  isActive,
  context,
  onCitationClick,
  onTourPlan,
}: {
  message: ChatMessage;
  isActive: boolean;
  context: ChatContext;
  onCitationClick: (citation: ChatCitation) => void;
  onTourPlan?: (plan: TourPlan) => void;
}) {
  const segments = useMemo(() => parseFences(message.text), [message.text]);
  const waiting =
    isActive && message.text === "" && message.reasoning === "" && message.tools.length === 0;

  const inlineCitations = useMemo(() => {
    const found: ChatCitation[] = [];
    for (const segment of segments) {
      if (segment.kind !== "text") continue;
      for (const match of segment.text.matchAll(INLINE_CITATION)) {
        const label = `${match[1]}:${match[2]}${match[3] !== undefined ? `-${match[3]}` : ""}`;
        const known = message.citations.find((citation) => citation.label.endsWith(label));
        if (known !== undefined) {
          found.push(known);
          continue;
        }
        found.push({
          projectPath: context.projectPath ?? "",
          filePath: match[1],
          startLine: Number(match[2]),
          endLine: match[3] !== undefined ? Number(match[3]) : null,
          label,
        });
      }
    }
    return found.filter(
      (citation, index) => found.findIndex((entry) => entry.label === citation.label) === index,
    );
  }, [segments, message.citations, context.projectPath]);

  /** One deduplicated chip row: tool-derived citations first, inline-only ones after. */
  const mergedCitations = useMemo(() => {
    const merged = [...message.citations];
    for (const citation of inlineCitations) {
      if (!merged.some((known) => known.label === citation.label)) merged.push(citation);
    }
    return merged;
  }, [message.citations, inlineCitations]);

  const citationsByLabel = useMemo(
    () => new Map(mergedCitations.map((citation) => [citation.label, citation])),
    [mergedCitations],
  );

  const keyedSegments = useMemo(() => {
    let textCount = 0;
    let codeCount = 0;
    return segments.map((segment) => ({
      segment,
      key: segment.kind === "text" ? `text-${textCount++}` : `code-${codeCount++}`,
    }));
  }, [segments]);

  const openCitation = (citation: ChatCitation) =>
    onCitationClick(
      citation.filePath === null && context.projectPath !== null
        ? { ...citation, projectPath: context.projectPath }
        : citation,
    );

  return (
    <div role="group" aria-label="Assistant answer" className="flex flex-col gap-2">
      {message.reasoning !== "" && (
        <ThinkingState
          variant="Reasoning"
          rows={[{ primary: message.reasoning }]}
          active="Thinking"
          done="Reasoned"
        />
      )}
      {message.tools.length > 0 && (
        <ToolChips
          steps={message.tools.map((tool) => toolStep(tool, message.tools))}
          diffs={[]}
          labels={{
            header: `${message.tools.length} tool ${message.tools.length === 1 ? "call" : "calls"}`,
            more: "",
          }}
        />
      )}
      {waiting ? (
        <LoadingState label="Reading the workspace" variant="Drive" />
      ) : message.text === "" && message.error === null && !isActive ? (
        <p className="text-[12.5px] text-ink-3">
          The turn ended without an answer. Nothing was guessed; try asking again.
        </p>
      ) : (
        keyedSegments.map(({ segment, key }) =>
          segment.kind === "text" ? (
            <MarkdownAnswer
              key={key}
              text={segment.text}
              citations={citationsByLabel}
              onCitationClick={openCitation}
            />
          ) : (
            <FencedSegment key={key} segment={segment} onTourPlan={onTourPlan} />
          ),
        )
      )}
      {message.findings.map((finding, index) => (
        <FindingCard
          key={`${finding.path}:${finding.startLine}:${index}`}
          finding={finding}
          onOpen={onCitationClick}
        />
      ))}
      {message.droppedFindings > 0 && (
        <p className="text-2xs text-muted-foreground">
          {message.droppedFindings} {message.droppedFindings === 1 ? "finding" : "findings"} could
          not be tied to a hunk
        </p>
      )}
      {message.error !== null && (
        <p className="rounded-[8px] bg-red-tint px-2 py-1.5 text-[12.5px] text-red" role="alert">
          {message.error}
        </p>
      )}
      <CitationChips
        citations={mergedCitations}
        fallbackProject={context.projectPath}
        onCitationClick={onCitationClick}
      />
      {(message.model !== null || message.cached) && (
        <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
          {message.model}
          {message.cached && (
            <span
              title="Answered from the local summary cache; nothing was sent"
              className="rounded-sm bg-success/15 px-1.5 py-px font-medium text-success-foreground"
            >
              cached
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/** Tool runs become vendor chip rows; duplicates get a stable ordinal suffix. */
function toolStep(tool: ChatToolRun, tools: ChatToolRun[]) {
  const duplicates = tools.filter((entry) => entry.name === tool.name);
  const ordinal = duplicates.length > 1 ? ` ${duplicates.indexOf(tool) + 1}` : "";
  const detail =
    tool.status === "running"
      ? [{ text: "running…" }]
      : tool.status === "error"
        ? [{ text: `${tool.detail} — failed` }]
        : tool.sources.map((source) => ({ text: source.label }));
  return {
    icon: toolIcon(tool.name),
    label: `${tool.name}${ordinal}`,
    chip: tool.detail,
    mono: true,
    detailMono: false,
    detail,
  };
}

/** The conversation: questions as bubbles, answers with their blocks and cards. */
export function Transcript({
  messages,
  activeTurnId,
  context,
  onCitationClick,
  onTourPlan,
}: {
  messages: ChatMessage[];
  activeTurnId: string | null;
  context: ChatContext;
  onCitationClick: (citation: ChatCitation) => void;
  onTourPlan?: (plan: TourPlan) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {messages.map((message) =>
        message.role === "user" ? (
          <div
            key={message.id}
            role="group"
            aria-label="Your question"
            className="flex justify-end"
          >
            <p className="max-w-[90%] rounded-xl bg-input px-3 py-2 text-[13px] leading-[18px] whitespace-pre-wrap text-foreground">
              {message.text}
            </p>
          </div>
        ) : (
          <AssistantAnswer
            key={message.id}
            message={message}
            isActive={activeTurnId === message.id}
            context={context}
            onCitationClick={onCitationClick}
            onTourPlan={onTourPlan}
          />
        ),
      )}
    </div>
  );
}
