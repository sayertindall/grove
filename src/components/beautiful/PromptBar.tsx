import { useLayoutEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * PROMPT BAR
 * A composer with an input and a send button. Enter sends;
 * Shift+Enter inserts a newline.
 * Variants: Rounded (card radius) · Pill (full radius).
 * ───────────────────────────────────────────────────────── */

function Icon({
  children,
  size = 15,
  strokeWidth = 1.8,
}: {
  children: React.ReactNode;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export default function PromptBar({
  variant = "Rounded",
  tall = false,
  placeholder,
  onSend,
}: {
  variant?: string;
  /** hero sizing: a multi-line input with the send button on its own row */
  tall?: boolean;
  placeholder?: string;
  onSend?: (text: string) => void;
}) {
  const pill = variant === "Pill";
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const wide = expanded || tall;
  const controlsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  const canSend = draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend?.(draft.trim());
    setDraft("");
  };

  /* Move wrapped text above the controls, then grow to a compact maximum. */
  useLayoutEffect(() => {
    const input = inputRef.current;
    const controls = controlsRef.current;
    const measure = measureRef.current;
    if (!input || !controls || !measure) return;

    /* the send button is the only control left in the grid */
    const fixedControlsWidth = 28;
    const inlineGaps = 4 * 4;
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - inlineGaps;
    const needsFullWidth = draft.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== expanded) {
      setExpanded(needsFullWidth);
    }

    const minHeight = 28;
    const maxHeight = 100;
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded]);

  return (
    <div className="w-full">
      {/* composer */}
      <div
        className={`relative isolate flex flex-col overflow-hidden border border-line bg-surface shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${
          tall ? "gap-2.5 p-3.5" : "gap-1.5 p-1.5"
        } ${
          pill
            ? wide
              ? "rounded-[24px]"
              : "rounded-full"
            : tall
              ? "rounded-[22px]"
              : "rounded-[14px]"
        }`}
      >
        <span
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none absolute invisible whitespace-pre text-[13px] leading-[18px]"
        >
          {draft}
        </span>

        <div
          ref={controlsRef}
          className={`grid items-end gap-x-1 gap-y-1.5 ${
            wide ? "grid-cols-[minmax(0,1fr)_28px]" : "grid-cols-[minmax(0,1fr)_auto_28px]"
          }`}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={placeholder ?? "Write a message…"}
            aria-label="Prompt"
            className={`${tall ? "min-h-[68px] px-2 py-2 text-[14px] leading-5" : "min-h-7 px-1 py-[5px] text-[13px] leading-[18px]"} min-w-0 w-full resize-none bg-transparent text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 ${
              wide ? "col-span-full col-start-1 row-start-1" : "col-start-1 row-start-1"
            }`}
          />

          {/* send — tactile square (round in the pill variant) */}
          <button
            type="button"
            aria-label="Send"
            disabled={!canSend}
            onClick={send}
            className={`flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] ${
              pill ? "rounded-full" : "rounded-[8px]"
            } ${wide ? "col-start-2 row-start-2" : "col-start-3 row-start-1"}`}
            style={{
              background: canSend ? "var(--ink)" : "var(--line-strong)",
              color: canSend ? "var(--surface)" : "var(--ink-2)",
            }}
          >
            <Icon size={16} strokeWidth={2.4}>
              <path d="M12 19V5M5 12l7-7 7 7" />
            </Icon>
          </button>
        </div>
      </div>
    </div>
  );
}
