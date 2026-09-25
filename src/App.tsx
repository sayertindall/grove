import { useQueryClient } from "@tanstack/react-query";
import { FolderIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { listenForProjectsChanged, setProjects, toError } from "@/api/grove";
import { ChangesTree } from "@/components/ChangesTree";
import { DiffViewer } from "@/components/DiffViewer";
import { MissingProject } from "@/components/MissingProject";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { Splitter } from "@/components/Splitter";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ToastProvider, toastManager } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useMediaQuery } from "@/hooks/use-media-query";
import { dedupePaths, isReadable, visibleProjects } from "@/lib/projects";
import {
  segmentedControlItemVariants,
  segmentedControlRootClassName,
} from "@/lib/segmented-control";
import {
  SIDEBAR_WIDTH,
  TREE_WIDTH,
  clamp,
  readBoolean,
  readClampedNumber,
  readEnum,
  readSelectedFiles,
  readString,
  storageKeys,
  writeBoolean,
  writeEnum,
  writeNumber,
  writeSelectedFiles,
  writeString,
  type DiffOverflow,
  type DiffStyle,
  type ProjectSort,
  type ThemePreference,
} from "@/lib/storage";
import {
  invalidateAllProjects,
  invalidateEverything,
  patchChangedProjects,
  projectKeys,
  useChanges,
  useFileDiff,
  useProjects,
} from "@/queries";
import type { DiffView, ProjectStatus } from "@/types/grove";

const THEMES = ["system", "dark", "light"] as const;
const DIFF_STYLES = ["unified", "split"] as const;
const OVERFLOWS = ["wrap", "scroll"] as const;
const SORTS = ["stored", "dirty", "name"] as const;

export default function App() {
  const queryClient = useQueryClient();
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(() =>
    readString(storageKeys.selectedProject),
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectionCleared, setSelectionCleared] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(readSelectedFiles);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readEnum(storageKeys.theme, THEMES, "system"),
  );
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() =>
    readEnum(storageKeys.diffStyle, DIFF_STYLES, "unified"),
  );
  const [overflow, setOverflow] = useState<DiffOverflow>(() =>
    readEnum(storageKeys.overflow, OVERFLOWS, "scroll"),
  );
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() =>
    readBoolean(storageKeys.ignoreWhitespace, false),
  );
  const [sort, setSort] = useState<ProjectSort>(() =>
    readEnum(storageKeys.projectSort, SORTS, "stored"),
  );
  const [hideClean, setHideClean] = useState(() => readBoolean(storageKeys.hideClean, false));
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readClampedNumber(
      storageKeys.sidebarWidth,
      SIDEBAR_WIDTH.fallback,
      SIDEBAR_WIDTH.min,
      SIDEBAR_WIDTH.max,
    ),
  );
  const [treeWidth, setTreeWidth] = useState(() =>
    readClampedNumber(storageKeys.treeWidth, TREE_WIDTH.fallback, TREE_WIDTH.min, TREE_WIDTH.max),
  );
  const [view, setView] = useState<DiffView>("head");
  const [addRequest, setAddRequest] = useState(0);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  const searchRef = useRef<(() => void) | null>(null);
  const pendingPathRef = useRef<string | null>(null);
  const selectedFilesRef = useRef(selectedFiles);
  const sidebarWidthRef = useRef(sidebarWidth);
  const treeWidthRef = useRef(treeWidth);
  const pathsRef = useRef<string[]>([]);
  selectedFilesRef.current = selectedFiles;
  sidebarWidthRef.current = sidebarWidth;
  treeWidthRef.current = treeWidth;

  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const themeType: "dark" | "light" =
    themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;

  const projects = useProjects();
  const projectList = projects.data ?? [];
  pathsRef.current = projectList.map((project) => project.path);
  const selectedProject =
    projectList.find((project) => project.path === selectedProjectPath) ?? null;
  const changesPath =
    selectedProject !== null && selectedProject.state === "dirty" ? selectedProject.path : null;
  const changes = useChanges(changesPath, ignoreWhitespace);
  const files = changes.data?.files ?? [];
  const summary = files.find((file) => file.path === selectedFile) ?? null;
  const partial = summary !== null && summary.staged && summary.unstaged;
  const effectiveView: DiffView = partial ? view : "head";
  const fileReady =
    changesPath !== null && selectedFile !== null && (changes.isPending || summary !== null);
  const fileDiff = useFileDiff(
    fileReady ? changesPath : null,
    fileReady ? selectedFile : null,
    effectiveView,
    ignoreWhitespace,
  );

  const visible = useMemo(
    () => visibleProjects(projectList, sort, hideClean),
    [projectList, sort, hideClean],
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeType === "dark");
    document.documentElement.style.colorScheme = themeType;
  }, [themeType]);

  useEffect(() => {
    writeString(storageKeys.selectedProject, selectedProjectPath);
  }, [selectedProjectPath]);

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
      setSelectedProjectPath(projectList[0]?.path ?? null);
    }
  }, [projects.isSuccess, projectList, selectedProjectPath]);

  useEffect(() => {
    setSelectionCleared(false);
    setView("head");
    setSelectedFile(
      selectedProjectPath === null ? null : (selectedFilesRef.current[selectedProjectPath] ?? null),
    );
  }, [selectedProjectPath]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (meta && key === "r") {
        event.preventDefault();
        invalidateEverything(queryClient);
        return;
      }
      if (meta && key === "o") {
        event.preventDefault();
        setAddRequest((current) => current + 1);
        return;
      }
      if (meta && key === "f") {
        if (searchRef.current === null) return;
        event.preventDefault();
        searchRef.current();
        return;
      }
      if (meta && /^[1-9]$/.test(event.key)) {
        const path = visibleRef.current[Number(event.key) - 1]?.path;
        if (path === undefined) return;
        event.preventDefault();
        setSelectedProjectPath(path);
        return;
      }
      if (event.key === "Escape" && !meta && !event.altKey) {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest("input, textarea, [contenteditable='true']")
        ) {
          return;
        }
        setSelectionCleared(true);
        setSelectedFile(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queryClient]);

  const rememberFile = (path: string) => {
    if (selectedProjectPath === null) return;
    setSelectedFiles((current) => {
      if (current[selectedProjectPath] === path) return current;
      const next = { ...current, [selectedProjectPath]: path };
      writeSelectedFiles(next);
      return next;
    });
  };

  const replaceProjects = async (paths: string[]): Promise<boolean> => {
    setReplaceError(null);
    try {
      await setProjects(dedupePaths(paths));
      invalidateAllProjects(queryClient);
      return true;
    } catch (error) {
      setReplaceError(toError(error).message);
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
            setSelectedProjectPath(path);
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
    setSelectedProjectPath(replacement);
    void replaceProjects(
      projectList.map((project) => (project.path === previous ? replacement : project.path)),
    ).then((ok) => {
      if (ok) return;
      pendingPathRef.current = null;
      setSelectedProjectPath(previous);
    });
  };

  const chooseTheme = (next: string) => {
    if (next !== "system" && next !== "dark" && next !== "light") return;
    setThemePreference(next);
    writeEnum(storageKeys.theme, next);
  };

  const listError = projects.error === null ? null : toError(projects.error).message;
  const showEmpty = projects.isSuccess && projectList.length === 0;

  return (
    <ToastProvider position="bottom-center">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <header
          data-tauri-drag-region
          className="flex h-11 shrink-0 items-center gap-3 border-b border-border pr-4 pl-20"
        >
          <span className="flex-1" data-tauri-drag-region />
          <span
            data-tauri-drag-region
            className="text-[13px] font-medium tracking-[-0.01em] text-muted-foreground"
          >
            Grove
          </span>
          <span className="flex flex-1 justify-end">
            <ToggleGroup
              aria-label="Theme"
              className={segmentedControlRootClassName}
              value={[themePreference]}
              onValueChange={(value) => {
                const next = value[0];
                if (next !== undefined) chooseTheme(next);
              }}
            >
              <ThemeItem value="system">System</ThemeItem>
              <ThemeItem value="dark">Dark</ThemeItem>
              <ThemeItem value="light">Light</ThemeItem>
            </ToggleGroup>
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          <ProjectSidebar
            projects={projectList}
            isPending={projects.isPending}
            listError={listError}
            mutationError={replaceError}
            selectedPath={selectedProjectPath}
            addRequest={addRequest}
            sort={sort}
            hideClean={hideClean}
            width={sidebarWidth}
            onSortChange={(next) => {
              setSort(next);
              writeEnum(storageKeys.projectSort, next);
            }}
            onHideCleanChange={(next) => {
              setHideClean(next);
              writeBoolean(storageKeys.hideClean, next);
            }}
            onSelectProject={setSelectedProjectPath}
            onRemoveProject={removeProject}
            onReplaceProjects={(paths) => void replaceProjects(paths)}
          />
          <Splitter
            label="Resize projects"
            onResize={(delta) =>
              setSidebarWidth((current) => {
                const next = clamp(current + delta, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
                sidebarWidthRef.current = next;
                return next;
              })
            }
            onResizeEnd={() => writeNumber(storageKeys.sidebarWidth, sidebarWidthRef.current)}
          />

          {showEmpty ? (
            <main className="flex min-w-0 flex-1 items-center justify-center">
              <Empty>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>No projects yet</EmptyTitle>
                  <EmptyDescription>
                    Open a directory and Grove finds the repositories inside it.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={() => setAddRequest((current) => current + 1)}>Add project</Button>
                  <p className="text-xs text-muted-foreground">
                    Grove reads the worktree against HEAD. It never stages, commits, or pushes.
                  </p>
                </EmptyContent>
              </Empty>
            </main>
          ) : selectedProject !== null && !isReadable(selectedProject) ? (
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
                    {selectedProject.displayName} has nothing staged, unstaged, or untracked. Grove
                    keeps watching, so a new edit shows up here on its own.
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
                onSelectChange={(path) => {
                  setSelectionCleared(false);
                  setSelectedFile(path);
                  rememberFile(path);
                }}
              />
              <Splitter
                label="Resize changes"
                onResize={(delta) =>
                  setTreeWidth((current) => {
                    const next = clamp(current + delta, TREE_WIDTH.min, TREE_WIDTH.max);
                    treeWidthRef.current = next;
                    return next;
                  })
                }
                onResizeEnd={() => writeNumber(storageKeys.treeWidth, treeWidthRef.current)}
              />
              <DiffViewer
                projectPath={selectedProject.path}
                summary={summary}
                file={fileDiff.data ?? null}
                isPending={fileReady && fileDiff.isPending}
                errorMessage={fileDiff.error === null ? null : toError(fileDiff.error).message}
                themeType={themeType}
                diffStyle={diffStyle}
                overflow={overflow}
                ignoreWhitespace={ignoreWhitespace}
                view={effectiveView}
                onDiffStyleChange={(next) => {
                  setDiffStyle(next);
                  writeEnum(storageKeys.diffStyle, next);
                }}
                onOverflowChange={(next) => {
                  setOverflow(next);
                  writeEnum(storageKeys.overflow, next);
                }}
                onIgnoreWhitespaceChange={(next) => {
                  setIgnoreWhitespace(next);
                  writeBoolean(storageKeys.ignoreWhitespace, next);
                }}
                onViewChange={setView}
              />
            </div>
          ) : (
            <main className="min-w-0 flex-1" />
          )}
        </div>
      </div>
    </ToastProvider>
  );
}

function ThemeItem({ value, children }: { value: string; children: string }) {
  return (
    <ToggleGroupItem
      value={value}
      className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
    >
      {children}
    </ToggleGroupItem>
  );
}
