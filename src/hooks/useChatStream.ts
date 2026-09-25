import { useCallback, useEffect, useRef, useState } from "react";

import {
  chatCancel,
  chatClear,
  chatHistory,
  chatSend,
  listenForChatDelta,
  listenForChatDone,
  listenForChatError,
  listenForChatReasoning,
  listenForChatTool,
} from "@/api/chat";
import type { ChatContext, ChatMessage } from "@/types/grove";

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
  };
}

export function useChatStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [historyPending, setHistoryPending] = useState(true);
  /** ids of assistant messages whose failure the backend marked retryable */
  const [retryableIds, setRetryableIds] = useState<ReadonlySet<string>>(new Set());
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = activeTurnId;

  /** Patches the assistant message a turnId is streaming into. */
  const patchAssistant = useCallback(
    (turnId: string, patch: (message: ChatMessage) => ChatMessage) => {
      setMessages((current) => {
        const index = current.findIndex(
          (message) => message.id === turnId && message.role === "assistant",
        );
        if (index === -1) return current;
        const next = [...current];
        next[index] = patch(next[index]);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const stops: (() => void)[] = [];
    const track = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else stops.push(unlisten);
    };

    chatHistory()
      .then((history) => {
        if (!cancelled) setMessages(history);
      })
      .catch(() => {
        // An unreadable history leaves an empty transcript; sending still works.
      })
      .finally(() => {
        if (!cancelled) setHistoryPending(false);
      });

    void listenForChatDelta((event) => {
      patchAssistant(event.turnId, (message) => ({ ...message, text: message.text + event.text }));
    }).then(track);

    void listenForChatReasoning((event) => {
      patchAssistant(event.turnId, (message) => ({
        ...message,
        reasoning: message.reasoning + event.text,
      }));
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
      patchAssistant(event.turnId, (message) => ({
        ...message,
        id: event.messageId,
        text: event.text,
        reasoning: event.reasoning,
        citations: event.citations,
        model: event.model,
        error: null,
      }));
      setActiveTurnId((current) => (current === event.turnId ? null : current));
    }).then(track);

    void listenForChatError((event) => {
      patchAssistant(event.turnId, (message) => ({
        ...message,
        error: event.message,
      }));
      if (event.retryable) {
        setRetryableIds((current) => new Set(current).add(event.turnId));
      }
      setActiveTurnId((current) => (current === event.turnId ? null : current));
    }).then(track);

    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, [patchAssistant]);

  const send = useCallback(
    (text: string, context: ChatContext) => {
      const trimmed = text.trim();
      if (trimmed === "" || activeTurnRef.current !== null) return;
      const turnId = crypto.randomUUID();
      setMessages((current) => [
        ...current,
        userMessage(turnId, trimmed),
        assistantMessage(turnId),
      ]);
      setActiveTurnId(turnId);
      void chatSend({ turnId, text: trimmed, context }).catch((error: unknown) => {
        // The command itself failed (no key, no network, refused egress): surface it.
        const message = error instanceof Error ? error.message : String(error);
        patchAssistant(turnId, (draft) => ({ ...draft, error: message }));
        setActiveTurnId((current) => (current === turnId ? null : current));
      });
    },
    [patchAssistant],
  );

  const cancel = useCallback(() => {
    const turnId = activeTurnRef.current;
    if (turnId === null) return;
    void chatCancel(turnId).catch(() => {
      // A lost race with completion is fine; the events settle the message.
    });
  }, []);

  /** Drops the failed answer and re-sends the last user turn. */
  const retry = useCallback(
    (context: ChatContext) => {
      if (activeTurnRef.current !== null) return;
      setMessages((current) => {
        const lastUser = [...current].reverse().find((message) => message.role === "user");
        if (lastUser === undefined) return current;
        const lastUserIndex = current.findIndex((message) => message.id === lastUser.id);
        const turnId = crypto.randomUUID();
        const trimmed = current[lastUserIndex].text;
        const next = [
          ...current.slice(0, lastUserIndex),
          userMessage(turnId, trimmed),
          assistantMessage(turnId),
        ];
        setActiveTurnId(turnId);
        void chatSend({ turnId, text: trimmed, context }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          patchAssistant(turnId, (draft) => ({ ...draft, error: message }));
          setActiveTurnId((current) => (current === turnId ? null : current));
        });
        return next;
      });
    },
    [patchAssistant],
  );

  const clear = useCallback(() => {
    void chatClear()
      .then(() => setMessages([]))
      .catch(() => {
        // Keep the transcript visible if the backend refuses to clear.
      });
  }, []);

  return { messages, activeTurnId, historyPending, retryableIds, send, cancel, retry, clear };
}
