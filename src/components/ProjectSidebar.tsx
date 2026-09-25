import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUpDownIcon, FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { scanForRepos, toError } from "@/api/grove";
import { PathContextItems } from "@/components/PathContextItems";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { buttonVariants } from "@/components/ui/button";
import {
  branchLabel,
  commonParent,
  disambiguatingPath,
  pathName,
  projectTitle,
  visibleProjects,
} from "@/lib/projects";
import type { ProjectSort } from "@/lib/storage";
import { cn } from "@/lib/utils";
import type { ProjectState, ProjectStatus } from "@/types/grove";

const STATE_DOT: Record<ProjectState, string> = {
  clean: "bg-muted-foreground/40",
  dirty: "bg-warning",
  missing: "bg-destructive",
  unreadable: "bg-destructive",
};

const SORT_LABEL: Record<ProjectSort, string> = {
  stored: "Stored order",
  dirty: "Dirty first",
  name: "Name",
};

interface ProjectSidebarProps {
  projects: ProjectStatus[];
  isPending: boolean;
  listError: string | null;
  mutationError: string | null;
  selectedPath: string | null;
  addRequest: number;
  sort: ProjectSort;
  hideClean: boolean;
  width: number;
  onSortChange: (sort: ProjectSort) => void;
  onHideCleanChange: (hideClean: boolean) => void;
  onSelectProject: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onReplaceProjects: (paths: string[]) => void;
}

export function ProjectSidebar({
  projects,
  isPending,
  listError,
  mutationError,
  selectedPath,
  addRequest,
  sort,
  hideClean,
  width,
  onSortChange,
  onHideCleanChange,
  onSelectProject,
  onRemoveProject,
  onReplaceProjects,
}: ProjectSidebarProps) {
  const [scannedDirectory, setScannedDirectory] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [declined, setDeclined] = useState<string[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const chooseDirectory = async () => {
    setPickerError(null);
    try {
      const directory = await open({ directory: true, multiple: false });
      if (typeof directory !== "string") return;

      setScannedDirectory(directory);
      setCandidates(null);
      setDeclined([]);
      setIsScanning(true);
      try {
        setCandidates(await scanForRepos(directory));
      } catch (error) {
        setPickerError(toError(error).message);
        setCandidates([]);
      } finally {
        setIsScanning(false);
      }
    } catch (error) {
      setPickerError(toError(error).message);
    }
  };

  useEffect(() => {
    if (addRequest > 0) void chooseDirectory();
    // One picker per request; the dialog itself is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addRequest]);

  const registered = new Set(projects.map((project) => project.path));
  const addable = (candidates ?? []).filter(
    (path) => !registered.has(path) && !declined.includes(path),
  );
  const visible = visibleProjects(projects, sort, hideClean);
  const parent = commonParent(projects.map((project) => project.path));

  const moveSelection = (direction: -1 | 1) => {
    if (visible.length === 0) return;
    const index = visible.findIndex((project) => project.path === selectedPath);
    const nextIndex =
      direction > 0
        ? Math.min(visible.length - 1, index < 0 ? 0 : index + 1)
        : Math.max(0, index < 0 ? 0 : index - 1);
    const next = visible[nextIndex];
    if (next === undefined) return;
    onSelectProject(next.path);
    const row = rowRefs.current.get(next.path);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  };

  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground"
    >
      {candidates === null ? (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 px-2">
            <span className="flex-1 text-xs font-medium">Projects</span>
            <Menu>
              <MenuTrigger
                aria-label="Sort projects"
                className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
              >
                <ArrowUpDownIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  value={sort}
                  onValueChange={(value) => {
                    if (value === "stored" || value === "dirty" || value === "name") {
                      onSortChange(value);
                    }
                  }}
                >
                  {(Object.keys(SORT_LABEL) as ProjectSort[]).map((option) => (
                    <MenuRadioItem key={option} value={option}>
                      {SORT_LABEL[option]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add project"
              onClick={() => void chooseDirectory()}
            >
              <PlusIcon />
            </Button>
          </div>

          <label className="flex shrink-0 items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground">
            <Switch
              checked={hideClean}
              onCheckedChange={onHideCleanChange}
              aria-label="Hide clean"
            />
            Hide clean
          </label>

          <ScrollArea className="min-h-0 flex-1">
            {isPending ? (
              <div className="flex flex-col gap-1 px-1">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <ul
                className="flex flex-col gap-1 outline-none"
                tabIndex={0}
                aria-label="Projects"
                onKeyDown={(event) => {
                  if (event.metaKey || event.ctrlKey || event.altKey) return;
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  moveSelection(event.key === "ArrowDown" ? 1 : -1);
                }}
              >
                {visible.map((project) => (
                  <li key={project.path}>
                    <ContextMenu>
                      <ContextMenuTrigger className="block w-full">
                        <ProjectRow
                          project={project}
                          relativePath={disambiguatingPath(project.path, parent)}
                          isSelected={project.path === selectedPath}
                          onSelect={() => onSelectProject(project.path)}
                          rowRef={(node) => {
                            if (node === null) rowRefs.current.delete(project.path);
                            else rowRefs.current.set(project.path, node);
                          }}
                        />
                      </ContextMenuTrigger>
                      <ContextMenuPopup align="start">
                        <PathContextItems
                          path={project.path}
                          onRemove={() => onRemoveProject(project.path)}
                        />
                      </ContextMenuPopup>
                    </ContextMenu>
                  </li>
                ))}
                {visible.length === 0 && projects.length > 0 ? (
                  <li className="px-2 py-1 text-[11px] text-muted-foreground">No dirty projects</li>
                ) : null}
              </ul>
            )}
          </ScrollArea>

          {listError !== null ? (
            <Alert variant="error">
              <AlertTitle>Projects could not be read</AlertTitle>
              <AlertDescription className="font-mono text-xs">{listError}</AlertDescription>
            </Alert>
          ) : null}
          {mutationError !== null ? (
            <Alert variant="error">
              <AlertTitle>Projects could not be updated</AlertTitle>
              <AlertDescription className="font-mono text-xs">{mutationError}</AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : (
        <AddProjects
          scannedDirectory={scannedDirectory}
          candidates={candidates}
          registered={registered}
          declined={declined}
          isScanning={isScanning}
          pickerError={pickerError}
          addableCount={addable.length}
          onDecline={(path, decline) =>
            setDeclined((current) =>
              decline ? [...current, path] : current.filter((entry) => entry !== path),
            )
          }
          onCancel={() => setCandidates(null)}
          onChooseAnother={() => void chooseDirectory()}
          onConfirm={() => {
            onReplaceProjects([...projects.map((project) => project.path), ...addable]);
            setCandidates(null);
            setScannedDirectory(null);
          }}
        />
      )}
    </aside>
  );
}

interface AddProjectsProps {
  scannedDirectory: string | null;
  candidates: string[];
  registered: Set<string>;
  declined: string[];
  isScanning: boolean;
  pickerError: string | null;
  addableCount: number;
  onDecline: (path: string, decline: boolean) => void;
  onCancel: () => void;
  onChooseAnother: () => void;
  onConfirm: () => void;
}

function AddProjects({
  scannedDirectory,
  candidates,
  registered,
  declined,
  isScanning,
  pickerError,
  addableCount,
  onDecline,
  onCancel,
  onChooseAnother,
  onConfirm,
}: AddProjectsProps) {
  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <span className="flex-1 text-xs font-medium">Add projects</span>
        <Button variant="ghost" size="icon-xs" aria-label="Cancel" onClick={onCancel}>
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
              const alreadyAdded = registered.has(path);
              const isChecked = alreadyAdded || !declined.includes(path);
              return (
                <li key={path}>
                  <label
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg p-2",
                      alreadyAdded ? "opacity-64" : "cursor-pointer hover:bg-sidebar-accent",
                    )}
                  >
                    <Checkbox
                      checked={isChecked}
                      disabled={alreadyAdded}
                      onCheckedChange={() => onDecline(path, isChecked)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-sidebar-accent-foreground">
                        {pathName(path)}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {alreadyAdded ? "already added" : path}
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
        <Button className="w-full" onClick={onChooseAnother}>
          Choose another directory
        </Button>
      ) : (
        <Button className="w-full" disabled={addableCount === 0} onClick={onConfirm}>
          {addableCount === 1 ? "Add 1 project" : `Add ${addableCount} projects`}
        </Button>
      )}
    </>
  );
}

interface ProjectRowProps {
  project: ProjectStatus;
  relativePath: string | null;
  isSelected: boolean;
  onSelect: () => void;
  rowRef: (node: HTMLButtonElement | null) => void;
}

function ProjectRow({ project, relativePath, isSelected, onSelect, rowRef }: ProjectRowProps) {
  const label = branchLabel(project);
  const broken = project.state === "missing" || project.state === "unreadable";
  const ahead = project.branch?.ahead ?? 0;
  const behind = project.branch?.behind ?? 0;

  return (
    <button
      ref={rowRef}
      type="button"
      title={projectTitle(project)}
      aria-current={isSelected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg p-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
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
          <span className="font-mono text-[11px] text-success-foreground">+{project.additions}</span>
        ) : null}
        {project.deletions > 0 ? (
          <span className="font-mono text-[11px] text-destructive-foreground">
            −{project.deletions}
          </span>
        ) : null}
      </span>

      <span className="flex w-full min-w-0 items-center gap-1.5 truncate text-[11px] text-muted-foreground">
        {relativePath !== null ? <span className="truncate">{relativePath}</span> : null}
        {label !== null ? <span className="truncate">{label}</span> : null}
        {ahead > 0 ? <span className="shrink-0">↑{ahead}</span> : null}
        {behind > 0 ? <span className="shrink-0">↓{behind}</span> : null}
        {project.worktreeOf !== null ? (
          <span className="truncate">worktree of {pathName(project.worktreeOf)}</span>
        ) : null}
        {!project.watching ? <span className="shrink-0">not watching</span> : null}
        {broken ? <span className="shrink-0 text-destructive">{project.state}</span> : null}
      </span>
    </button>
  );
}
