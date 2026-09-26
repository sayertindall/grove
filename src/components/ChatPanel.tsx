import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, PanelRightClose, Settings2 } from "lucide-react";

import { chatKeyStatus, chatSettings, clearChatKey, setChatKey, setChatSettings } from "@/api/chat";
import {
  ApprovalCard,
  CodeBlock,
  ContextCards,
  EntityChip,
  LoadingState,
  PromptBar,
  Shimmer,
  ThinkingState,
  ToolChips,
  ValuePill,
} from "@/components/beautiful";
import {
  inlineText,
  parseMarkdownBlocks,
  type Block,
  type InlineToken,
  type TableAlign,
} from "@/lib/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useChatStream } from "@/hooks/useChatStream";
import {
  segmentedControlItemVariants,
  segmentedControlRootClassName,
} from "@/lib/segmented-control";
import type {
  ChatCitation,
  ChatContext,
  ChatMessage,
  ChatProviderKind,
  ChatSettings,
  ChatToolRun,
} from "@/types/grove";

const PROVIDERS: ChatProviderKind[] = ["openai-compatible", "anthropic"];

/** host of the configured endpoint, for the destination indicator */
function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** loopback endpoints keep workspace data on the machine; anything else is cloud egress */
function isRemoteHost(baseUrl: string): boolean {
  const host = endpointHost(baseUrl).toLowerCase();
  return (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "[::1]" &&
    host !== "" &&
    !host.startsWith("localhost:")
  );
}

function toolIcon(name: string): string {
  return ["read_diff", "read_file", "blame", "file_history"].includes(name) ? "read" : "think";
}

/** `path/to/file.ts:12` and `path/to/file.ts:12-34` tokens in prose */
const INLINE_CITATION = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

type Segment = { kind: "text"; text: string } | { kind: "code"; lang: string; code: string };

/** Splits an answer into prose and fenced blocks; prose keeps inline citations. */
function parseFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /```([A-Za-z0-9_-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "code", lang: match[1] ?? "", code: match[2] ?? "" });
    last = start + match[0].length;
  }
  if (last < text.length) {
    // A fence still open mid-stream renders as code already, so closing it later never jumps layout.
    const openIndex = text.indexOf("```", last);
    if (openIndex !== -1) {
      if (openIndex > last) segments.push({ kind: "text", text: text.slice(last, openIndex) });
      const rest = text.slice(openIndex + 3);
      const newline = rest.indexOf("\n");
      segments.push({
        kind: "code",
        lang: newline === -1 ? rest : rest.slice(0, newline),
        code: newline === -1 ? "" : rest.slice(newline + 1),
      });
      return segments;
    }
    segments.push({ kind: "text", text: text.slice(last) });
  }
  return segments;
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

function ChatSettingsForm({
  settings,
  hasKey,
  onSaved,
  onKeyChanged,
}: {
  settings: ChatSettings;
  hasKey: boolean;
  onSaved: (settings: ChatSettings) => void;
  onKeyChanged: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const save = () => {
    setSaving(true);
    setError(null);
    setChatSettings(draft)
      .then(onSaved)
      .catch((saveError: unknown) => {
        setError(saveError instanceof Error ? saveError.message : "Could not save settings");
      })
      .finally(() => setSaving(false));
  };

  const saveKey = () => {
    if (keyDraft.trim() === "") return;
    setSaving(true);
    setError(null);
    setChatKey(draft.provider, keyDraft.trim())
      .then(onKeyChanged)
      .catch((keyError: unknown) => {
        setError(keyError instanceof Error ? keyError.message : "Could not store the key");
      })
      .finally(() => {
        setSaving(false);
        setKeyDraft("");
      });
  };

  const removeKey = () => {
    setSaving(true);
    clearChatKey(draft.provider)
      .then(onKeyChanged)
      .catch(() => {
        // Nothing to recover: the status line refreshes anyway.
      })
      .finally(() => setSaving(false));
  };

  const numberOrNull = (value: string): number | null => {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-card bg-surface p-3 shadow-card">
      <div className="flex items-center gap-2">
        <Settings2 size={14} className="shrink-0 text-ink-3" aria-hidden />
        <span className="text-[12.5px] font-medium text-ink">Provider settings</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium text-ink-2">Provider</span>
        <ToggleGroup
          aria-label="Chat provider"
          className={segmentedControlRootClassName}
          value={[draft.provider]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === undefined) return;
            if (PROVIDERS.includes(next as ChatProviderKind)) {
              setDraft((current) => ({ ...current, provider: next as ChatProviderKind }));
            }
          }}
        >
          {PROVIDERS.map((provider) => (
            <ToggleGroupItem
              key={provider}
              value={provider}
              className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
            >
              {provider}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium text-ink-2">Base URL</span>
        <Input
          className="h-8 text-[12.5px]"
          value={draft.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium text-ink-2">Model</span>
        <Input
          className="h-8 text-[12.5px]"
          value={draft.model}
          placeholder="model id"
          onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
        />
      </label>
      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11.5px] font-medium text-ink-2">Max tokens</span>
          <Input
            className="h-8 text-[12.5px]"
            type="number"
            value={String(draft.maxTokens)}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              setDraft((current) => ({
                ...current,
                maxTokens: Number.isFinite(parsed) ? parsed : current.maxTokens,
              }));
            }}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11.5px] font-medium text-ink-2">Temperature</span>
          <Input
            className="h-8 text-[12.5px]"
            type="number"
            value={draft.temperature === null ? "" : String(draft.temperature)}
            placeholder="provider default"
            onChange={(event) =>
              setDraft((current) => ({ ...current, temperature: numberOrNull(event.target.value) }))
            }
          />
        </label>
      </div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium text-ink-2">
          Allow cloud egress
          <span className="block font-normal text-ink-3">
            Workspace data would be sent to {endpointHost(draft.baseUrl) || "the provider"}.
          </span>
        </span>
        <Button
          size="sm"
          variant={draft.allowCloudEgress ? "default" : "outline"}
          aria-pressed={draft.allowCloudEgress}
          onClick={() =>
            setDraft((current) => ({ ...current, allowCloudEgress: !current.allowCloudEgress }))
          }
        >
          {draft.allowCloudEgress ? "Allowed" : "Blocked"}
        </Button>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium text-ink-2">
          API key {hasKey ? "(stored — type to replace)" : "(not stored)"}
        </span>
        <span className="flex gap-1.5">
          <Input
            className="h-8 text-[12.5px]"
            type="password"
            value={keyDraft}
            placeholder={hasKey ? "••••••••" : "sk-…"}
            onChange={(event) => setKeyDraft(event.target.value)}
          />
          <Button size="sm" disabled={keyDraft.trim() === "" || saving} onClick={saveKey}>
            Save key
          </Button>
          {hasKey && (
            <Button size="sm" variant="outline" disabled={saving} onClick={removeKey}>
              Remove
            </Button>
          )}
        </span>
      </label>
      {error !== null && <p className="text-[12px] text-red">{error}</p>}
      <Button size="sm" disabled={saving} onClick={save} className="self-start">
        Save settings
      </Button>
    </div>
  );
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

/** The growing answer text, announced politely while the turn streams. */
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

function AssistantAnswer({
  message,
  isActive,
  context,
  onCitationClick,
}: {
  message: ChatMessage;
  isActive: boolean;
  context: ChatContext;
  onCitationClick: (citation: ChatCitation) => void;
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
              onCitationClick={(citation) =>
                onCitationClick(
                  citation.filePath === null && context.projectPath !== null
                    ? { ...citation, projectPath: context.projectPath }
                    : citation,
                )
              }
            />
          ) : segment.lang.startsWith("diff") ? (
            <CodeBlock
              key={key}
              variant="Diff"
              filename={`${segment.lang} patch`}
              diff={parseDiffRows(segment.code)}
            />
          ) : (
            <CodeBlock
              key={key}
              variant="Code"
              filename={segment.lang === "" ? "code" : segment.lang}
              lines={segment.code.replace(/\n$/, "").split("\n")}
            />
          ),
        )
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
      {message.model !== null && <span className="text-[11px] text-ink-3">{message.model}</span>}
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

export default function ChatPanel({
  context,
  width,
  onCitationClick,
  onClose,
}: {
  context: ChatContext;
  width: number;
  onCitationClick: (citation: ChatCitation) => void;
  onClose: () => void;
}) {
  const stream = useChatStream();
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    chatSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setSettingsOpen(loaded.model === "" || loaded.baseUrl === "");
      })
      .catch(() => {
        if (!cancelled) setSettingsOpen(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (settings === null) return;
    let cancelled = false;
    chatKeyStatus(settings.provider)
      .then((status) => {
        if (!cancelled) setHasKey(status);
      })
      .catch(() => {
        if (!cancelled) setHasKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = 0;
  }, [settingsOpen]);

  /** Follow the answer only while the reader is already at the bottom. */
  const [atBottom, setAtBottom] = useState(true);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const onScroll = () => {
      const pinned = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
      pinnedRef.current = pinned;
      setAtBottom(pinned);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null && pinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [stream.messages, stream.activeTurnId]);

  const scrollToLatest = () => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  };

  const providerReady = settings !== null && settings.baseUrl !== "" && settings.model !== "";
  const egressNeedsAck =
    settings !== null && !settings.allowCloudEgress && isRemoteHost(settings.baseUrl);
  const lastMessage = stream.messages.at(-1) ?? null;
  const failedMessage =
    lastMessage !== null && lastMessage.role === "assistant" && lastMessage.error !== null
      ? lastMessage
      : null;
  const recoverable =
    failedMessage !== null &&
    stream.retryableIds.has(failedMessage.id) &&
    !dismissedErrors.has(failedMessage.id);

  const deliver = (text: string) => {
    stream.send(text, context);
  };

  const handleSend = (text: string) => {
    if (egressNeedsAck) {
      setPendingSend(text);
      return;
    }
    deliver(text);
  };

  const acknowledgeEgress = () => {
    if (settings === null || pendingSend === null) return;
    const next = { ...settings, allowCloudEgress: true };
    setChatSettings(next)
      .then((stored) => {
        setSettings(stored);
        const text = pendingSend;
        setPendingSend(null);
        if (text !== null) deliver(text);
      })
      .catch(() => {
        // The card stays up; the user can retry the acknowledgement.
      });
  };

  const contextChunks = [
    {
      title: "Current project",
      chars: context.projectPath ?? "none selected",
      body: "Changes, diffs, file contents, history, and blame for the project selected in Grove.",
      source: context.projectPath === null ? "Nothing selected" : "Sidebar",
      badge: "GIT",
      tone: "bg-accent",
    },
    {
      title: "Selected file",
      chars: context.filePath ?? "none selected",
      body: "The file you are viewing in the diff pane is included as ambient context with every turn.",
      source: context.filePath === null ? "No file open" : "Diff pane",
      badge: "CTX",
      tone: "bg-green",
    },
  ];

  return (
    <aside
      aria-label="Chat"
      className="flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      onKeyDown={(event) => {
        if (event.key === "Escape" && stream.activeTurnId !== null) {
          event.preventDefault();
          stream.cancel();
        }
      }}
      style={{ width }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-[13px] font-medium text-foreground">Chat</span>
        {settings !== null && providerReady && (
          <ValuePill
            tone={
              isRemoteHost(settings.baseUrl) && !settings.allowCloudEgress ? "orange" : "neutral"
            }
          >
            {endpointHost(settings.baseUrl)} · {settings.model}
          </ValuePill>
        )}
        <span className="flex-1" />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Clear transcript"
          title="Clear transcript"
          onClick={() => {
            setDismissedErrors(new Set());
            stream.clear();
          }}
        >
          <Eraser size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Chat settings"
          aria-pressed={settingsOpen}
          title="Chat settings"
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <Settings2 size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close chat"
          title="Close chat"
          onClick={onClose}
        >
          <PanelRightClose size={14} />
        </Button>
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={stream.activeTurnId !== null}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {settingsOpen && settings !== null && (
          <div className="mb-3">
            <ChatSettingsForm
              settings={settings}
              hasKey={hasKey === true}
              onSaved={(stored) => {
                setSettings(stored);
                if (stored.baseUrl !== "" && stored.model !== "") setSettingsOpen(false);
              }}
              onKeyChanged={() => {
                chatKeyStatus(settings.provider)
                  .then(setHasKey)
                  .catch(() => setHasKey(false));
              }}
            />
          </div>
        )}

        {settings === null ? (
          <LoadingState label="Loading chat settings" variant="Drive" />
        ) : !providerReady ? (
          <div className="flex flex-col gap-2 text-[12.5px] text-ink-2">
            <p className="font-medium text-ink">No provider configured</p>
            <p>
              Grove needs a base URL and a model before it can answer. Open the settings above, set
              them, and save. Nothing has been sent anywhere yet.
            </p>
          </div>
        ) : hasKey === false ? (
          <div className="flex flex-col gap-2 text-[12.5px] text-ink-2">
            <p className="font-medium text-ink">No API key stored</p>
            <p>
              No key is available for <span className="font-mono">{settings.provider}</span> (env or
              Keychain). Add one in settings; Grove never displays or logs it.
            </p>
          </div>
        ) : stream.messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-[12.5px] text-ink-2">
              <Shimmer>Ask about this workspace's changes</Shimmer>
              <span className="mt-1 block text-ink-3">
                The assistant is read-only: it can look, never write. Answers cite what it checked.
              </span>
            </p>
            <ContextCards
              chunks={contextChunks}
              labels={{ header: "What the assistant can see", count: String(contextChunks.length) }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {stream.messages.map((message) =>
              message.role === "user" ? (
                <div
                  key={message.id}
                  role="group"
                  aria-label="Your question"
                  className="flex justify-end"
                >
                  <p className="max-w-[90%] rounded-card bg-field px-2.5 py-1.5 text-[12.5px] text-ink shadow-hairline">
                    {message.text}
                  </p>
                </div>
              ) : (
                <AssistantAnswer
                  key={message.id}
                  message={message}
                  isActive={stream.activeTurnId === message.id}
                  context={context}
                  onCitationClick={onCitationClick}
                />
              ),
            )}
          </div>
        )}
      </div>

      {!atBottom && stream.messages.length > 0 && (
        <div className="flex shrink-0 justify-center pb-1">
          <Button size="sm" variant="outline" onClick={scrollToLatest}>
            Latest
          </Button>
        </div>
      )}

      <div className="shrink-0 border-t border-border px-3 py-2.5">
        {egressNeedsAck && pendingSend !== null && settings !== null && (
          <div className="mb-2.5">
            <ApprovalCard
              questions={[
                {
                  q: `Send this workspace's data to ${endpointHost(settings.baseUrl)}?`,
                  type: "radio",
                  options: ["Allow cloud egress and remember"],
                },
              ]}
              labels={{ continue: "Allow", send: "Allowed" }}
              onSubmitted={() => acknowledgeEgress()}
            />
          </div>
        )}
        {recoverable && failedMessage !== null && (
          <div className="mb-2.5">
            <ApprovalCard
              questions={[
                {
                  q: `The last turn failed: ${failedMessage.error ?? "unknown error"}`,
                  type: "radio",
                  options: ["Retry the request", "Dismiss"],
                },
              ]}
              onSubmitted={(answers) => {
                setDismissedErrors((current) => new Set(current).add(failedMessage.id));
                if (answers[0]?.includes(0)) stream.retry(context);
              }}
            />
          </div>
        )}
        {stream.activeTurnId !== null && (
          <div className="mb-2 flex items-center justify-between gap-2">
            <LoadingState label="Working" variant="Drive" />
            <Button size="sm" variant="outline" onClick={stream.cancel}>
              Stop
            </Button>
          </div>
        )}
        <PromptBar
          placeholder={
            providerReady && hasKey !== false
              ? "Ask about this workspace's changes…"
              : hasKey === false
                ? "Add an API key in settings to start chatting"
                : "Configure the provider to start chatting"
          }
          onSend={handleSend}
        />
      </div>
    </aside>
  );
}
