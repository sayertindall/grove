import { useQueryClient } from "@tanstack/react-query";
import { FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { listenForProjectsChanged, setProjects } from "@/api/grove";
import { ChangesTree } from "@/components/ChangesTree";
import { DiffViewer } from "@/components/DiffViewer";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  segmentedControlItemVariants,
  segmentedControlRootClassName,
} from "@/lib/segmented-control";
import { invalidateAllProjects, invalidateWatchedProjects, useDiff, useProjects } from "@/queries";

export default function App() {
  const queryClient = useQueryClient();
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [themeType, setThemeType] = useState<"dark" | "light">("dark");
  const [addRequest, setAddRequest] = useState(0);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  const projects = useProjects();
  const projectList = projects.data ?? [];
  const diff = useDiff(selectedProjectPath);
  const files = diff.data?.files ?? [];

  // One subscription for the app's lifetime. The watcher is the only thing that
  // refetches, and it refetches only what changed.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;

    void listenForProjectsChanged((event) => {
      invalidateWatchedProjects(queryClient, event.paths);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      stop = unlisten;
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

  // The selected project must exist in the list; otherwise the first one is selected.
  useEffect(() => {
    if (!projects.isSuccess) {
      return;
    }
    if (!projectList.some((project) => project.path === selectedProjectPath)) {
      setSelectedProjectPath(projectList[0]?.path ?? null);
    }
  }, [projects.isSuccess, projectList, selectedProjectPath]);

  // The selected file must exist in the diff; otherwise nothing is selected.
  useEffect(() => {
    if (!diff.isSuccess) {
      return;
    }
    if (!files.some((file) => file.path === selectedChangePath)) {
      setSelectedChangePath(null);
    }
  }, [diff.isSuccess, files, selectedChangePath]);

  const replaceProjects = async (paths: string[]) => {
    setReplaceError(null);
    try {
      await setProjects(paths);
      invalidateAllProjects(queryClient);
    } catch (error) {
      setReplaceError(String(error));
    }
  };

  const selectedProject =
    projectList.find((project) => project.path === selectedProjectPath) ?? null;
  const selectedChange = files.find((file) => file.path === selectedChangePath) ?? null;
  const errorMessage = projects.error?.message ?? replaceError ?? diff.error?.message ?? null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* The window uses an overlay title bar, so the header starts clear of the
          macOS traffic lights and doubles as the drag region. */}
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
            className={segmentedControlRootClassName}
            value={[themeType]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "dark" || next === "light") {
                setThemeType(next);
              }
            }}
          >
            <ToggleGroupItem
              value="dark"
              className={segmentedControlItemVariants({
                size: "sm",
                state: "pressed",
              })}
            >
              Dark
            </ToggleGroupItem>
            <ToggleGroupItem
              value="light"
              className={segmentedControlItemVariants({
                size: "sm",
                state: "pressed",
              })}
            >
              Light
            </ToggleGroupItem>
          </ToggleGroup>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <ProjectSidebar
          projects={projectList}
          selectedPath={selectedProjectPath}
          errorMessage={errorMessage}
          addRequest={addRequest}
          onSelectProject={setSelectedProjectPath}
          onRemoveProject={(path) =>
            void replaceProjects(
              projectList.map((project) => project.path).filter((entry) => entry !== path),
            )
          }
          onReplaceProjects={(paths) => void replaceProjects(paths)}
        />

        {projectList.length === 0 ? (
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
        ) : (
          <>
            <ChangesTree
              title={selectedProject?.displayName ?? ""}
              changes={files}
              selectedPath={selectedChangePath}
              themeType={themeType}
              onSelectChange={setSelectedChangePath}
            />
            <DiffViewer
              change={selectedChange}
              errorMessage={diff.error?.message ?? null}
              themeType={themeType}
            />
          </>
        )}
      </div>
    </div>
  );
}
