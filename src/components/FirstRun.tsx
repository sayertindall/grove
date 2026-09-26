import { open } from "@tauri-apps/plugin-dialog";
import { FolderIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { chatSettings } from "@/api/chat";
import { scanForRepos } from "@/api/grove";
import { toError } from "@/api/invoke";
import { ReadOnlyPromises } from "@/components/ReadOnlyPromises";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";

export interface FirstRunProps {
  /** Registers the chosen repositories; resolves false when the list could not be saved. */
  onRegister: (paths: string[]) => Promise<boolean>;
}

type ScanState =
  | { phase: "idle" }
  | { phase: "scanning" }
  | { phase: "found"; repositories: string[] }
  | { phase: "failed"; message: string };

/** Shown while no project is registered: pick a folder, choose repositories, and go. */
export function FirstRun({ onRegister }: FirstRunProps) {
  const headingId = useId();
  const promisesId = useId();
  const [directory, setDirectory] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanState>({ phase: "idle" });
  const [chosen, setChosen] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [cloudEgress, setCloudEgress] = useState<boolean | null>(null);

  useEffect(() => {
    chatSettings()
      .then((settings) => setCloudEgress(settings.allowCloudEgress))
      .catch(() => setCloudEgress(null));
  }, []);

  const chooseDirectory = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      setDirectory(picked);
      setScan({ phase: "idle" });
    } catch (error) {
      setScan({ phase: "failed", message: toError(error).message });
    }
  };

  const scanDirectory = async (root: string) => {
    setScan({ phase: "scanning" });
    try {
      const repositories = await scanForRepos(root);
      setScan({ phase: "found", repositories });
      setChosen(repositories);
    } catch (error) {
      setScan({ phase: "failed", message: toError(error).message });
    }
  };

  const register = async () => {
    setSaveError(null);
    const saved = await onRegister(chosen);
    if (!saved) setSaveError("Grove could not save the project list. Try again.");
  };

  return (
    <main
      aria-labelledby={headingId}
      className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-16 py-12"
    >
      <div className="grid w-full max-w-280 grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-16">
        <section className="flex flex-col gap-5">
          <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Welcome to Grove
          </p>
          <h2 id={headingId} className="text-5xl leading-[1.05] font-semibold tracking-[-0.03em]">
            Every uncommitted change, across every repo, in one place.
          </h2>
          <p className="text-base text-muted-foreground">
            Pick a folder and Grove finds the Git repositories inside it. You choose which ones to
            watch.
          </p>

          <div className="mt-4 flex h-11 items-center gap-2 rounded-lg border border-border bg-card ps-4 pe-1.5">
            <FolderIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {directory ?? <span className="text-muted-foreground">No folder chosen</span>}
            </span>
            <Button size="sm" variant="outline" onClick={() => void chooseDirectory()}>
              {directory === null ? "Choose folder…" : "Change…"}
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button
              disabled={directory === null || scan.phase === "scanning"}
              onClick={() => directory !== null && void scanDirectory(directory)}
            >
              {scan.phase === "scanning" && <Spinner className="size-3.5" />}
              {directory === null ? "Scan" : `Scan ${folderName(directory)}`}
            </Button>
            <span className="text-xs text-muted-foreground">
              Looks six levels deep and stops at each repository it finds.
            </span>
          </div>

          <ScanResult
            scan={scan}
            chosen={chosen}
            saveError={saveError}
            onChosenChange={setChosen}
            onRegister={() => void register()}
          />
        </section>

        <aside aria-labelledby={promisesId} className="flex flex-col gap-4 self-center">
          <h3
            id={promisesId}
            className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase"
          >
            What Grove will never do
          </h3>
          <ReadOnlyPromises headingId={promisesId} />
          {cloudEgress !== null && (
            <div className="mt-4 flex flex-col gap-1 rounded-lg border border-border px-4 py-3.5">
              <span className="text-sm">Cloud egress is {cloudEgress ? "on" : "off"}</span>
              <span className="text-xs text-muted-foreground">
                {cloudEgress
                  ? "The assistant may send workspace context to its cloud provider. Change it in Settings."
                  : "Nothing leaves this Mac. Turn it on in Settings when you add a cloud provider."}
              </span>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function ScanResult({
  scan,
  chosen,
  saveError,
  onChosenChange,
  onRegister,
}: {
  scan: ScanState;
  chosen: string[];
  saveError: string | null;
  onChosenChange: (paths: string[]) => void;
  onRegister: () => void;
}) {
  if (scan.phase === "failed") {
    return (
      <p role="alert" className="text-xs text-destructive-foreground">
        That folder could not be scanned: {scan.message}
      </p>
    );
  }
  if (scan.phase !== "found") return null;
  if (scan.repositories.length === 0) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        No Git repositories in that folder. Choose another one.
      </p>
    );
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="pb-2 text-sm">
        Found {scan.repositories.length}{" "}
        {scan.repositories.length === 1 ? "repository" : "repositories"}
      </legend>
      <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {scan.repositories.map((path) => (
          <li key={path}>
            <label className="flex items-center gap-2.5 font-mono text-xs">
              <Checkbox
                checked={chosen.includes(path)}
                onCheckedChange={(checked) =>
                  onChosenChange(
                    checked ? [...chosen, path] : chosen.filter((entry) => entry !== path),
                  )
                }
              />
              <span className="min-w-0 truncate">{path}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <Button disabled={chosen.length === 0} onClick={onRegister}>
          Watch {chosen.length} {chosen.length === 1 ? "repository" : "repositories"}
        </Button>
        {saveError !== null && (
          <span role="alert" className="text-xs text-destructive-foreground">
            {saveError}
          </span>
        )}
      </div>
    </fieldset>
  );
}
