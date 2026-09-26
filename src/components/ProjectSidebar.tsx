import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scanForRepos } from "@/api/grove";
import { toError } from "@/api/invoke";
import { PathContextItems } from "@/components/PathContextItems";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { RiskChips } from "@/components/RiskChips";
import { commonParent, disambiguatingPath, pathName, projectTitle } from "@/lib/projects";
import type { ProjectSort } from "@/lib/storage";
import { dirtyCount, formatAge } from "@/lib/triage";
import { cn } from "@/lib/utils";
import type { ProjectState, ProjectStatus, RiskSignal } from "@/types/grove";

const STATE_DOT: Record<ProjectState, string> = {
  // Shape carries the state as well as color: ring = clean, dot = dirty, diamond = broken.
  clean: "border border-muted-foreground/60",
  dirty: "bg-warning",
  missing: "rounded-none rotate-45 bg-destructive",
  unreadable: "rounded-none rotate-45 bg-destructive",
};

const SORT_LABEL: Record<ProjectSort, string> = {
  triage: "Triage",
  stored: "Stored order",
  dirty: "Dirty first",
  name: "Name",
};

const NO_RISKS: readonly RiskSignal[] = [];

interface ProjectSidebarProps {
  projects: ProjectStatus[];
  /** The ordered rows (clean ones last); computed once in App. */
  visible: ProjectStatus[];
  /** Distinct risk signals of each dirty project's changed files. */
  risks: ReadonlyMap<string, readonly RiskSignal[]>;
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
  visible,
  risks,
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
  const [cleanOpen, setCleanOpen] = useState(false);

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
  const parent = commonParent(projects.map((project) => project.path));
  const relativePaths = useMemo<Record<string, string | null>>(
    () =>
      Object.fromEntries(
        projects.map((project) => [project.path, disambiguatingPath(project.path, parent)]),
      ),
    [projects, parent],
  );

  const handleRowRef = useCallback((path: string, node: HTMLButtonElement | null) => {
    if (node === null) rowRefs.current.delete(path);
    else rowRefs.current.set(path, node);
  }, []);

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

  const renderRow = (project: ProjectStatus, index: number) => (
    <li key={project.path}>
      <ContextMenu>
        <ContextMenuTrigger className="block w-full">
          <ProjectRow
            project={project}
            slot={index < 9 ? index + 1 : null}
            risks={risks.get(project.path) ?? NO_RISKS}
            relativePath={relativePaths[project.path] ?? null}
            isSelected={project.path === selectedPath}
            onSelectProject={onSelectProject}
            onRowRef={handleRowRef}
          />
        </ContextMenuTrigger>
        <ContextMenuPopup align="start">
          <PathContextItems path={project.path} onRemove={() => onRemoveProject(project.path)} />
        </ContextMenuPopup>
      </ContextMenu>
    </li>
  );
  const firstClean = visible.findIndex((project) => project.state === "clean");
  const active = firstClean === -1 ? visible : visible.slice(0, firstClean);
  const clean = firstClean === -1 ? [] : visible.slice(firstClean);
  const selectedIsClean = clean.some((project) => project.path === selectedPath);
  const cleanShown = cleanOpen || selectedIsClean;
  const CleanChevron = cleanShown ? ChevronDownIcon : ChevronRightIcon;

  return (
    <aside
      aria-label="Projects"
      style={{ width }}
      className="flex h-full shrink-0 flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground"
    >
      {candidates === null ? (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 px-2">
            <h2 className="flex-1 text-sm font-semibold text-foreground">Projects</h2>
            <Menu>
              <MenuTrigger
                aria-label={`Sort projects: ${SORT_LABEL[sort]}`}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent"
              >
                {SORT_LABEL[sort]}
                <ChevronDownIcon size={12} />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  value={sort}
                  onValueChange={(value) => {
                    const option = (Object.keys(SORT_LABEL) as ProjectSort[]).find(
                      (candidate) => candidate === value,
                    );
                    if (option !== undefined) onSortChange(option);
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
                {active.map(renderRow)}
                {active.length === 0 && projects.length > 0 ? (
                  <li className="px-2 py-1 text-[11px] text-muted-foreground">No dirty projects</li>
                ) : null}
                {clean.length > 0 ? (
                  <li>
                    <button
                      type="button"
                      aria-expanded={cleanShown}
                      onClick={() => setCleanOpen(!cleanShown)}
                      className="flex w-full items-center gap-2 px-2 pt-3.5 pb-1.5 text-muted-foreground"
                    >
                      <CleanChevron size={10} className="shrink-0" />
                      <span className="text-[10px] font-semibold tracking-wide">CLEAN</span>
                      <span className="h-px flex-1 bg-border" />
                      <span className="font-mono text-[11px]">{clean.length}</span>
                    </button>
                  </li>
                ) : null}
                {cleanShown
                  ? clean.map((project, index) => renderRow(project, active.length + index))
                  : null}
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
  /** The ⌘1–⌘9 slot, for the first nine rows. */
  slot: number | null;
  risks: readonly RiskSignal[];
  relativePath: string | null;
  isSelected: boolean;
  onSelectProject: (path: string) => void;
  onRowRef: (path: string, node: HTMLButtonElement | null) => void;
}

/** `14 dirty · 12m · agent: claude`, then whatever else sets the row apart. */
function rowFacts(project: ProjectStatus, relativePath: string | null): string[] {
  const ahead = project.branch?.ahead ?? 0;
  const behind = project.branch?.behind ?? 0;
  const facts = [
    project.state === "dirty" ? `${dirtyCount(project)} dirty` : null,
    project.state === "dirty" && project.dirtyAgeSeconds !== null
      ? formatAge(project.dirtyAgeSeconds)
      : null,
    project.agent !== null ? `agent: ${project.agent}` : null,
    relativePath,
    ahead > 0 ? `↑${ahead}` : null,
    behind > 0 ? `↓${behind}` : null,
    project.worktreeOf !== null ? `worktree of ${pathName(project.worktreeOf)}` : null,
    project.watching ? null : "not watching",
  ];
  return facts.filter((fact): fact is string => fact !== null);
}

const ProjectRow = memo(function ProjectRow({
  project,
  slot,
  risks,
  relativePath,
  isSelected,
  onSelectProject,
  onRowRef,
}: ProjectRowProps) {
  const broken = project.state === "missing" || project.state === "unreadable";
  const clean = project.state === "clean";
  const facts = rowFacts(project, relativePath);

  return (
    <button
      ref={(node) => onRowRef(project.path, node)}
      type="button"
      title={projectTitle(project)}
      aria-current={isSelected ? "true" : undefined}
      onClick={() => onSelectProject(project.path)}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 rounded-lg px-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        clean ? "py-1" : "py-2",
        isSelected && "bg-sidebar-accent",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="w-3 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
          {slot ?? ""}
        </span>
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[project.state])}
        />
        <span className="sr-only">{project.state}, </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            clean ? "text-muted-foreground" : "font-medium",
            !clean && (isSelected ? "text-sidebar-accent-foreground" : "text-sidebar-foreground"),
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

      {facts.length > 0 || broken ? (
        <span className="flex w-full min-w-0 items-center gap-1.5 truncate pl-[26px] text-[11px] text-muted-foreground">
          <span className="truncate">{facts.join(" · ")}</span>
          {broken ? <span className="shrink-0 text-destructive">{project.state}</span> : null}
        </span>
      ) : null}
      {risks.length > 0 ? <RiskChips risks={risks} className="pl-[26px]" /> : null}
    </button>
  );
});
