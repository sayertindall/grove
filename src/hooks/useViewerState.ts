import { useEffect, useReducer, useRef, type MutableRefObject } from "react";

import {
  LINE_DIFF_TYPES,
  parseDiffContextChoice,
  serializeDiffContextChoice,
  type DiffContextChoice,
  type LineDiffType,
} from "@/components/diff/diffPreferences";
import type { DiffView, ProjectStatus } from "@/types/grove";
import {
  CHAT_WIDTH,
  SIDEBAR_WIDTH,
  TREE_WIDTH,
  clamp,
  readBoolean,
  readClampedNumber,
  readEnum,
  readSelectedFiles,
  readString,
  storageKeys,
  writeString,
  type DiffOverflow,
  type DiffStyle,
  type ImageMode,
  type LayoutMode,
  type ProjectSort,
  type StreamFilter,
  type ThemePreference,
} from "@/lib/storage";

const THEMES = ["system", "dark", "light"] as const;
const DIFF_STYLES = ["unified", "split"] as const;
const OVERFLOWS = ["wrap", "scroll"] as const;
const SORTS = ["triage", "stored", "dirty", "name"] as const;
const LAYOUT_MODES = ["stream", "file", "tour"] as const;
const STREAM_FILTERS = ["all", "unviewed"] as const;
const IMAGE_MODES = ["2-up", "swipe", "onion", "difference"] as const;

export interface ViewerState {
  selectedProjectPath: string | null;
  selectedFile: string | null;
  /** Set by Escape; suppresses auto-select until the next deliberate selection. */
  selectionCleared: boolean;
  selectedFiles: Record<string, string>;
  themePreference: ThemePreference;
  diffStyle: DiffStyle;
  overflow: DiffOverflow;
  ignoreWhitespace: boolean;
  sort: ProjectSort;
  hideClean: boolean;
  sidebarWidth: number;
  treeWidth: number;
  chatOpen: boolean;
  chatWidth: number;
  view: DiffView;
  addRequest: number;
  replaceError: string | null;
  layoutMode: LayoutMode;
  streamFilter: StreamFilter;
  sidebarOpen: boolean;
  lineDiffType: LineDiffType;
  diffContext: DiffContextChoice;
  imageMode: ImageMode;
  historyOpen: boolean;
}

export type ViewerAction =
  | { type: "select-project"; path: string | null }
  | { type: "select-file"; path: string | null }
  | { type: "clear-selection" }
  | { type: "begin-project-switch"; path: string | null }
  | { type: "set-theme"; value: ThemePreference }
  | { type: "set-diff-style"; value: DiffStyle }
  | { type: "set-overflow"; value: DiffOverflow }
  | { type: "set-ignore-whitespace"; value: boolean }
  | { type: "set-sort"; value: ProjectSort }
  | { type: "set-hide-clean"; value: boolean }
  | { type: "resize-sidebar"; delta: number }
  | { type: "resize-tree"; delta: number }
  | { type: "resize-chat"; delta: number }
  | { type: "toggle-chat" }
  | { type: "set-view"; value: DiffView }
  | { type: "request-add" }
  | { type: "set-replace-error"; message: string | null }
  | { type: "set-layout-mode"; value: LayoutMode }
  | { type: "set-stream-filter"; value: StreamFilter }
  | { type: "toggle-sidebar" }
  | { type: "set-line-diff-type"; value: LineDiffType }
  | { type: "set-diff-context"; value: DiffContextChoice }
  | { type: "setImageMode"; mode: ImageMode }
  | { type: "setHistoryOpen"; open: boolean };

function initViewerState(): ViewerState {
  return {
    selectedProjectPath: readString(storageKeys.selectedProject),
    selectedFile: null,
    selectionCleared: false,
    selectedFiles: readSelectedFiles(),
    themePreference: readEnum(storageKeys.theme, THEMES, "system"),
    diffStyle: readEnum(storageKeys.diffStyle, DIFF_STYLES, "unified"),
    overflow: readEnum(storageKeys.overflow, OVERFLOWS, "scroll"),
    ignoreWhitespace: readBoolean(storageKeys.ignoreWhitespace, false),
    sort: readEnum(storageKeys.projectSort, SORTS, "triage"),
    hideClean: readBoolean(storageKeys.hideClean, false),
    sidebarWidth: readClampedNumber(
      storageKeys.sidebarWidth,
      SIDEBAR_WIDTH.fallback,
      SIDEBAR_WIDTH.min,
      SIDEBAR_WIDTH.max,
    ),
    treeWidth: readClampedNumber(
      storageKeys.treeWidth,
      TREE_WIDTH.fallback,
      TREE_WIDTH.min,
      TREE_WIDTH.max,
    ),
    chatOpen: readBoolean(storageKeys.chatOpen, false),
    chatWidth: readClampedNumber(
      storageKeys.chatWidth,
      CHAT_WIDTH.fallback,
      CHAT_WIDTH.min,
      CHAT_WIDTH.max,
    ),
    view: "head",
    addRequest: 0,
    replaceError: null,
    layoutMode: readEnum(storageKeys.layoutMode, LAYOUT_MODES, "stream"),
    streamFilter: readEnum(storageKeys.streamFilter, STREAM_FILTERS, "all"),
    sidebarOpen: readBoolean(storageKeys.sidebarOpen, true),
    lineDiffType: readEnum(storageKeys.lineDiffType, LINE_DIFF_TYPES, "word-alt"),
    diffContext: parseDiffContextChoice(readString(storageKeys.diffContext)),
    imageMode: readEnum(storageKeys.imageMode, IMAGE_MODES, "2-up"),
    historyOpen: readBoolean(storageKeys.historyOpen, false),
  };
}

function rememberFile(state: ViewerState, path: string): ViewerState["selectedFiles"] {
  const project = state.selectedProjectPath;
  if (project === null || state.selectedFiles[project] === path) return state.selectedFiles;
  return { ...state.selectedFiles, [project]: path };
}

function reducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case "select-project":
      return { ...state, selectedProjectPath: action.path };
    case "select-file":
      return {
        ...state,
        selectionCleared: false,
        selectedFile: action.path,
        selectedFiles:
          action.path === null ? state.selectedFiles : rememberFile(state, action.path),
      };
    case "clear-selection":
      return { ...state, selectionCleared: true, selectedFile: null };
    case "begin-project-switch":
      return { ...state, selectionCleared: false, view: "head", selectedProjectPath: action.path };
    case "set-theme":
      return { ...state, themePreference: action.value };
    case "set-diff-style":
      return { ...state, diffStyle: action.value };
    case "set-overflow":
      return { ...state, overflow: action.value };
    case "set-ignore-whitespace":
      return { ...state, ignoreWhitespace: action.value };
    case "set-sort":
      return { ...state, sort: action.value };
    case "set-hide-clean":
      return { ...state, hideClean: action.value };
    case "resize-sidebar":
      return {
        ...state,
        sidebarWidth: clamp(
          state.sidebarWidth + action.delta,
          SIDEBAR_WIDTH.min,
          SIDEBAR_WIDTH.max,
        ),
      };
    case "resize-tree":
      return {
        ...state,
        treeWidth: clamp(state.treeWidth + action.delta, TREE_WIDTH.min, TREE_WIDTH.max),
      };
    case "resize-chat":
      return {
        ...state,
        chatWidth: clamp(state.chatWidth - action.delta, CHAT_WIDTH.min, CHAT_WIDTH.max),
      };
    case "toggle-chat":
      return { ...state, chatOpen: !state.chatOpen };
    case "set-view":
      return { ...state, view: action.value };
    case "request-add":
      return { ...state, addRequest: state.addRequest + 1 };
    case "set-replace-error":
      return { ...state, replaceError: action.message };
    case "set-layout-mode":
      return { ...state, layoutMode: action.value };
    case "set-stream-filter":
      return { ...state, streamFilter: action.value };
    case "toggle-sidebar":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "set-line-diff-type":
      return { ...state, lineDiffType: action.value };
    case "set-diff-context":
      return { ...state, diffContext: action.value };
    case "setImageMode":
      return { ...state, imageMode: action.mode };
    case "setHistoryOpen":
      return { ...state, historyOpen: action.open };
  }
}

/** Every persisted key with its serialized value; compared key-by-key after each change. */
function persistedValues(state: ViewerState): Record<string, string | null> {
  return {
    [storageKeys.selectedProject]: state.selectedProjectPath,
    [storageKeys.selectedFiles]: JSON.stringify(state.selectedFiles),
    [storageKeys.theme]: state.themePreference,
    [storageKeys.diffStyle]: state.diffStyle,
    [storageKeys.overflow]: state.overflow,
    [storageKeys.ignoreWhitespace]: state.ignoreWhitespace ? "true" : "false",
    [storageKeys.projectSort]: state.sort,
    [storageKeys.hideClean]: state.hideClean ? "true" : "false",
    [storageKeys.sidebarWidth]: String(state.sidebarWidth),
    [storageKeys.treeWidth]: String(state.treeWidth),
    [storageKeys.chatOpen]: state.chatOpen ? "true" : "false",
    [storageKeys.chatWidth]: String(state.chatWidth),
    [storageKeys.layoutMode]: state.layoutMode,
    [storageKeys.streamFilter]: state.streamFilter,
    [storageKeys.sidebarOpen]: state.sidebarOpen ? "true" : "false",
    [storageKeys.lineDiffType]: state.lineDiffType,
    [storageKeys.diffContext]: serializeDiffContextChoice(state.diffContext),
    [storageKeys.imageMode]: state.imageMode,
    [storageKeys.historyOpen]: state.historyOpen ? "true" : "false",
  };
}

export interface ViewerRefs {
  /** Opens the change tree's search; wired by ChangesTree, triggered by ⌘F. */
  searchRef: MutableRefObject<(() => void) | null>;
  /** Project awaiting confirmation that it exists in the list before selecting. */
  pendingPathRef: MutableRefObject<string | null>;
  /** File to select once the cited project finishes loading. */
  pendingFileRef: MutableRefObject<string | null>;
  /** Latest registered project paths, for the remove/undo flow. */
  pathsRef: MutableRefObject<string[]>;
  /** Latest visible projects, for the ⌘1-⌘9 jump. */
  visibleRef: MutableRefObject<ProjectStatus[]>;
}

export function useViewerState(): {
  state: ViewerState;
  dispatch: (action: ViewerAction) => void;
  stateRef: MutableRefObject<ViewerState>;
  refs: ViewerRefs;
} {
  const [state, dispatch] = useReducer(reducer, undefined, initViewerState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refs: ViewerRefs = {
    searchRef: useRef(null),
    pendingPathRef: useRef(null),
    pendingFileRef: useRef(null),
    pathsRef: useRef<string[]>([]),
    visibleRef: useRef<ProjectStatus[]>([]),
  };

  // One persistence pass: after each change, write only the keys that differ.
  const persistedRef = useRef(persistedValues(state));
  useEffect(() => {
    const next = persistedValues(state);
    const previous = persistedRef.current;
    for (const [key, value] of Object.entries(next)) {
      if (previous[key] !== value) writeString(key, value);
    }
    persistedRef.current = next;
  }, [state]);

  return { state, dispatch, stateRef, refs };
}

export { THEMES, DIFF_STYLES, OVERFLOWS, SORTS, LAYOUT_MODES, STREAM_FILTERS, IMAGE_MODES };
