import { useCallback, useEffect, useRef, useState } from "react";

import {
  chatCancel,
  chatClear,
  chatHistory,
  chatSend,
  listenForChatDelta,
  listenForChatDone,
  listenForChatEgress,
  listenForChatError,
  listenForChatReasoning,
  listenForChatTool,
} from "@/api/chat";
import type { ChatContext, ChatEgressEvent, ChatMessage, QuickAction } from "@/types/grove";

/** Coalescing window for streamed text, in milliseconds. */
const STREAM_FLUSH_MS = 50;

/** A fresh user message: tool runs and citations only ever appear on answers. */
function userMessage(turnId: string, text: string): ChatMessage {
  return {
    id: `${turnId}:user`,
    role: "user",
    text,
    reasoning: "",
    tools: [],
    citations: [],
    model: null,
    createdAt: Date.now(),
    error: null,
    cached: false,
    findings: [],
    droppedFindings: 0,
  };
}

/** The assistant placeholder a turn streams into; events address it by turnId. */
function assistantMessage(turnId: string): ChatMessage {
  return {
    id: turnId,
    role: "assistant",
    text: "",
    reasoning: "",
    tools: [],
    citations: [],
    model: null,
    createdAt: Date.now(),
    error: null,
    cached: false,
    findings: [],
    droppedFindings: 0,
  };
}

/** What a turn was started with, so a retry repeats the same request. */
interface TurnRequest {
  text: string;
  context: ChatContext;
  action: QuickAction | null;
}

export function useChatStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [historyPending, setHistoryPending] = useState(true);
  /** ids of assistant messages whose failure the backend marked retryable */
  const [retryableIds, setRetryableIds] = useState<ReadonlySet<string>>(new Set());
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = activeTurnId;
  const messagesRef = useRef<ReadonlyArray<ChatMessage>>([]);
  messagesRef.current = messages;
  /** Turn ids whose two local messages exist only here, not yet in backend history. */
  const localTurnIdsRef = useRef<Set<string>>(new Set());
  /** The live "sent so far" counter of the latest turn that sent anything. */
  const [egress, setEgress] = useState<ChatEgressEvent | null>(null);
  const lastRequestRef = useRef<TurnRequest | null>(null);

  /**
   * Patches the assistant message a turnId is streaming into. When the turn is
   * unknown (history replaced the list, or the event raced the load) `create`
   * appends a settled message so no event is ever lost.
   */
  const patchAssistant = useCallback(
    (turnId: string, patch: (message: ChatMessage) => ChatMessage, create?: () => ChatMessage) => {
      setMessages((current) => {
        const index = current.findIndex(
          (message) => message.id === turnId && message.role === "assistant",
        );
        if (index !== -1) {
          const next = [...current];
          next[index] = patch(next[index]);
          return next;
        }
        if (create === undefined) return current;
        return [...current, create()];
      });
    },
    [],
  );

  /** Marks a turn finished locally and forgets its local-only ids. */
  const settleTurn = useCallback((turnId: string) => {
    setActiveTurnId((current) => (current === turnId ? null : current));
    localTurnIdsRef.current.delete(turnId);
  }, []);

  /**
   * Streamed text is coalesced before it reaches state: one answer costs a few
   * renders instead of one per token, which matters because every render re-parses
   * the whole markdown answer.
   */
  const pendingRef = useRef<{ turnId: string; text: string; reasoning: string } | null>(null);
  const flushTimerRef = useRef<number | undefined>(undefined);

  const flushPending = useCallback(() => {
    window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = undefined;
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    patchAssistant(pending.turnId, (message) => ({
      ...message,
      text: message.text + pending.text,
      reasoning: message.reasoning + pending.reasoning,
    }));
  }, [patchAssistant]);

  const queueStream = useCallback(
    (turnId: string, text: string, reasoning: string) => {
      const pending = pendingRef.current;
      if (pending === null || pending.turnId !== turnId) {
        flushPending();
        pendingRef.current = { turnId, text, reasoning };
      } else {
        pending.text += text;
        pending.reasoning += reasoning;
      }
      if (flushTimerRef.current === undefined) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = undefined;
          flushPending();
        }, STREAM_FLUSH_MS);
      }
    },
    [flushPending],
  );

  useEffect(() => () => window.clearTimeout(flushTimerRef.current), []);

  useEffect(() => {
    let cancelled = false;
    const stops: (() => void)[] = [];
    const track = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else stops.push(unlisten);
    };

    chatHistory()
      .then((history) => {
        if (cancelled) return;
        // Merge instead of replace: deltas may already have created a streaming
        // placeholder that persisted history cannot know about yet.
        setMessages((current) => {
          if (current.length === 0) return history;
          const localIds = new Set<string>();
          for (const turnId of localTurnIdsRef.current) {
            localIds.add(turnId);
            localIds.add(`${turnId}:user`);
          }
          const persisted = new Set(history.map((message) => message.id));
          const inFlight = current.filter(
            (message) => localIds.has(message.id) && !persisted.has(message.id),
          );
          return [...history, ...inFlight];
        });
      })
      .catch(() => {
        // An unreadable history leaves the transcript as-is; sending still works.
      })
      .finally(() => {
        if (!cancelled) setHistoryPending(false);
      });

    void listenForChatEgress((event) => {
      setEgress(event);
    }).then(track);

    void listenForChatDelta((event) => {
      queueStream(event.turnId, event.text, "");
    }).then(track);

    void listenForChatReasoning((event) => {
      queueStream(event.turnId, "", event.text);
    }).then(track);

    void listenForChatTool((event) => {
      patchAssistant(event.turnId, (message) => {
        const tools = [...message.tools];
        const index = tools.findIndex((tool) => tool.callId === event.tool.callId);
        if (index === -1) tools.push(event.tool);
        else tools[index] = event.tool;
        return { ...message, tools };
      });
    }).then(track);

    void listenForChatDone((event) => {
      // The backend persists the answer before announcing it, so the event's
      // message is the final word: its id, text, citations and model. It replaces
      // the placeholder in place; if the placeholder is gone the persisted
      // message is appended so the answer still lands in the transcript.
      flushPending();
      patchAssistant(
        event.turnId,
        () => ({ ...event.message }),
        () => ({ ...event.message }),
      );
      setRetryableIds((current) => {
        if (!current.has(event.turnId)) return current;
        const next = new Set(current);
        next.delete(event.turnId);
        return next;
      });
      settleTurn(event.turnId);
    }).then(track);

    void listenForChatError((event) => {
      flushPending();
      patchAssistant(
        event.turnId,
        (message) => ({ ...message, error: event.message }),
        () => ({ ...assistantMessage(event.turnId), error: event.message }),
      );
      if (event.retryable) {
        setRetryableIds((current) => new Set(current).add(event.turnId));
      }
      settleTurn(event.turnId);
    }).then(track);

    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, [patchAssistant, settleTurn, queueStream, flushPending]);

  const startTurn = useCallback(
    (turnId: string, { text, context, action }: TurnRequest) => {
      localTurnIdsRef.current.add(turnId);
      lastRequestRef.current = { text, context, action };
      setMessages((current) => [...current, userMessage(turnId, text), assistantMessage(turnId)]);
      setActiveTurnId(turnId);
      setEgress(null);
      void chatSend({ turnId, text, context, action }).catch((error: unknown) => {
        // The command itself failed (no key, no network, refused egress). Events
        // may already have arrived, so only surface this onto a live, errorless
        // placeholder; and always settle so the panel stops spinning.
        const message = error instanceof Error ? error.message : String(error);
        patchAssistant(
          turnId,
          (draft) => (draft.error === null ? { ...draft, error: message } : draft),
          () => ({ ...assistantMessage(turnId), error: message }),
        );
        settleTurn(turnId);
      });
    },
    [patchAssistant, settleTurn],
  );

  const send = useCallback(
    (text: string, context: ChatContext, action: QuickAction | null = null) => {
      const trimmed = text.trim();
      if (trimmed === "" || activeTurnRef.current !== null) return;
      startTurn(crypto.randomUUID(), { text: trimmed, context, action });
    },
    [startTurn],
  );

  const cancel = useCallback(() => {
    const turnId = activeTurnRef.current;
    if (turnId === null) return;
    void chatCancel(turnId)
      .catch(() => {
        // A lost race with completion is fine; settle either way.
      })
      .finally(() => {
        // The backend may emit no further event for this turn (or the cancel
        // command itself failed), so stop the spinner here. A late error or
        // done event still applies on top.
        settleTurn(turnId);
      });
  }, [settleTurn]);

  /** Drops the failed answer and re-sends the last user turn, action included. */
  const retry = useCallback(
    (context: ChatContext) => {
      if (activeTurnRef.current !== null) return;
      const lastUser = [...messagesRef.current]
        .reverse()
        .find((message) => message.role === "user");
      if (lastUser === undefined) return;
      setMessages((current) => current.filter((message) => message.id !== lastUser.id));
      const last = lastRequestRef.current;
      const repeat =
        last !== null && last.text === lastUser.text
          ? last
          : { text: lastUser.text, context, action: null };
      startTurn(crypto.randomUUID(), repeat);
    },
    [startTurn],
  );

  const clear = useCallback(() => {
    void chatClear()
      .then(() => {
        localTurnIdsRef.current.clear();
        setMessages([]);
      })
      .catch(() => {
        // Keep the transcript visible if the backend refuses to clear.
      });
  }, []);

  return {
    messages,
    activeTurnId,
    historyPending,
    retryableIds,
    egress,
    send,
    cancel,
    retry,
    clear,
  };
}
