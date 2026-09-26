import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Eraser, PanelRightClose, Settings2 } from "lucide-react";

import { chatKeyStatus, chatPreview, chatSettings, setChatSettings } from "@/api/chat";
import { listChanges, listReviewed } from "@/api/grove";
import { ContextCards, LoadingState, Shimmer } from "@/components/beautiful";
import { Composer } from "@/components/chat/Composer";
import { PreSendSheet } from "@/components/chat/PreSendSheet";
import { SettingsForm } from "@/components/chat/SettingsForm";
import { Transcript } from "@/components/chat/Transcript";
import { Button } from "@/components/ui/button";
import { useChatStream } from "@/hooks/useChatStream";
import type {
  ChatCitation,
  ChatContext,
  ChatFinding,
  ChatPreview,
  ChatSettings,
  QuickAction,
  TourPlan,
} from "@/types/grove";

/** A line range in the diff the user wants explained. */
export interface LineRange {
  projectPath: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** A turn waiting for the pre-send sheet's answer. */
interface PendingTurn {
  text: string;
  context: ChatContext;
  action: QuickAction | null;
}

/** "Don't ask again" lasts for this app session only. */
const SKIP_PREVIEW_KEY = "grove.chat.skipPreview";

const NO_FINDINGS: ChatFinding[] = [];

function projectName(projectPath: string): string {
  return projectPath.split("/").filter(Boolean).pop() ?? projectPath;
}

/** True when turns leave the machine (the backend's loopback rule, mirrored). */
function reachesCloud(settings: ChatSettings): boolean {
  if (settings.provider === "cli")
    return settings.cliCommand === "claude" || settings.cliLocalServer === null;
  try {
    return !["127.0.0.1", "localhost", "[::1]"].includes(new URL(settings.baseUrl).hostname);
  } catch {
    return true;
  }
}

/** The endpoint shown in the header pill. */
function destinationLabel(settings: ChatSettings): string {
  if (settings.provider === "cli") {
    const model = settings.model === "" ? "default model" : settings.model;
    return `${settings.cliCommand} CLI · ${model}`;
  }
  try {
    return `${settings.model} · ${new URL(settings.baseUrl).host}`;
  } catch {
    return `${settings.model} · ${settings.baseUrl}`;
  }
}

/** The quick-action row: each is a templated question about what is in view. */
function QuickActions({
  context,
  disabled,
  onAction,
}: {
  context: ChatContext;
  disabled: boolean;
  onAction: (action: QuickAction) => void;
}) {
  const actions: { action: QuickAction; label: string; needs: "file" | "project" }[] = [
    { action: "explain-file", label: "Explain file", needs: "file" },
    { action: "explain-repo", label: "Explain repo", needs: "project" },
    { action: "since-last-viewed", label: "Since last viewed", needs: "project" },
    { action: "draft-commit-message", label: "Draft commit message", needs: "project" },
  ];
  return (
    <div
      role="toolbar"
      aria-label="Quick actions"
      className="flex shrink-0 flex-wrap gap-1 px-3 pt-3 pb-1"
    >
      {actions.map(({ action, label, needs }) => {
        const missing = needs === "file" ? context.filePath === null : context.projectPath === null;
        return (
          <button
            key={action}
            type="button"
            disabled={disabled || missing || context.projectPath === null}
            title={missing ? `Select a ${needs} first` : undefined}
            onClick={() => onAction(action)}
            className="flex h-6 items-center rounded-full border border-input px-2 text-2xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-45"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function ChatPanel({
  context,
  width,
  cancelRef,
  askAboutLinesRef,
  onCitationClick,
  onTourPlan,
  onFindings,
  onClose,
}: {
  context: ChatContext;
  width: number;
  /** Escape from anywhere cancels the running turn through this ref. */
  cancelRef: MutableRefObject<(() => void) | null>;
  /** The diff viewer asks about a selected line range through this ref. */
  askAboutLinesRef?: MutableRefObject<((range: LineRange) => void) | null>;
  onCitationClick: (citation: ChatCitation) => void;
  /** Called when the user applies a tour the assistant proposed. */
  onTourPlan?: (plan: TourPlan) => void;
  /** The latest answer's findings, anchored to changed hunks, for the gutter. */
  onFindings?: (findings: ChatFinding[]) => void;
  onClose: () => void;
}) {
  const stream = useChatStream();
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [sheet, setSheet] = useState<{ preview: ChatPreview; turn: PendingTurn } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skipPreview, setSkipPreview] = useState(
    () => sessionStorage.getItem(SKIP_PREVIEW_KEY) === "1",
  );
  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current = stream.cancel;
    return () => {
      cancelRef.current = null;
    };
  }, [stream.cancel, cancelRef]);

  useEffect(() => {
    let cancelled = false;
    chatSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setSettingsOpen(
          loaded.provider !== "cli" && (loaded.model === "" || loaded.baseUrl === ""),
        );
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
      .then((status) => !cancelled && setHasKey(status))
      .catch(() => !cancelled && setHasKey(false));
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

  const latestFindings = useMemo(() => {
    const answer = [...stream.messages].reverse().find((message) => message.role === "assistant");
    return answer?.findings ?? NO_FINDINGS;
  }, [stream.messages]);

  useEffect(() => {
    onFindings?.(latestFindings);
  }, [latestFindings, onFindings]);

  const providerReady =
    settings !== null &&
    (settings.provider === "cli" || (settings.baseUrl !== "" && settings.model !== ""));
  const lastMessage = stream.messages.at(-1) ?? null;
  const failedMessage =
    lastMessage !== null && lastMessage.role === "assistant" && lastMessage.error !== null
      ? lastMessage
      : null;
  const recoverable =
    failedMessage !== null &&
    stream.retryableIds.has(failedMessage.id) &&
    !dismissedErrors.has(failedMessage.id);

  /**
   * Starts a turn, through the pre-send sheet when it will leave the machine.
   * A loopback turn skips the sheet; the composer's counter still shows it.
   */
  const requestTurn = useCallback(
    (turn: PendingTurn) => {
      if (settings === null || stream.activeTurnId !== null) return;
      setNotice(null);
      if (!settings.previewBeforeSend || skipPreview) {
        stream.send(turn.text, turn.context, turn.action);
        return;
      }
      chatPreview({ turnId: "preview", ...turn })
        .then((preview) => {
          if (preview.loopback && preview.blocked === null)
            stream.send(turn.text, turn.context, turn.action);
          else setSheet({ preview, turn });
        })
        .catch((error: unknown) => {
          setNotice(error instanceof Error ? error.message : "Could not measure the request");
        });
    },
    [settings, skipPreview, stream],
  );

  const quickAction = (action: QuickAction) => {
    const project = context.projectPath;
    if (project === null) return;
    const name = projectName(project);
    const file = context.filePath;
    const templates: Record<Exclude<QuickAction, "since-last-viewed">, string> = {
      "explain-file": `Explain the changes to ${file ?? "this file"} in ${name}: what changed, why it likely changed, and anything risky.`,
      "explain-repo": `Explain the uncommitted changes in ${name} as a whole: the themes, how the files relate, and where a reviewer should start.`,
      "draft-commit-message": `Draft a commit message for the uncommitted changes in ${name}: a subject line under 72 characters, a blank line, then a short body.`,
    };
    if (action !== "since-last-viewed") {
      requestTurn({ text: templates[action], context: { ...context, files: [] }, action });
      return;
    }
    Promise.all([listChanges(project, false), listReviewed(project)])
      .then(([changes, marks]) => {
        const viewedAt = new Map(marks.map((mark) => [mark.filePath, mark.contentHash]));
        const files = changes.files
          .filter((file) => viewedAt.has(file.path) && viewedAt.get(file.path) !== file.contentHash)
          .map((file) => file.path);
        if (files.length === 0) {
          setNotice(
            viewedAt.size === 0
              ? `Nothing in ${name} is marked viewed yet, so there is no "since" to compare against.`
              : `Nothing you marked viewed in ${name} has changed since.`,
          );
          return;
        }
        requestTurn({
          text: `Explain what changed since I last viewed these files in ${name}: ${files.join(", ")}.`,
          context: { ...context, files },
          action,
        });
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : "Could not read the review state");
      });
  };

  useEffect(() => {
    if (askAboutLinesRef === undefined) return;
    askAboutLinesRef.current = (range) => {
      const lines =
        range.endLine > range.startLine
          ? `lines ${range.startLine}–${range.endLine}`
          : `line ${range.startLine}`;
      requestTurn({
        text: `Explain ${lines} of ${range.filePath} in ${projectName(range.projectPath)}: what they do, why they changed, and anything risky.`,
        context: { projectPath: range.projectPath, filePath: range.filePath, files: [] },
        action: "explain-file",
      });
    };
    return () => {
      askAboutLinesRef.current = null;
    };
  }, [askAboutLinesRef, requestTurn]);

  const storeSettings = (next: ChatSettings) =>
    setChatSettings(next)
      .then((stored) => {
        setSettings(stored);
        return stored;
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : "Could not save settings");
        return null;
      });

  /** Stores a settings change the sheet made, then re-measures the pending turn. */
  const storeAndRemeasure = (next: ChatSettings, turn: PendingTurn) => {
    void storeSettings(next).then((stored) => {
      if (stored === null) return;
      chatPreview({ turnId: "preview", ...turn })
        .then((preview) => setSheet({ preview, turn }))
        .catch(() => setSheet(null));
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

  const ready = settings !== null && providerReady && hasKey !== false;

  return (
    <aside
      aria-label="Assistant"
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-sidebar"
      style={{ width }}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-sidebar-border pr-2 pl-4">
        <span className="text-[13px] font-semibold text-foreground">Assistant</span>
        {settings !== null && providerReady && (
          <span className="flex h-5 min-w-0 items-center gap-1.5 rounded-sm bg-muted px-1.5">
            <span
              aria-hidden
              title={
                !reachesCloud(settings)
                  ? "Stays on this machine"
                  : settings.allowCloudEgress
                    ? "Cloud egress allowed"
                    : "Cloud egress is off"
              }
              className={`size-1.5 shrink-0 rounded-full ${reachesCloud(settings) && !settings.allowCloudEgress ? "bg-warning" : "bg-success"}`}
            />
            <span className="truncate font-mono text-2xs text-muted-foreground">
              {destinationLabel(settings)}
            </span>
          </span>
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
          aria-label="Assistant settings"
          aria-pressed={settingsOpen}
          title="Assistant settings"
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <Settings2 size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close assistant"
          title="Close assistant"
          onClick={onClose}
        >
          <PanelRightClose size={14} />
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-sidebar-border px-4 py-2.5">
        <span className="text-2xs text-muted-foreground">In view</span>
        <span className="min-w-0 truncate font-mono text-2xs text-foreground">
          {context.projectPath === null
            ? "nothing selected"
            : [projectName(context.projectPath), context.filePath].filter(Boolean).join(" · ")}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-[10px] font-semibold text-success-foreground">
          read-only
        </span>
      </div>

      <QuickActions
        context={context}
        disabled={!ready || stream.activeTurnId !== null}
        onAction={quickAction}
      />

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={stream.activeTurnId !== null}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {settingsOpen && settings !== null && (
          <div className="mb-3">
            <SettingsForm
              settings={settings}
              projectInView={context.projectPath}
              onSaved={(stored) => {
                setSettings(stored);
                if (stored.provider === "cli" || (stored.baseUrl !== "" && stored.model !== ""))
                  setSettingsOpen(false);
              }}
            />
          </div>
        )}

        {notice !== null && (
          <p
            role="status"
            className="mb-3 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"
          >
            {notice}
          </p>
        )}

        {settings === null ? (
          <LoadingState label="Loading assistant settings" variant="Drive" />
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
          <Transcript
            messages={stream.messages}
            activeTurnId={stream.activeTurnId}
            context={context}
            onCitationClick={onCitationClick}
            onTourPlan={onTourPlan}
          />
        )}
      </div>

      {!atBottom && stream.messages.length > 0 && (
        <div className="flex shrink-0 justify-center pb-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const node = scrollRef.current;
              if (node !== null) node.scrollTop = node.scrollHeight;
            }}
          >
            Latest
          </Button>
        </div>
      )}

      <Composer
        placeholder={
          ready
            ? `Ask about ${context.projectPath === null ? "this workspace" : projectName(context.projectPath)}…`
            : hasKey === false
              ? "Add an API key in settings to start chatting"
              : "Configure the provider to start chatting"
        }
        onSend={(text) => requestTurn({ text, context: { ...context, files: [] }, action: null })}
        working={stream.activeTurnId !== null}
        onStop={stream.cancel}
        failure={
          recoverable && failedMessage !== null ? (failedMessage.error ?? "unknown error") : null
        }
        onRetry={() => {
          if (failedMessage !== null)
            setDismissedErrors((current) => new Set(current).add(failedMessage.id));
          stream.retry(context);
        }}
        onDismiss={() => {
          if (failedMessage !== null)
            setDismissedErrors((current) => new Set(current).add(failedMessage.id));
        }}
        previewBeforeSend={settings?.previewBeforeSend ?? true}
        onPreviewChange={(previewBeforeSend) => {
          if (settings !== null) void storeSettings({ ...settings, previewBeforeSend });
        }}
        egress={stream.egress}
        perTurnCap={settings?.caps.perTurnTokens ?? null}
      />

      {sheet !== null && settings !== null && (
        <PreSendSheet
          preview={sheet.preview}
          skipForSession={skipPreview}
          onSkipForSessionChange={(skip) => {
            setSkipPreview(skip);
            if (skip) sessionStorage.setItem(SKIP_PREVIEW_KEY, "1");
            else sessionStorage.removeItem(SKIP_PREVIEW_KEY);
          }}
          onCancel={() => setSheet(null)}
          onSend={() => {
            const { turn } = sheet;
            setSheet(null);
            stream.send(turn.text, turn.context, turn.action);
          }}
          onNeverSend={
            sheet.turn.context.projectPath === null
              ? undefined
              : () => {
                  const project = sheet.turn.context.projectPath;
                  if (project === null || settings.neverSend.includes(project)) return;
                  storeAndRemeasure(
                    { ...settings, neverSend: [...settings.neverSend, project] },
                    sheet.turn,
                  );
                }
          }
          onAllowEgress={
            !sheet.preview.loopback && !settings.allowCloudEgress
              ? () => storeAndRemeasure({ ...settings, allowCloudEgress: true }, sheet.turn)
              : undefined
          }
        />
      )}
    </aside>
  );
}
