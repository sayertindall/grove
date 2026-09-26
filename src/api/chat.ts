import { invokeCommand, toError } from "@/api/invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChatCliCommand,
  ChatCliStatus,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatEgressEvent,
  ChatErrorEvent,
  ChatMessage,
  ChatPreview,
  ChatReasoningEvent,
  ChatSendRequest,
  ChatSettings,
  ChatToolEvent,
  ChatUsage,
} from "@/types/grove";

export const CHAT_EGRESS_EVENT = "grove://chat-egress";

export const CHAT_DELTA_EVENT = "grove://chat-delta";
export const CHAT_REASONING_EVENT = "grove://chat-reasoning";
export const CHAT_TOOL_EVENT = "grove://chat-tool";
export const CHAT_DONE_EVENT = "grove://chat-done";
export const CHAT_ERROR_EVENT = "grove://chat-error";

/** The stored chat settings (provider, endpoint, model, limits, egress consent). */
export function chatSettings(): Promise<ChatSettings> {
  return invokeCommand<ChatSettings>("chat_settings");
}

/** Replaces the settings and returns the stored value. */
export function setChatSettings(settings: ChatSettings): Promise<ChatSettings> {
  return invokeCommand<ChatSettings>("set_chat_settings", { settings });
}

/** Whether a key is resolvable for this provider (env, then Keychain). */
export function chatKeyStatus(provider: string): Promise<boolean> {
  return invokeCommand<boolean>("chat_key_status", { provider });
}

/** Stores a key in the Keychain. The key is never returned or logged. */
export function setChatKey(provider: string, key: string): Promise<void> {
  return invokeCommand<void>("set_chat_key", { provider, key });
}

/** Removes the stored Keychain key for this provider. */
export function clearChatKey(provider: string): Promise<void> {
  return invokeCommand<void>("clear_chat_key", { provider });
}

/** The persisted transcript, oldest first. */
export function chatHistory(): Promise<ChatMessage[]> {
  return invokeCommand<ChatMessage[]>("chat_history");
}

/** Starts a turn; the answer arrives through the chat events. */
export function chatSend(request: ChatSendRequest): Promise<void> {
  return invokeCommand<void>("chat_send", { request });
}

/** Cancels an in-flight turn. */
export function chatCancel(turnId: string): Promise<void> {
  return invokeCommand<void>("chat_cancel", { turnId });
}

/** Deletes the persisted transcript. */
export function chatClear(): Promise<void> {
  return invokeCommand<void>("chat_clear");
}

/** Exactly what the turn would send, measured without sending it. */
export function chatPreview(request: ChatSendRequest): Promise<ChatPreview> {
  return invokeCommand<ChatPreview>("chat_preview", { request });
}

/** Tokens spent this session and this month. */
export function chatUsage(): Promise<ChatUsage> {
  return invokeCommand<ChatUsage>("chat_usage");
}

/** Whether the `claude` / `codex` CLI is installed, and its version. */
export function chatCliStatus(command: ChatCliCommand): Promise<ChatCliStatus> {
  return invokeCommand<ChatCliStatus>("chat_cli_status", { command });
}

export async function listenForChatEgress(
  onEvent: (event: ChatEgressEvent) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ChatEgressEvent>(CHAT_EGRESS_EVENT, (event) => onEvent(event.payload));
  } catch (error) {
    throw toError(error);
  }
}

export async function listenForChatDelta(
  onEvent: (event: ChatDeltaEvent) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ChatDeltaEvent>(CHAT_DELTA_EVENT, (event) => onEvent(event.payload));
  } catch (error) {
    throw toError(error);
  }
}

export async function listenForChatReasoning(
  onEvent: (event: ChatReasoningEvent) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ChatReasoningEvent>(CHAT_REASONING_EVENT, (event) =>
      onEvent(event.payload),
    );
  } catch (error) {
    throw toError(error);
  }
}

export async function listenForChatTool(
  onEvent: (event: ChatToolEvent) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ChatToolEvent>(CHAT_TOOL_EVENT, (event) => onEvent(event.payload));
  } catch (error) {
    throw toError(error);
  }
}

export async function listenForChatDone(
  onEvent: (event: ChatDoneEvent) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ChatDoneEvent>(CHAT_DONE_EVENT, (event) => onEvent(event.payload));
  } catch (error) {
    throw toError(error);
  }
}

export async function listenForChatError(
  onEvent: (event: ChatErrorEvent) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<ChatErrorEvent>(CHAT_ERROR_EVENT, (event) => onEvent(event.payload));
  } catch (error) {
    throw toError(error);
  }
}
