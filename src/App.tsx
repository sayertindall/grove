import { useQueryClient } from "@tanstack/react-query";
import { FolderIcon, MessageSquareText, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listenForNavigate, takePendingNavigation } from "@/api/app";
import { listenForProjectsChanged, setProjects } from "@/api/grove";
import { toError } from "@/api/invoke";
import {
  ChangeStream,
  type ChangeStreamCommands,
  type StreamScrollRequest,
} from "@/components/ChangeStream";
import { ChangesTree } from "@/components/ChangesTree";
import ChatPanel, { type LineRange } from "@/components/chat/ChatPanel";
import { CommandPalette, type PaletteScope } from "@/components/CommandPalette";
import {
  DiffViewer,
  type DiffHighlightRange,
  type DiffViewerHandle,
} from "@/components/DiffViewer";
import { FirstRun } from "@/components/FirstRun";
import { MissingProject } from "@/components/MissingProject";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Splitter } from "@/components/Splitter";
import { StreamFileList } from "@/components/StreamFileList";
import { TourFooter, TourRail, TourStepBar } from "@/components/TourRail";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { ToastProvider, toastManager } from "@/components/ui/toast";
import { UpdateNotice } from "@/components/UpdateNotice";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMenuCommands } from "@/hooks/useMenuCommands";
import { useProjectsChanges, useReviewIndex, useSetViewed } from "@/hooks/useReviewState";
import { useTour } from "@/hooks/useTour";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useViewerState } from "@/hooks/useViewerState";
import {
  PROJECT_SLOT_IDS,
  buildCommands,
  type CommandHandlers,
  type CommandId,
} from "@/lib/commands";
import { runPathAction } from "@/lib/path-actions";
import { dedupePaths, isReadable, joinProjectFile, visibleProjects } from "@/lib/projects";
import {
  CHAT_WIDTH,
  SIDEBAR_WIDTH,
  TREE_WIDTH,
  type LayoutMode,
  type ThemePreference,
} from "@/lib/storage";
import { isViewed, projectRisks } from "@/lib/triage";
import {
  invalidateAllProjects,
  invalidateEverything,
  patchChangedProjects,
  projectKeys,
  useChanges,
  useFileDiff,
  useProjects,
} from "@/queries";
import type {
  ChangeSummary,
  ChatCitation,
  DiffView,
  ProjectStatus,
  RiskSignal,
} from "@/types/grove";
import type { Navigation } from "@/types/menu";

const THEME_OPTIONS: SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const LAYOUT_OPTIONS: SegmentedOption<LayoutMode>[] = [
  { value: "stream", label: "Stream" },
  { value: "file", label: "File" },
  { value: "tour", label: "Tour" },
];

/** Bare keys the focused view owns; typing in a field never triggers them. */
const BARE_KEY_COMMANDS: Record<string, CommandId> = {
  j: "navigate.previous-file",
  k: "navigate.next-file",
  v: "navigate.mark-file-viewed",
};

/** A line range to tint in the single-file view, e.g. from a citation. */
interface Highlight {
  projectPath: string;
  filePath: string;
  range: DiffHighlightRange;
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const { state, dispatch, stateRef, refs } = useViewerState();
  const {
    selectedProjectPath,
    selectedFile,
    selectionCleared,
    themePreference,
    diffStyle,
    overflow,
    ignoreWhitespace,
    sort,
    hideClean,
    sidebarWidth,
    treeWidth,
    chatOpen,
    chatWidth,
    view,
    addRequest,
    replaceError,
    layoutMode,
    streamFilter,
    sidebarOpen,
    lineDiffType,
    diffContext,
    imageMode,
    historyOpen,
  } = state;
  const { searchRef, pendingPathRef, pendingFileRef, pathsRef, visibleRef } = refs;
  const cancelChatRef = useRef<(() => void) | null>(null);
  const askAboutLinesRef = useRef<((range: LineRange) => void) | null>(null);
  const diffViewerRef = useRef<DiffViewerHandle>(null);
  const streamCommandsRef = useRef<ChangeStreamCommands | null>(null);
  const [scrollRequest, setScrollRequest] = useState<StreamScrollRequest | null>(null);
  const [streamActive, setStreamActive] = useState<{
    projectPath: string | null;
    filePath: string | null;
  }>({ projectPath: null, filePath: null });
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [paletteScope, setPaletteScope] = useState<PaletteScope | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const updates = useUpdateCheck();

  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const themeType: "dark" | "light" =
    themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;

  const projects = useProjects();
  const projectList = useMemo(() => projects.data ?? [], [projects.data]);
  pathsRef.current = projectList.map((project) => project.path);

  // Every dirty project's change list: the stream, the tour, and the sidebar's risk chips.
  const dirtyKey = projectList
    .filter((project) => project.state === "dirty")
    .map((project) => project.path)
    .join("\0");
  const dirtyPaths = useMemo(() => (dirtyKey === "" ? [] : dirtyKey.split("\0")), [dirtyKey]);
  const allChanges = useProjectsChanges(dirtyPaths, ignoreWhitespace);
  const risks = useMemo(
    () =>
      new Map<string, RiskSignal[]>(
        dirtyPaths.map((path) => [path, projectRisks(allChanges.get(path)?.files ?? [])]),
      ),
    [dirtyPaths, allChanges],
  );
  const reviewIndex = useReviewIndex(dirtyPaths);
  const setViewed = useSetViewed();
  const toggleViewed = useCallback(
    (projectPath: string, file: ChangeSummary, viewed: boolean) =>
      setViewed({ projectPath, file, viewed }),
    [setViewed],
  );

  const visible = useMemo(
    () => visibleProjects(projectList, sort, hideClean, risks),
    [projectList, sort, hideClean, risks],
  );
  visibleRef.current = visible;
  const streamProjects = useMemo(
    () => visible.filter((project) => project.state === "dirty"),
    [visible],
  );
  const tour = useTour(streamProjects, allChanges);

  // Single-file layout: the selected project and file.
  const selectedProject =
    projectList.find((project) => project.path === selectedProjectPath) ?? null;
  const changesPath =
    selectedProject !== null && selectedProject.state === "dirty" ? selectedProject.path : null;
  const changes = useChanges(changesPath, ignoreWhitespace);
  const files = useMemo(() => changes.data?.files ?? [], [changes.data]);
  const summary = files.find((file) => file.path === selectedFile) ?? null;
  const tracked = summary?.status !== "untracked";
  const effectiveView: DiffView = tracked ? view : "head";
  const fileReady =
    layoutMode === "file" &&
    changesPath !== null &&
    selectedFile !== null &&
    (changes.isPending || summary !== null);
  const fileDiff = useFileDiff(
    fileReady ? changesPath : null,
    fileReady ? selectedFile : null,
    effectiveView,
    ignoreWhitespace,
    diffContext,
  );

  // Tour layout: the current step's file, always the head view.
  const tourStep = layoutMode === "tour" ? tour.currentStep : null;
  const tourDiff = useFileDiff(
    tourStep?.project ?? null,
    tourStep?.file.path ?? null,
    "head",
    ignoreWhitespace,
    diffContext,
  );

  const selectProject = useCallback(
    (path: string | null) => dispatch({ type: "select-project", path }),
    [dispatch],
  );
  const selectFile = useCallback(
    (path: string | null) => dispatch({ type: "select-file", path }),
    [dispatch],
  );

  /** Aims the single-file layout at one file, switching projects when needed. */
  const openProjectFile = useCallback(
    (projectPath: string, filePath: string, layout = stateRef.current.layoutMode) => {
      if (layout === "stream") {
        setScrollRequest({ projectPath, filePath, seq: Date.now() });
        return;
      }
      if (projectPath === stateRef.current.selectedProjectPath) {
        selectFile(filePath);
        return;
      }
      pendingFileRef.current = filePath;
      dispatch({ type: "begin-project-switch", path: projectPath });
    },
    [dispatch, selectFile, stateRef, pendingFileRef],
  );

  /** A sidebar pick: the stream scrolls to the project; the file layout selects it. */
  const chooseProject = useCallback(
    (path: string) => {
      selectProject(path);
      if (stateRef.current.layoutMode !== "stream") return;
      const first = allChanges.get(path)?.files[0];
      if (first !== undefined)
        setScrollRequest({ projectPath: path, filePath: first.path, seq: Date.now() });
    },
    [selectProject, stateRef, allChanges],
  );

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listenForProjectsChanged((event) => {
      void patchChangedProjects(queryClient, event.paths);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        stop = unlisten;
      })
      .catch(() => {
        // A failed subscription still leaves ⌘R and the next launch.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);

  // `grove://` links and tray rows: subscribe first, then take the launch link once.
  // A link can arrive twice (event and pending); navigating twice is harmless.
  const navigate = useCallback(
    (navigation: Navigation) => {
      if (!navigation.registered) {
        setLinkNotice(
          `A grove:// link asked for ${navigation.project}, which is not a registered project. Add it from the sidebar to view it.`,
        );
        return;
      }
      setLinkNotice(null);
      if (navigation.file !== null) {
        openProjectFile(navigation.project, navigation.file);
        if (stateRef.current.layoutMode === "stream") selectProject(navigation.project);
        return;
      }
      chooseProject(navigation.project);
    },
    [openProjectFile, chooseProject, selectProject, stateRef],
  );
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listenForNavigate((navigation) => navigateRef.current(navigation))
      .then(async (unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        stop = unlisten;
        const pending = await takePendingNavigation();
        if (!cancelled && pending !== null) navigateRef.current(pending);
      })
      .catch(() => {
        // Without the deep-link bridge the app still works; links just do not arrive.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeType === "dark");
    document.documentElement.style.colorScheme = themeType;
  }, [themeType]);

  useEffect(() => {
    if (!projects.isSuccess) return;
    if (
      pendingPathRef.current !== null &&
      !projectList.some((project) => project.path === pendingPathRef.current)
    ) {
      return;
    }
    pendingPathRef.current = null;
    if (!projectList.some((project) => project.path === selectedProjectPath)) {
      selectProject(projectList[0]?.path ?? null);
    }
  }, [projects.isSuccess, projectList, selectedProjectPath, selectProject, pendingPathRef]);

  useEffect(() => {
    dispatch({ type: "set-view", value: "head" });
    const pendingFile = pendingFileRef.current;
    if (selectedProjectPath !== null && pendingFile !== null) {
      pendingFileRef.current = null;
      selectFile(pendingFile);
      return;
    }
    selectFile(
      selectedProjectPath === null
        ? null
        : (stateRef.current.selectedFiles[selectedProjectPath] ?? null),
    );
  }, [selectedProjectPath, selectFile, dispatch, pendingFileRef, stateRef]);

  // A cited range: scroll to it once its file's diff is on screen.
  useEffect(() => {
    if (highlight === null || fileDiff.data === undefined) return;
    if (
      highlight.projectPath !== selectedProjectPath ||
      fileDiff.data.path !== highlight.filePath
    ) {
      return;
    }
    diffViewerRef.current?.scrollToLines(highlight.range.start, highlight.range.end);
  }, [highlight, fileDiff.data, selectedProjectPath]);

  /** A citation aims the single-file view at the cited file (and range, when it has one). */
  const focusCitation = (citation: ChatCitation) => {
    if (citation.filePath === null) {
      chooseProject(citation.projectPath);
      return;
    }
    if (citation.startLine !== null) {
      setHighlight({
        projectPath: citation.projectPath,
        filePath: citation.filePath,
        range: {
          start: citation.startLine,
          end: citation.endLine ?? citation.startLine,
          label: citation.label,
        },
      });
      dispatch({ type: "set-layout-mode", value: "file" });
      openProjectFile(citation.projectPath, citation.filePath, "file");
      return;
    }
    openProjectFile(citation.projectPath, citation.filePath);
  };

  const replaceProjects = async (paths: string[]): Promise<boolean> => {
    dispatch({ type: "set-replace-error", message: null });
    try {
      await setProjects(dedupePaths(paths));
      invalidateAllProjects(queryClient);
      return true;
    } catch (error) {
      dispatch({ type: "set-replace-error", message: toError(error).message });
      invalidateAllProjects(queryClient);
      return false;
    }
  };

  const removeProject = (path: string) => {
    const current = pathsRef.current;
    const index = current.indexOf(path);
    if (index === -1) return;
    const name = projectList.find((project) => project.path === path)?.displayName ?? path;
    const next = current.filter((entry) => entry !== path);
    pathsRef.current = next;
    queryClient.setQueryData<ProjectStatus[]>(projectKeys.all, (existing) =>
      existing?.filter((project) => project.path !== path),
    );
    void replaceProjects(next).then((ok) => {
      if (!ok) return;
      toastManager.add({
        title: `Removed ${name}`,
        timeout: 6000,
        actionProps: {
          children: "Undo",
          onClick: () => {
            const latest = pathsRef.current;
            if (latest.includes(path)) return;
            const restored = [...latest];
            restored.splice(Math.min(index, restored.length), 0, path);
            pathsRef.current = restored;
            pendingPathRef.current = path;
            selectProject(path);
            void replaceProjects(restored);
          },
        },
      });
    });
  };

  const locateProject = (replacement: string) => {
    if (selectedProject === null) return;
    const previous = selectedProject.path;
    pendingPathRef.current = replacement;
    selectProject(replacement);
    void replaceProjects(
      projectList.map((project) => (project.path === previous ? replacement : project.path)),
    ).then((ok) => {
      if (ok) return;
      pendingPathRef.current = null;
      selectProject(previous);
    });
  };

  const toggleChat = useCallback(() => dispatch({ type: "toggle-chat" }), [dispatch]);
  const trackStreamFile = useCallback(
    (projectPath: string | null, filePath: string | null) =>
      setStreamActive({ projectPath, filePath }),
    [],
  );

  // The file the current layout is on: what "viewed", Reveal, and the chat context mean.
  const focus: { projectPath: string | null; file: ChangeSummary | null } =
    layoutMode === "stream"
      ? {
          projectPath: streamActive.projectPath,
          file:
            allChanges
              .get(streamActive.projectPath ?? "")
              ?.files.find((file) => file.path === streamActive.filePath) ?? null,
        }
      : layoutMode === "tour"
        ? { projectPath: tourStep?.project ?? null, file: tourStep?.file ?? null }
        : { projectPath: selectedProject?.path ?? null, file: summary };

  const stepFile = (direction: 1 | -1) => {
    if (layoutMode === "stream") {
      streamCommandsRef.current?.step(direction);
      return;
    }
    if (layoutMode === "tour") {
      tour.step(direction);
      return;
    }
    const index = files.findIndex((file) => file.path === selectedFile);
    const next = files[index < 0 ? 0 : index + direction];
    if (next !== undefined) selectFile(next.path);
  };

  const toggleFocusViewed = () => {
    if (layoutMode === "stream") {
      streamCommandsRef.current?.toggleActiveViewed();
      return;
    }
    if (focus.projectPath === null || focus.file === null) return;
    toggleViewed(
      focus.projectPath,
      focus.file,
      !isViewed(reviewIndex, focus.projectPath, focus.file),
    );
  };

  const focusAbsolutePath =
    focus.projectPath === null
      ? null
      : focus.file === null
        ? focus.projectPath
        : joinProjectFile(focus.projectPath, focus.file.path);
  const handlers: CommandHandlers = {
    "grove.settings": () => setSettingsOpen(true),
    "grove.check-for-updates": updates.check,
    "file.add-projects": () => dispatch({ type: "request-add" }),
    "view.toggle-diff-layout": () =>
      dispatch({ type: "set-diff-style", value: diffStyle === "split" ? "unified" : "split" }),
    "view.toggle-wrap": () =>
      dispatch({ type: "set-overflow", value: overflow === "wrap" ? "scroll" : "wrap" }),
    "view.toggle-whitespace": () =>
      dispatch({ type: "set-ignore-whitespace", value: !ignoreWhitespace }),
    "view.theme-system": () => dispatch({ type: "set-theme", value: "system" }),
    "view.theme-light": () => dispatch({ type: "set-theme", value: "light" }),
    "view.theme-dark": () => dispatch({ type: "set-theme", value: "dark" }),
    "view.toggle-chat": toggleChat,
    "view.toggle-sidebar": () => dispatch({ type: "toggle-sidebar" }),
    "view.toggle-history": () => {
      // The history panel lives in the single-file viewer. From the stream, open the
      // focused file there with history showing; elsewhere just toggle the panel.
      if (layoutMode === "stream") {
        if (focus.projectPath === null || focus.file === null) return;
        dispatch({ type: "set-layout-mode", value: "file" });
        openProjectFile(focus.projectPath, focus.file.path, "file");
        dispatch({ type: "set-history-open", open: true });
        return;
      }
      dispatch({ type: "set-history-open", open: !historyOpen });
    },
    "view.reload": () => invalidateEverything(queryClient),
    "navigate.command-palette": () => setPaletteScope("files"),
    "navigate.go-to-project": () => setPaletteScope("repos"),
    "navigate.search-files": () => searchRef.current?.(),
    "navigate.next-file": () => stepFile(1),
    "navigate.previous-file": () => stepFile(-1),
    "navigate.mark-file-viewed": toggleFocusViewed,
  };
  if (layoutMode !== "stream") {
    handlers["navigate.next-hunk"] = () => diffViewerRef.current?.nextHunk();
    handlers["navigate.previous-hunk"] = () => diffViewerRef.current?.previousHunk();
  }
  if (focusAbsolutePath !== null) {
    handlers["file.reveal-in-finder"] = () => void runPathAction("reveal", focusAbsolutePath);
    handlers["file.open-in-editor"] = () => void runPathAction("open", focusAbsolutePath);
  }
  PROJECT_SLOT_IDS.forEach((id, index) => {
    const project = visible[index];
    if (project !== undefined) handlers[id] = () => chooseProject(project.path);
  });
  const commands = buildCommands(handlers);
  const runCommand = useMenuCommands(commands);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const meta = event.metaKey || event.ctrlKey;
      const bare = !meta && !event.altKey && !event.shiftKey;
      const bareCommand = bare ? BARE_KEY_COMMANDS[event.key] : undefined;
      if (bareCommand !== undefined && !isTyping(event.target)) {
        event.preventDefault();
        runCommand(bareCommand);
        return;
      }
      if (event.key === "Escape" && !meta && !event.altKey) {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('aside[aria-label="Chat"]')) {
          // Inside the chat rail, Escape stops a running turn instead of clearing.
          if (cancelChatRef.current !== null) {
            event.preventDefault();
            cancelChatRef.current();
          }
          return;
        }
        if (isTyping(target)) return;
        dispatch({ type: "clear-selection" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, runCommand]);

  const listError = projects.error === null ? null : toError(projects.error).message;
  const showEmpty = projects.isSuccess && projectList.length === 0;

  const diffViewerProps = {
    themeType,
    diffStyle,
    overflow,
    ignoreWhitespace,
    lineDiffType,
    diffContext,
    imageMode,
    historyOpen,
    onDiffStyleChange: (value: typeof diffStyle) => dispatch({ type: "set-diff-style", value }),
    onOverflowChange: (value: typeof overflow) => dispatch({ type: "set-overflow", value }),
    onIgnoreWhitespaceChange: (value: boolean) =>
      dispatch({ type: "set-ignore-whitespace", value }),
    onViewChange: (value: DiffView) => dispatch({ type: "set-view", value }),
    onLineDiffTypeChange: (value: typeof lineDiffType) =>
      dispatch({ type: "set-line-diff-type", value }),
    onDiffContextChange: (value: typeof diffContext) =>
      dispatch({ type: "set-diff-context", value }),
    onImageModeChange: (mode: typeof imageMode) => dispatch({ type: "set-image-mode", mode }),
    onHistoryOpenChange: (open: boolean) => dispatch({ type: "set-history-open", open }),
  };
  const askAboutLines =
    (projectPath: string, filePath: string) => (selection: { start: number; end: number }) => {
      if (!chatOpen) toggleChat();
      askAboutLinesRef.current?.({
        projectPath,
        filePath,
        startLine: selection.start,
        endLine: selection.end,
      });
    };

  const streamLayout = (
    <div className="flex min-h-0 min-w-0 flex-1">
      <StreamFileList
        projects={streamProjects}
        changes={allChanges}
        reviewIndex={reviewIndex}
        activeProject={streamActive.projectPath}
        activeFile={streamActive.filePath}
        width={treeWidth}
        onSelectFile={(projectPath, filePath) =>
          setScrollRequest({ projectPath, filePath, seq: Date.now() })
        }
      />
      <Splitter
        label="Resize files"
        ariaValueNow={treeWidth}
        ariaValueMin={TREE_WIDTH.min}
        ariaValueMax={TREE_WIDTH.max}
        onResize={(delta) => dispatch({ type: "resize-tree", delta })}
      />
      <ChangeStream
        projects={streamProjects}
        changes={allChanges}
        reviewIndex={reviewIndex}
        filter={streamFilter}
        themeType={themeType}
        diffStyle={diffStyle}
        overflow={overflow}
        lineDiffType={lineDiffType}
        ignoreWhitespace={ignoreWhitespace}
        scrollRequest={scrollRequest}
        commandsRef={streamCommandsRef}
        onFilterChange={(value) => dispatch({ type: "set-stream-filter", value })}
        onDiffStyleChange={(value) => dispatch({ type: "set-diff-style", value })}
        onToggleViewed={toggleViewed}
        onActiveFileChange={trackStreamFile}
      />
    </div>
  );

  const tourProject = streamProjects.find((project) => project.path === tourStep?.project);
  const tourLayout = (
    <div className="flex min-h-0 min-w-0 flex-1">
      <TourRail
        sections={tour.sections}
        steps={tour.steps}
        current={tour.current}
        scope={
          streamProjects.length === 1 && streamProjects[0] !== undefined
            ? [streamProjects[0].displayName, streamProjects[0].branch?.name]
                .filter(Boolean)
                .join(" · ")
            : `${streamProjects.length} repos`
        }
        width={treeWidth}
        planSource={tour.planSource}
        isViewed={(step) => isViewed(reviewIndex, step.project, step.file)}
        onSelect={tour.select}
        onResetPlan={() => tour.applyPlan(null)}
      />
      <Splitter
        label="Resize tour"
        ariaValueNow={treeWidth}
        ariaValueMin={TREE_WIDTH.min}
        ariaValueMax={TREE_WIDTH.max}
        onResize={(delta) => dispatch({ type: "resize-tree", delta })}
      />
      {tourStep !== null && tourProject !== undefined ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TourStepBar
            steps={tour.steps}
            sections={tour.sections}
            current={tour.current}
            viewed={isViewed(reviewIndex, tourStep.project, tourStep.file)}
            onToggleViewed={(viewed) => toggleViewed(tourStep.project, tourStep.file, viewed)}
          />
          <div className="flex min-h-0 flex-1">
            <DiffViewer
              ref={diffViewerRef}
              projectPath={tourStep.project}
              summary={tourStep.file}
              file={tourDiff.data ?? null}
              isPending={tourDiff.isPending}
              errorMessage={tourDiff.error === null ? null : toError(tourDiff.error).message}
              view="head"
              tracked={false}
              onAskAboutLines={askAboutLines(tourStep.project, tourStep.file.path)}
              {...diffViewerProps}
            />
          </div>
          <TourFooter
            steps={tour.steps}
            sections={tour.sections}
            current={tour.current}
            onStep={tour.step}
          />
        </div>
      ) : (
        <main className="flex min-w-0 flex-1 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing to tour</EmptyTitle>
              <EmptyDescription>Every registered project matches HEAD.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </main>
      )}
    </div>
  );

  const fileLayout =
    selectedProject !== null && !isReadable(selectedProject) ? (
      <MissingProject
        project={selectedProject}
        onRemove={() => removeProject(selectedProject.path)}
        onLocate={locateProject}
      />
    ) : selectedProject?.state === "clean" ? (
      <main className="flex min-w-0 flex-1 items-center justify-center">
        <Empty>
          <EmptyMedia variant="icon">
            <FolderIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Working tree matches HEAD</EmptyTitle>
            <EmptyDescription>
              {selectedProject.displayName} has nothing staged, unstaged, or untracked. Grove keeps
              watching, so a new edit shows up here on its own.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    ) : selectedProject !== null && changesPath !== null ? (
      <div className="flex min-h-0 min-w-0 flex-1">
        <ChangesTree
          title={selectedProject.displayName}
          projectPath={selectedProject.path}
          changes={files}
          selectedPath={selectedFile}
          isPending={changes.isPending}
          errorMessage={changes.error === null ? null : toError(changes.error).message}
          themeType={themeType}
          width={treeWidth}
          autoSelect={!selectionCleared && changes.isSuccess}
          searchRef={searchRef}
          onSelectChange={selectFile}
        />
        <Splitter
          label="Resize changes"
          ariaValueNow={treeWidth}
          ariaValueMin={TREE_WIDTH.min}
          ariaValueMax={TREE_WIDTH.max}
          onResize={(delta) => dispatch({ type: "resize-tree", delta })}
        />
        <DiffViewer
          ref={diffViewerRef}
          projectPath={selectedProject.path}
          summary={summary}
          file={fileDiff.data ?? null}
          isPending={fileReady && fileDiff.isPending}
          errorMessage={fileDiff.error === null ? null : toError(fileDiff.error).message}
          view={effectiveView}
          tracked={tracked}
          highlightRange={
            highlight !== null &&
            highlight.projectPath === selectedProject.path &&
            highlight.filePath === selectedFile
              ? highlight.range
              : null
          }
          onAskAboutLines={
            selectedFile === null ? undefined : askAboutLines(selectedProject.path, selectedFile)
          }
          {...diffViewerProps}
        />
      </div>
    ) : (
      <main className="min-w-0 flex-1" />
    );

  return (
    <ToastProvider position="bottom-center">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <a
          href="#grove-main"
          className="sr-only z-50 rounded-md bg-popover px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-20"
        >
          Skip to changes
        </a>
        <header
          data-tauri-drag-region
          className="flex h-11 shrink-0 items-center gap-3 border-b border-border pr-4 pl-20"
        >
          <span className="flex flex-1 items-center" data-tauri-drag-region>
            {showEmpty ? null : (
              <SegmentedControl
                aria-label="Layout"
                value={layoutMode}
                options={LAYOUT_OPTIONS}
                onValueChange={(value) => dispatch({ type: "set-layout-mode", value })}
              />
            )}
          </span>
          <h1
            data-tauri-drag-region
            className="text-[13px] font-medium tracking-[-0.01em] text-muted-foreground"
          >
            Grove
          </h1>
          <span className="flex flex-1 justify-end gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Toggle chat"
              aria-pressed={chatOpen}
              title="Toggle chat (⌘L)"
              onClick={toggleChat}
            >
              <MessageSquareText size={15} />
            </Button>
            <SegmentedControl
              aria-label="Theme"
              value={themePreference}
              options={THEME_OPTIONS}
              onValueChange={(value) => dispatch({ type: "set-theme", value })}
            />
          </span>
        </header>
        <UpdateNotice updates={updates} />
        {linkNotice !== null ? (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-4 py-1.5 text-xs text-warning-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{linkNotice}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setLinkNotice(null)}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}

        <div id="grove-main" tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
          {!showEmpty && sidebarOpen ? (
            <>
              <ProjectSidebar
                projects={projectList}
                visible={visible}
                risks={risks}
                isPending={projects.isPending}
                listError={listError}
                mutationError={replaceError}
                selectedPath={selectedProjectPath}
                addRequest={addRequest}
                sort={sort}
                hideClean={hideClean}
                width={sidebarWidth}
                onSortChange={(value) => dispatch({ type: "set-sort", value })}
                onHideCleanChange={(value) => dispatch({ type: "set-hide-clean", value })}
                onSelectProject={chooseProject}
                onRemoveProject={removeProject}
                onReplaceProjects={(paths) => void replaceProjects(paths)}
              />
              <Splitter
                label="Resize projects"
                ariaValueNow={sidebarWidth}
                ariaValueMin={SIDEBAR_WIDTH.min}
                ariaValueMax={SIDEBAR_WIDTH.max}
                onResize={(delta) => dispatch({ type: "resize-sidebar", delta })}
              />
            </>
          ) : null}

          {showEmpty ? (
            <FirstRun onRegister={replaceProjects} />
          ) : layoutMode === "stream" ? (
            streamLayout
          ) : layoutMode === "tour" ? (
            tourLayout
          ) : (
            fileLayout
          )}

          {chatOpen && (
            <>
              <Splitter
                label="Resize chat"
                ariaValueNow={chatWidth}
                ariaValueMin={CHAT_WIDTH.min}
                ariaValueMax={CHAT_WIDTH.max}
                onResize={(delta) => dispatch({ type: "resize-chat", delta })}
              />
              <ChatPanel
                context={{
                  projectPath: focus.projectPath,
                  filePath: focus.file?.path ?? null,
                }}
                width={chatWidth}
                cancelRef={cancelChatRef}
                askAboutLinesRef={askAboutLinesRef}
                onCitationClick={focusCitation}
                onTourPlan={(plan) => {
                  tour.applyPlan(plan);
                  dispatch({ type: "set-layout-mode", value: "tour" });
                }}
                onClose={toggleChat}
              />
            </>
          )}
        </div>
      </div>
      <CommandPalette
        open={paletteScope !== null}
        initialScope={paletteScope ?? "files"}
        onOpenChange={(open) => {
          if (!open) setPaletteScope(null);
        }}
        projects={projectList}
        ignoreWhitespace={ignoreWhitespace}
        commands={commands}
        onSelectProject={chooseProject}
        onSelectFile={openProjectFile}
      />
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        themePreference={themePreference}
        onThemeChange={(value) => dispatch({ type: "set-theme", value })}
        updates={updates}
      />
    </ToastProvider>
  );
}
