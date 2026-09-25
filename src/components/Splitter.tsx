import { useRef } from "react";

interface SplitterProps {
  label: string;
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

export function Splitter({ label, onResize, onResizeEnd }: SplitterProps) {
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="relative w-px shrink-0 cursor-col-resize bg-border before:absolute before:inset-y-0 before:-left-1 before:w-2"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        let last = event.clientX;
        const previousCursor = document.body.style.cursor;
        const previousSelect = document.body.style.userSelect;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        const onMove = (move: PointerEvent) => {
          const delta = move.clientX - last;
          last = move.clientX;
          if (delta !== 0) onResizeRef.current(delta);
        };
        const onUp = () => {
          document.body.style.cursor = previousCursor;
          document.body.style.userSelect = previousSelect;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          onResizeEndRef.current?.();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
    />
  );
}
