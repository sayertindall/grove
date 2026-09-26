import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "./useReducedMotion";

/* ─────────────────────────────────────────────────────────
 * THINKING — expandable agent trace
 *
 * The header shows a label (shimmering while working), and
 * toggles the trace rows below it. Rows render exactly what
 * the props provide.
 * ───────────────────────────────────────────────────────── */

export type ThinkingRow = {
  primary: string;
  secondary?: string;
  mono?: boolean;
  add?: number;
  del?: number;
  href?: string;
};

function Dot({ tone }: { tone: string }) {
  return (
    <span
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-full text-white ${tone}`}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    </span>
  );
}

const TONES = ["bg-accent", "bg-orange", "bg-green"];

export default function ThinkingState({
  variant = "Steps",
  working = false,
  rows = [],
  active = "Thinking",
  done = "Done",
  query,
  icon,
  defaultOpen = false,
}: {
  /** row presentation: Steps (check/spinner), Reasoning (prose), Search (links), Coding (tool rows) */
  variant?: "Steps" | "Reasoning" | "Search" | "Coding";
  /** true while the turn is still running: shimmering label, spinner on the last row */
  working?: boolean;
  /** the trace rows */
  rows?: ThinkingRow[];
  /** header label while working */
  active?: string;
  /** header label once settled */
  done?: string;
  /** optional query line shown above the rows (Search traces) */
  query?: string;
  /** header glyph (defaults to the sparkle) */
  icon?: ReactNode;
  /** whether the trace starts expanded */
  defaultOpen?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);
  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [open, rows.length]);

  return (
    <div className="flex w-full max-w-95 flex-col">
      {/* header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1
          transition-colors duration-100 hover:bg-hover-2"
      >
        {icon ? (
          <span
            className="flex shrink-0 transition-colors duration-200"
            style={{ color: working ? "var(--ink-2)" : "var(--ink-3)" }}
          >
            {icon}
          </span>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill={working ? "var(--ink-2)" : "var(--ink-3)"}
          >
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        )}
        <span role="status" className="contents">
          {working ? (
            <span
              className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
                backgroundSize: "200% 100%",
                animation: reducedMotion ? "none" : "shimmer-text 1.4s linear infinite",
              }}
            >
              {active}
            </span>
          ) : (
            <span
              className="text-[13px] font-medium whitespace-nowrap text-ink-2"
              style={reducedMotion ? undefined : { animation: "fade-in 350ms ease-out both" }}
            >
              {done}
            </span>
          )}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* expandable trace */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
        }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -8, height: lineHeight ? lineHeight - 2 : 0 }}
            />
            <div ref={traceRef} className="flex flex-col gap-1 py-1">
              {query && (
                <div className="flex h-6 items-center gap-2 px-1.5">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ink-3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="shrink-0"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.3-4.3" />
                  </svg>
                  <span className="text-[12.5px] text-ink-2">{query}</span>
                </div>
              )}
              {rows.map((row, i) => {
                const content = (
                  <>
                    {variant === "Search" && <Dot tone={TONES[i % 3]} />}
                    {variant === "Steps" &&
                      (working && i === rows.length - 1 ? (
                        <span
                          className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                          style={{
                            animation: reducedMotion ? "none" : "spin 700ms linear infinite",
                          }}
                        />
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--ink-3)"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="shrink-0"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      ))}
                    <span
                      className={`min-w-0 truncate text-[12.5px] ${variant === "Reasoning" ? "whitespace-normal leading-relaxed text-ink-2" : "font-medium text-ink"} ${variant === "Search" ? "animated-underline" : ""}`}
                    >
                      {row.primary}
                    </span>
                    {row.secondary && (
                      <span
                        className={`shrink-0 text-[11.5px] text-ink-3 ${row.mono ? "font-mono" : ""}`}
                      >
                        {row.secondary}
                      </span>
                    )}
                    {row.add !== undefined && (
                      <span className="shrink-0 font-mono text-[11px] tabular-nums">
                        <span className="text-green">+{row.add}</span>{" "}
                        <span className="text-red">−{row.del}</span>
                      </span>
                    )}
                  </>
                );
                const rowClass =
                  "flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left";

                if (variant === "Search") {
                  return (
                    <a
                      key={row.primary}
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className={`${rowClass} transition-colors duration-150 hover:bg-hover`}
                    >
                      {content}
                    </a>
                  );
                }

                return (
                  <div key={row.primary} className={rowClass}>
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
