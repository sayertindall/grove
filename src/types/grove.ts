/**
 * The wire contract of Grove's commands and its one event. Rust does not import this
 * file; serde is the mirror (camelCase fields, lowercase enums).
 */

export type ProjectState = "clean" | "dirty" | "missing" | "unreadable";

/**
 * `conflicted`: the index holds merge stages for the path. `submodule`: a gitlink
 * whose recorded commit moved; its contents are never read.
 */
export type FileChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "submodule";

/** The two commits a submodule entry points at (full hex); null for an absent side. */
export interface SubmodulePointer {
  oldCommit: string | null;
  newCommit: string | null;
}

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
  /** Seconds since the oldest changed worktree file was modified; null when clean. */
  dirtyAgeSeconds: number | null;
  /** The coding agent whose marker (`.claude/`, `.codex/`, `.cursor/`, …) is newest. */
  agent: string | null;
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
  /** Review signals, most severe first. */
  risk: RiskSignal[];
  /** Blob id of the worktree side; "" for a deleted file. Viewed iff a mark matches it. */
  contentHash: string;
  /** Set only for `submodule` rows. */
  submodule: SubmodulePointer | null;
}

export interface ProjectChanges {
  path: string;
  files: ChangeSummary[];
}

/** Why a changed file may need a closer look; ordered by severity, highest first. */
export type RiskSignal =
  | "secret"
  | "env"
  | "auth"
  | "migration"
  | "no-tests"
  | "large"
  | "lockfile"
  | "generated";

/** A stored "viewed" mark: the file's content hash when it was marked. */
export interface ReviewedFile {
  filePath: string;
  contentHash: string;
}

/** One file of a change tour. `project` is the canonical project path. */
export interface TourFileRef {
  project: string;
  path: string;
}

export interface TourGroup {
  title: string;
  /** One line: why these files are read at this point. */
  rationale: string;
  files: TourFileRef[];
}

/** An ordered reading plan across projects; groups in order, files in order. */
export interface TourPlan {
  groups: TourGroup[];
}

export interface ImagePreview {
  /** `data:` URLs; null for the absent or oversized side. */
  oldDataUrl: string | null;
  newDataUrl: string | null;
}

export type DiffLineKind = "context" | "add" | "del";

/** One hunk line. `text` has no trailing newline; a missing final newline shows only in `patch`. */
export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based old-side line; null on an added line. */
  oldNo: number | null;
  /** 1-based new-side line; null on a deleted line. */
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ …` line, without its newline. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/**
 * Unchanged lines around each hunk: `"default"` (3), a number from 0 to 10, or
 * `"all"` for the whole file as one hunk. Anything else is rejected by the backend.
 */
export type DiffContext = "default" | number | "all";

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  view: DiffView;
  binary: boolean;
  patch: string;
  /** The same patch, structured. Empty for binary and mode-only changes. */
  hunks: DiffHunk[];
  oldContents: string | null;
  newContents: string | null;
  oldMode: number | null;
  newMode: number | null;
  /** Set for png, jpg, jpeg, gif, webp, and svg files. */
  image: ImagePreview | null;
  /** Set only for `conflicted` files. */
  conflict: ConflictSides | null;
  /** Set only for `submodule` entries; no text sides accompany it. */
  submodule: SubmodulePointer | null;
}

/**
 * A conflicted file's index stages: base (1), ours (2), theirs (3). A side is null
 * when its stage is absent, binary, or over 512 KiB. `merged` is the in-memory
 * three-way merge with diff3 markers (`<<<<<<< ours`, `||||||| base`, `=======`,
 * `>>>>>>> theirs`), present only when every existing stage was read as text.
 */
export interface ConflictSides {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  merged: string | null;
}

/** One commit of a file history or a blame. `date` is Unix seconds. */
export interface CommitInfo {
  id: string;
  short: string;
  subject: string;
  author: string;
  date: number;
}

export interface BlameViewLine {
  /** 1-based line of the current text. */
  line: number;
  text: string;
  /** Full id of the commit that last touched the line; null when not committed yet. */
  commit: string | null;
}

/** The file's current text (first 400 lines) beside the commit behind each line. */
export interface BlameView {
  lines: BlameViewLine[];
  /** Every commit a line names, once each. */
  commits: CommitInfo[];
  /** The file has more lines than `lines` carries. */
  truncated: boolean;
}

/** The stable code of a backend failure. */
export type GroveErrorCode =
  | "not_a_repository"
  | "missing"
  | "permission_denied"
  | "outside_registered_projects"
  | "unknown_project"
  | "no_change"
  | "git"
  | "io"
  | "usage"
  | "store"
  | "chat"
  | "task";

/** What every command rejects with. `message` includes the path context. */
export interface GroveErrorPayload {
  code: GroveErrorCode;
  message: string;
  path?: string;
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
  /** Answered from the summary cache instead of the provider. */
  cached: boolean;
  /** Findings the model reported that fall inside a changed hunk. */
  findings: ChatFinding[];
  /** Findings the model reported that could not be tied to a hunk. */
  droppedFindings: number;
}

export type FindingSeverity = "P0" | "P1" | "P2";

/** A review finding anchored to new-side (worktree) lines of a changed hunk. */
export interface ChatFinding {
  projectPath: string;
  /** Repository-relative. */
  path: string;
  startLine: number;
  endLine: number;
  severity: FindingSeverity;
  title: string;
  detail: string;
}

export type ChatProviderKind = "openai-compatible" | "anthropic" | "cli";

/** The installed agent CLI a `cli` provider delegates to. */
export type ChatCliCommand = "claude" | "codex";

/** A local model server `codex --oss` can use instead of the cloud. */
export type LocalModelServer = "ollama" | "lmstudio";

/** Token caps; `null` is uncapped. */
export interface CostCaps {
  perTurnTokens: number | null;
  perSessionTokens: number | null;
  perMonthTokens: number | null;
}

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
  cliCommand: ChatCliCommand;
  cliLocalServer: LocalModelServer | null;
  /** Project paths that never reach a cloud provider. */
  neverSend: string[];
  /** Show the pre-send sheet before a turn leaves the machine. */
  previewBeforeSend: boolean;
  caps: CostCaps;
  /** Reuse the stored answer for a byte-identical request. */
  summaryCache: boolean;
}

export interface ChatUsage {
  /** `YYYY-MM`, UTC. */
  month: string;
  monthTokens: number;
  sessionTokens: number;
}

export interface ChatCliStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface ChatContext {
  projectPath: string | null;
  filePath: string | null;
  /** Files a quick action names explicitly (changed since last viewed). */
  files?: string[];
}

/** A templated turn from the quick-action row; it decides the attached snapshot. */
export type QuickAction =
  | "explain-file"
  | "explain-repo"
  | "since-last-viewed"
  | "draft-commit-message";

export interface ChatSendRequest {
  turnId: string;
  text: string;
  context: ChatContext;
  action: QuickAction | null;
}

export interface PreviewPart {
  label: string;
  bytes: number;
}

/** What the next turn's first request would carry, measured before sending. */
export interface ChatPreview {
  destination: string;
  loopback: boolean;
  provider: ChatProviderKind;
  model: string;
  /** The system prompt without the rule files, which are listed on their own. */
  systemPromptBytes: number;
  toolSchemaBytes: number;
  ruleFiles: PreviewPart[];
  ambient: PreviewPart | null;
  questionBytes: number;
  historyTurns: number;
  historyBytes: number;
  omittedTurns: number;
  hiddenProjects: number;
  totalBytes: number;
  estimatedTokens: number;
  /** Why the turn would be refused, when it would be. */
  blocked: string | null;
}

/** One request is about to leave; `sentBytes` is this turn's running total. */
export interface ChatEgressEvent {
  turnId: string;
  requestBytes: number;
  sentBytes: number;
  estimatedTokens: number;
  loopback: boolean;
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
  /** The answer as it was persisted, carrying its own id, citations and model. */
  message: ChatMessage;
  /** Total tokens when the provider reported them. */
  totalTokens: number | null;
}

export interface ChatErrorEvent {
  turnId: string;
  message: string;
  retryable: boolean;
}
