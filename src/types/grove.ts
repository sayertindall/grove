/**
 * The wire contract of Grove's commands and its one event. Rust does not import this
 * file; serde is the mirror (camelCase fields, lowercase enums).
 */

export type ProjectState = "clean" | "dirty" | "missing" | "unreadable";

export type FileChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

/**
 * Which comparison a file diff shows. `head` is the worktree against HEAD (staged and
 * unstaged together), `staged` is the index against HEAD, `unstaged` is the worktree
 * against the index.
 */
export type DiffView = "head" | "staged" | "unstaged";

export interface BranchInfo {
  /** Short branch name; null when HEAD is detached. */
  name: string | null;
  /** Abbreviated HEAD commit id; null in a repository without commits. */
  headShort: string | null;
  /** Short name of the upstream branch, read from local refs only. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ProjectStatus {
  path: string;
  displayName: string;
  state: ProjectState;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  additions: number;
  deletions: number;
  /** Null when the project is missing or unreadable. */
  branch: BranchInfo | null;
  /** The main worktree's path when this project is a linked worktree. */
  worktreeOf: string | null;
  /** Whether the filesystem watcher is armed on this root. */
  watching: boolean;
  /** Why a missing or unreadable project could not be read. */
  reason: string | null;
}

export interface ChangeSummary {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  /** The index differs from HEAD for this path. */
  staged: boolean;
  /** The worktree differs from the index for this path (untracked counts as unstaged). */
  unstaged: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  /** Git file modes (e.g. 0o100644); null for the absent side. */
  oldMode: number | null;
  newMode: number | null;
}

export interface ProjectChanges {
  path: string;
  files: ChangeSummary[];
}

export interface ImagePreview {
  /** `data:` URLs; null for the absent or oversized side. */
  oldDataUrl: string | null;
  newDataUrl: string | null;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  view: DiffView;
  binary: boolean;
  patch: string;
  oldContents: string | null;
  newContents: string | null;
  oldMode: number | null;
  newMode: number | null;
  /** Set for png, jpg, jpeg, gif, webp, and svg files. */
  image: ImagePreview | null;
}

export interface ProjectsChanged {
  paths: string[];
}

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

export type ChatRole = "user" | "assistant";

export type ChatToolStatus = "running" | "ok" | "error";

/** A place an answer came from. Deterministic for tool-read sources. */
export interface ChatCitation {
  projectPath: string;
  filePath: string | null;
  /** 1-based, when the source is a line range. */
  startLine: number | null;
  endLine: number | null;
  /** What to render, e.g. `dsg-platform/apps/kernel/src/case-lifecycle.ts:42`. */
  label: string;
}

export interface ChatToolRun {
  callId: string;
  name: string;
  status: ChatToolStatus;
  /** One line describing the call, e.g. `read_diff apps/kernel/src/x.ts`. */
  detail: string;
  /** Set once the tool finished successfully. */
  sources: ChatCitation[];
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Reasoning that preceded the answer, when the provider streamed it. */
  reasoning: string;
  tools: ChatToolRun[];
  citations: ChatCitation[];
  /** Provider/model that produced an assistant message. */
  model: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Set when the turn failed. */
  error: string | null;
}

export type ChatProviderKind = "openai-compatible" | "anthropic";

export interface ChatSettings {
  provider: ChatProviderKind;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number | null;
  /**
   * Explicit acknowledgement that workspace data may leave the machine for this
   * provider. A turn refuses to start while this is false for a remote host.
   */
  allowCloudEgress: boolean;
}

export interface ChatContext {
  projectPath: string | null;
  filePath: string | null;
}

export interface ChatSendRequest {
  turnId: string;
  text: string;
  context: ChatContext;
}

export interface ChatDeltaEvent {
  turnId: string;
  text: string;
}

export interface ChatReasoningEvent {
  turnId: string;
  text: string;
}

export interface ChatToolEvent {
  turnId: string;
  tool: ChatToolRun;
}

export interface ChatDoneEvent {
  turnId: string;
  messageId: string;
  text: string;
  reasoning: string;
  citations: ChatCitation[];
  model: string | null;
  /** Total tokens when the provider reported them. */
  totalTokens: number | null;
}

export interface ChatErrorEvent {
  turnId: string;
  message: string;
  retryable: boolean;
}
