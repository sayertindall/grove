import { useRef, type KeyboardEvent } from "react";

interface SplitterProps {
  label: string;
  /** Current pane width, for the separator's aria value. */
  ariaValueNow: number;
  ariaValueMin: number;
  ariaValueMax: number;
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export function Splitter({
  label,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
  onResize,
  onResizeEnd,
}: SplitterProps) {
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let delta = 0;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") delta = -step;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") delta = step;
    else return;
    event.preventDefault();
    onResizeRef.current(delta);
    onResizeEndRef.current?.();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={ariaValueNow}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative w-px shrink-0 cursor-col-resize bg-border outline-none focus-visible:bg-ring before:absolute before:inset-y-0 before:-left-1 before:w-2"
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
