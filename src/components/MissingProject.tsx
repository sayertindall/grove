import { open } from "@tauri-apps/plugin-dialog";
import { FolderIcon } from "lucide-react";
import { useState } from "react";

import { toError } from "@/api/invoke";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { ProjectStatus } from "@/types/grove";

interface MissingProjectProps {
  project: ProjectStatus;
  onRemove: () => void;
  onLocate: (path: string) => void;
}

export function MissingProject({ project, onRemove, onLocate }: MissingProjectProps) {
  const [pickerError, setPickerError] = useState<string | null>(null);
  const title = project.state === "missing" ? "Project is missing" : "Project is unreadable";

  const locate = async () => {
    setPickerError(null);
    try {
      const directory = await open({ directory: true, multiple: false });
      if (typeof directory === "string") onLocate(directory);
    } catch (error) {
      setPickerError(toError(error).message);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyMedia variant="icon">
          <FolderIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>
            <span className="block font-mono">{project.path}</span>
            {project.reason !== null ? <span className="mt-1 block">{project.reason}</span> : null}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onRemove}>
              Remove
            </Button>
            <Button onClick={() => void locate()}>Locate…</Button>
          </div>
          {pickerError !== null ? (
            <Alert variant="error">
              <AlertTitle>That directory could not be opened</AlertTitle>
              <AlertDescription className="font-mono text-xs">{pickerError}</AlertDescription>
            </Alert>
          ) : null}
        </EmptyContent>
      </Empty>
    </main>
  );
}
