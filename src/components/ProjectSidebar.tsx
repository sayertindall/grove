import { open } from "@tauri-apps/plugin-dialog";
import { FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { scanForRepos } from "@/api/grove";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ProjectState, ProjectStatus } from "@/types/grove";

const STATE_DOT: Record<ProjectState, string> = {
  clean: "bg-muted-foreground/40",
  dirty: "bg-warning",
  missing: "bg-destructive",
  unreadable: "bg-destructive",
};

const STATE_BADGE: Record<ProjectState, "success" | "warning" | "error"> = {
  clean: "success",
  dirty: "warning",
  missing: "error",
  unreadable: "error",
};

interface ProjectSidebarProps {
  projects: ProjectStatus[];
  selectedPath: string | null;
  errorMessage: string | null;
  addRequest: number;
  onSelectProject: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onReplaceProjects: (paths: string[]) => void;
}

export function ProjectSidebar({
  projects,
  selectedPath,
  errorMessage,
  addRequest,
  onSelectProject,
  onRemoveProject,
  onReplaceProjects,
}: ProjectSidebarProps) {
  const [scannedDirectory, setScannedDirectory] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [declined, setDeclined] = useState<string[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const chooseDirectory = async () => {
    setPickerError(null);
    const directory = await open({ directory: true, multiple: false });
    if (typeof directory !== "string") {
      return;
    }

    setScannedDirectory(directory);
    setCandidates(null);
    setDeclined([]);
    setIsScanning(true);
    try {
      setCandidates(await scanForRepos(directory));
    } catch (error) {
      setPickerError(String(error));
    } finally {
      setIsScanning(false);
    }
  };

  // The empty state asks the sidebar for its picker, because the dialog belongs here.
  useEffect(() => {
    if (addRequest > 0) {
      void chooseDirectory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one picker per request
  }, [addRequest]);

  const checked = (candidates ?? []).filter((path) => !declined.includes(path));

  const confirm = () => {
    onReplaceProjects([...projects.map((project) => project.path), ...checked]);
    setCandidates(null);
    setScannedDirectory(null);
  };

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
      {candidates === null ? (
        <>
          <div className="flex h-8 shrink-0 items-center gap-2 px-2">
            <span className="flex-1 text-xs font-medium">Projects</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add project"
              onClick={() => void chooseDirectory()}
            >
              <PlusIcon />
            </Button>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-1">
              {projects.map((project) => (
                <li key={project.path} className="group/row relative">
                  <ProjectRow
                    project={project}
                    isSelected={project.path === selectedPath}
                    onSelect={() => onSelectProject(project.path)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${project.displayName}`}
                    onClick={() => onRemoveProject(project.path)}
                    className="absolute top-1 right-1 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>

          {errorMessage !== null ? (
            <Alert variant="error">
              <AlertTitle>Projects could not be read</AlertTitle>
              <AlertDescription className="font-mono text-xs">{errorMessage}</AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-2 px-2">
            <span className="flex-1 text-xs font-medium">Add projects</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Cancel"
              onClick={() => setCandidates(null)}
            >
              <XIcon />
            </Button>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1 text-muted-foreground">
            <FolderIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-mono text-[11px]">{scannedDirectory}</span>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            {isScanning ? (
              <div className="flex items-center justify-center py-6">
                <Spinner />
              </div>
            ) : candidates.length === 0 ? (
              <div className="flex flex-col gap-1 px-2 py-1">
                <span className="text-[13px] font-medium text-sidebar-foreground">
                  No repositories found
                </span>
                <span className="text-[11px] leading-normal text-muted-foreground">
                  Grove searches six levels below the directory you choose.
                </span>
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {candidates.map((path) => {
                  const displayName = path.slice(path.lastIndexOf("/") + 1);
                  const isChecked = !declined.includes(path);
                  return (
                    <li key={path}>
                      <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg p-2 hover:bg-sidebar-accent">
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() =>
                            setDeclined((current) =>
                              isChecked
                                ? [...current, path]
                                : current.filter((entry) => entry !== path),
                            )
                          }
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-[13px] font-medium text-sidebar-accent-foreground">
                            {displayName}
                          </span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {path}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>

          {pickerError !== null ? (
            <Alert variant="error">
              <AlertTitle>That directory could not be scanned</AlertTitle>
              <AlertDescription className="font-mono text-xs">{pickerError}</AlertDescription>
            </Alert>
          ) : null}

          {candidates.length === 0 ? (
            <Button className="w-full" onClick={() => void chooseDirectory()}>
              Choose another directory
            </Button>
          ) : (
            <Button className="w-full" disabled={checked.length === 0} onClick={confirm}>
              {checked.length === 1 ? "Add 1 project" : `Add ${checked.length} projects`}
            </Button>
          )}
        </>
      )}
    </aside>
  );
}

interface ProjectRowProps {
  project: ProjectStatus;
  isSelected: boolean;
  onSelect: () => void;
}

function ProjectRow({ project, isSelected, onSelect }: ProjectRowProps) {
  const counts = [
    project.stagedCount > 0 ? `${project.stagedCount} staged` : null,
    project.unstagedCount > 0 ? `${project.unstagedCount} unstaged` : null,
    project.untrackedCount > 0 ? `${project.untrackedCount} untracked` : null,
  ].filter((label): label is string => label !== null);
  const directory = project.path.slice(0, project.path.lastIndexOf("/"));

  return (
    <button
      type="button"
      aria-current={isSelected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 rounded-lg p-2 pr-8 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        isSelected && "bg-sidebar-accent",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[project.state])} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] font-medium",
            isSelected ? "text-sidebar-accent-foreground" : "text-sidebar-foreground",
          )}
        >
          {project.displayName}
        </span>
        {project.additions > 0 ? (
          <span className="font-mono text-[11px] text-success-foreground">
            +{project.additions}
          </span>
        ) : null}
        {project.deletions > 0 ? (
          <span className="font-mono text-[11px] text-destructive-foreground">
            −{project.deletions}
          </span>
        ) : null}
      </span>

      <span className="w-full truncate text-[11px] text-muted-foreground">{directory}</span>

      <span className="flex w-full flex-wrap items-center gap-1.5">
        <Badge size="sm" variant={STATE_BADGE[project.state]}>
          {project.state}
        </Badge>
        {counts.length > 0 ? (
          <span className="text-[10px] text-muted-foreground">{counts.join(" · ")}</span>
        ) : null}
      </span>
    </button>
  );
}
