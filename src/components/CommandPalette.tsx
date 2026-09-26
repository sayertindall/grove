import { useQueries } from "@tanstack/react-query";
import { FileIcon, FolderGit2Icon, SearchIcon } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { listChanges } from "@/api/grove";
import { Keycaps } from "@/components/Keycaps";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { AutocompleteInput } from "@/components/ui/autocomplete";
import type { GroveCommand } from "@/lib/commands";
import { fuzzyMatch, matchRuns } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { changeKeys } from "@/queries";
import type { ChangeSummary, FileChangeStatus, ProjectStatus } from "@/types/grove";

export type PaletteScope = "repos" | "files" | "actions";

const SCOPES: { value: PaletteScope; label: string; heading: string }[] = [
  { value: "repos", label: "Repos", heading: "Repositories" },
  { value: "files", label: "Files", heading: "Files" },
  { value: "actions", label: "Actions", heading: "Actions" },
];

/** Enough to scan; typing narrows faster than scrolling. */
const RESULT_LIMIT = 50;

const STATUS_MARK: Record<FileChangeStatus, { letter: string; label: string; tone: string }> = {
  modified: { letter: "M", label: "Modified", tone: "text-warning-foreground" },
  added: { letter: "A", label: "Added", tone: "text-success-foreground" },
  untracked: { letter: "U", label: "Untracked", tone: "text-success-foreground" },
  deleted: { letter: "D", label: "Deleted", tone: "text-destructive-foreground" },
  renamed: { letter: "R", label: "Renamed", tone: "text-info-foreground" },
  conflicted: { letter: "C", label: "Conflicted", tone: "text-destructive-foreground" },
  submodule: { letter: "S", label: "Submodule", tone: "text-info-foreground" },
};

interface PaletteItem {
  /** Unique id; with `label`, the shape Autocomplete reads without a converter. */
  value: string;
  label: string;
  /** Matched character positions in `label`. */
  indices: number[];
  detail: string;
  score: number;
  status?: FileChangeStatus;
  shortcut?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  /** Scope shown when the palette opens: ⌘K opens Files, ⌘P opens Repos. */
  initialScope: PaletteScope;
  onOpenChange: (open: boolean) => void;
  projects: ProjectStatus[];
  /** Keeps the per-project change lists on the same cache entries the tree reads. */
  ignoreWhitespace: boolean;
  commands: readonly GroveCommand[];
  onSelectProject: (projectPath: string) => void;
  onSelectFile: (projectPath: string, filePath: string) => void;
}

/** ⌘K: jump to a repository or changed file, or run any Grove action. */
export function CommandPalette(props: CommandPaletteProps) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="max-w-160 rounded-xl before:hidden"
      >
        <PaletteSearch {...props} />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

/** Mounted only while open, so every opening starts from an empty query. */
function PaletteSearch({
  initialScope,
  onOpenChange,
  projects,
  ignoreWhitespace,
  commands,
  onSelectProject,
  onSelectFile,
}: CommandPaletteProps) {
  const [input, setInput] = useState("");
  const [chosenScope, setChosenScope] = useState<PaletteScope>(initialScope);
  const hintId = useId();
  const changes = useProjectChanges(projects, ignoreWhitespace);

  const { scope, query } = readPrefix(input, chosenScope);
  const choose = (run: () => void) => () => {
    onOpenChange(false);
    run();
  };

  const results: Record<PaletteScope, PaletteItem[]> = {
    repos: rankRepos(projects, query, onSelectProject),
    files: rankFiles(changes, query, onSelectFile),
    actions: rankActions(commands, query),
  };
  const visible = results[scope];
  const heading = SCOPES.find((entry) => entry.value === scope)?.heading ?? "";
  const groups = visible.length === 0 ? [] : [{ value: heading, items: visible }];

  const cycleScope = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const index = SCOPES.findIndex((entry) => entry.value === scope);
    const step = event.shiftKey ? SCOPES.length - 1 : 1;
    setChosenScope(SCOPES[(index + step) % SCOPES.length]?.value ?? "files");
    setInput(query);
  };

  return (
    <Command items={groups} filter={null} value={input} onValueChange={setInput}>
      <div className="flex h-13 shrink-0 items-center gap-2.5 border-b border-border pe-4">
        <AutocompleteInput
          aria-label="Search repositories, files, and actions"
          aria-describedby={hintId}
          placeholder="Search repos, files, and actions"
          className="border-transparent! bg-transparent! text-base shadow-none before:hidden has-focus-visible:ring-0"
          size="lg"
          startAddon={<SearchIcon />}
          onKeyDown={cycleScope}
        />
        <Keycaps shortcut="Escape" />
      </div>

      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <div role="tablist" aria-label="Search scope" className="flex items-center gap-1">
          {SCOPES.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="tab"
              tabIndex={-1}
              aria-selected={entry.value === scope}
              onClick={() => {
                setChosenScope(entry.value);
                setInput(query);
              }}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground",
                entry.value === scope && "bg-input text-foreground",
              )}
            >
              {entry.label}
              <span className="font-mono text-2xs text-muted-foreground">
                {results[entry.value].length}
              </span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="text-2xs text-muted-foreground">Tab to switch scope</span>
      </div>

      <CommandEmpty className="px-4 text-sm text-muted-foreground">
        {query.trim() === ""
          ? `No ${heading.toLowerCase()} yet.`
          : `No ${heading.toLowerCase()} match “${query.trim()}”.`}
      </CommandEmpty>
      <CommandList className="max-h-90 p-1.5">
        {(group: { value: string; items: PaletteItem[] }) => (
          <CommandGroup key={group.value} items={group.items}>
            <CommandGroupLabel className="px-3 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {group.value}
            </CommandGroupLabel>
            <CommandCollection>
              {(item: PaletteItem) => (
                <PaletteRow
                  key={item.value}
                  item={item}
                  scope={scope}
                  onChoose={choose(item.run)}
                />
              )}
            </CommandCollection>
          </CommandGroup>
        )}
      </CommandList>

      <div className="flex h-9 shrink-0 items-center gap-4 rounded-b-xl border-t border-border bg-muted px-4 text-2xs text-muted-foreground">
        <span id={hintId} className="sr-only">
          Arrow keys move, Enter opens, Tab switches scope, Escape closes. Start with a greater-than
          sign for actions or an at sign for repositories.
        </span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <Keycaps shortcut="↑" />
          <Keycaps shortcut="↓" />
          navigate
        </span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <Keycaps shortcut="Enter" />
          open
        </span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <Keycaps shortcut="⇥" />
          scope
        </span>
        <span className="flex-1" />
        <span aria-hidden="true">&gt; for actions · @ for repos</span>
      </div>
    </Command>
  );
}

function PaletteRow({
  item,
  scope,
  onChoose,
}: {
  item: PaletteItem;
  scope: PaletteScope;
  onChoose: () => void;
}) {
  const mark = item.status === undefined ? null : STATUS_MARK[item.status];
  return (
    <CommandItem
      value={item}
      onClick={onChoose}
      className="group h-9 gap-2.5 rounded-md px-3 data-highlighted:bg-accent"
    >
      <span className="flex w-4 shrink-0 justify-center text-muted-foreground" aria-hidden="true">
        {scope === "files" && <FileIcon className="size-3.5" />}
        {scope === "repos" && <FolderGit2Icon className="size-3.5" />}
      </span>
      <span className="min-w-0 shrink truncate text-[13px] text-foreground">
        {matchRuns(item.label, item.indices).map((run, index) =>
          run.matched ? (
            <mark
              // Runs alternate; index is their only stable identity.
              key={index}
              className="bg-transparent font-bold text-foreground underline decoration-info decoration-1 underline-offset-2"
            >
              {run.text}
            </mark>
          ) : (
            <span key={index}>{run.text}</span>
          ),
        )}
      </span>
      {item.detail !== "" && (
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {item.detail}
        </span>
      )}
      <span className="flex-1" />
      {mark !== null && (
        <span className={cn("w-3.5 shrink-0 text-center font-mono text-2xs", mark.tone)}>
          <span aria-hidden="true">{mark.letter}</span>
          <span className="sr-only">{mark.label}</span>
        </span>
      )}
      {item.shortcut !== undefined && <Keycaps shortcut={item.shortcut} />}
      {scope !== "actions" && (
        <Keycaps shortcut="Enter" className="invisible group-data-highlighted:visible" />
      )}
    </CommandItem>
  );
}

/** `>` jumps to actions and `@` to repos, whatever tab is showing. */
function readPrefix(input: string, scope: PaletteScope): { scope: PaletteScope; query: string } {
  if (input.startsWith(">")) return { scope: "actions", query: input.slice(1) };
  if (input.startsWith("@")) return { scope: "repos", query: input.slice(1) };
  return { scope, query: input };
}

interface ProjectFiles {
  project: ProjectStatus;
  files: ChangeSummary[];
}

/** Change lists for every dirty project, through the same cache entries the tree uses. */
function useProjectChanges(projects: ProjectStatus[], ignoreWhitespace: boolean): ProjectFiles[] {
  const dirty = projects.filter((project) => project.state === "dirty");
  return useQueries({
    queries: dirty.map((project) => ({
      queryKey: changeKeys.for(project.path, ignoreWhitespace),
      queryFn: () => listChanges(project.path, ignoreWhitespace),
    })),
    combine: (results) =>
      results.flatMap((result, index) => {
        const project = dirty[index];
        return result.data === undefined || project === undefined
          ? []
          : [{ project, files: result.data.files }];
      }),
  });
}

function byScore(items: PaletteItem[]): PaletteItem[] {
  return items.sort((a, b) => b.score - a.score).slice(0, RESULT_LIMIT);
}

function rankRepos(
  projects: ProjectStatus[],
  query: string,
  onSelectProject: (path: string) => void,
): PaletteItem[] {
  return byScore(
    projects.flatMap((project) => {
      const match = fuzzyMatch(project.displayName, query);
      if (match === null) return [];
      const changed = project.stagedCount + project.unstagedCount + project.untrackedCount;
      const detail = [project.branch?.name, changed > 0 ? `${changed} changed` : project.state]
        .filter(Boolean)
        .join(" · ");
      return [
        {
          value: `repo:${project.path}`,
          label: project.displayName,
          indices: match.indices,
          detail,
          score: match.score,
          run: () => onSelectProject(project.path),
        },
      ];
    }),
  );
}

function fileItem(
  project: ProjectStatus,
  file: ChangeSummary,
  query: string,
  onSelectFile: (projectPath: string, filePath: string) => void,
): PaletteItem | null {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const directory = slash === -1 ? "" : file.path.slice(0, slash);
  const byName = fuzzyMatch(name, query);
  const byPath = byName === null ? fuzzyMatch(file.path, query) : null;
  const match = byName ?? byPath;
  if (match === null) return null;
  return {
    value: `file:${project.path}:${file.path}`,
    label: byName === null ? file.path : name,
    indices: match.indices,
    detail: [project.displayName, byName === null ? "" : directory].filter(Boolean).join(" · "),
    // A name match beats the same letters scattered through directories.
    score: byName === null ? match.score : match.score + 4,
    status: file.status,
    run: () => onSelectFile(project.path, file.path),
  };
}

function rankFiles(
  changes: ProjectFiles[],
  query: string,
  onSelectFile: (projectPath: string, filePath: string) => void,
): PaletteItem[] {
  return byScore(
    changes.flatMap(({ project, files }) =>
      files.flatMap((file) => fileItem(project, file, query, onSelectFile) ?? []),
    ),
  );
}

function rankActions(commands: readonly GroveCommand[], query: string): PaletteItem[] {
  return byScore(
    commands.flatMap((command) => {
      if (command.palette === false) return [];
      const match = fuzzyMatch(command.title, query);
      if (match === null) return [];
      return [
        {
          value: `action:${command.id}`,
          label: command.title,
          indices: match.indices,
          detail: "",
          score: match.score,
          shortcut: command.shortcut,
          run: command.run,
        },
      ];
    }),
  );
}
