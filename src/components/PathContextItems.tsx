import { ContextMenuItem } from "@/components/ui/context-menu";
import { runPathAction } from "@/lib/path-actions";

interface PathContextItemsProps {
  path: string;
  onRemove?: () => void;
}

export function PathContextItems({ path, onRemove }: PathContextItemsProps) {
  return (
    <>
      <ContextMenuItem onClick={() => void runPathAction("reveal", path)}>
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void runPathAction("open", path)}>Open</ContextMenuItem>
      <ContextMenuItem onClick={() => void runPathAction("copy", path)}>Copy path</ContextMenuItem>
      {onRemove !== undefined ? (
        <ContextMenuItem variant="destructive" onClick={onRemove}>
          Remove
        </ContextMenuItem>
      ) : null}
    </>
  );
}
