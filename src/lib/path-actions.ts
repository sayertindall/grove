import { copyPath, openPath, revealInFinder } from "@/api/grove";
import { toastManager } from "@/components/ui/toast";

export type PathAction = "reveal" | "open" | "copy";

const ACTION_TITLE: Record<PathAction, string> = {
  reveal: "Could not reveal that path",
  open: "Could not open that path",
  copy: "Could not copy that path",
};

export async function runPathAction(action: PathAction, path: string): Promise<void> {
  try {
    if (action === "reveal") await revealInFinder(path);
    else if (action === "open") await openPath(path);
    else await copyPath(path);
  } catch (error) {
    toastManager.add({
      title: ACTION_TITLE[action],
      description: error instanceof Error ? error.message : String(error),
      type: "error",
    });
  }
}
