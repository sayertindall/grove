import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { getGlobalShortcut, setGlobalShortcut } from "@/api/app";
import { toError } from "@/api/invoke";
import { Keycaps } from "@/components/Keycaps";
import { ReadOnlyPromises } from "@/components/ReadOnlyPromises";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import type { UpdateCheck, UpdateState } from "@/hooks/useUpdateCheck";
import { COMMAND_SPECS, PROJECT_SLOT_IDS } from "@/lib/commands";
import type { ThemePreference } from "@/lib/storage";
import { cn } from "@/lib/utils";

type SettingsSection = "general" | "assistant" | "keyboard" | "about";

const THEME_OPTIONS: SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const DEFAULT_GLOBAL_SHORTCUT = "CmdOrCtrl+Shift+G";

export interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themePreference: ThemePreference;
  onThemeChange: (value: ThemePreference) => void;
  updates: UpdateCheck;
  /** The assistant's own settings (providers, privacy, caps); the section hides without it. */
  assistantSettings?: ReactNode;
}

/** Grove › Settings… and ⌘,: app-level preferences in one window-sized sheet. */
export function SettingsPanel({
  open,
  onOpenChange,
  themePreference,
  onThemeChange,
  updates,
  assistantSettings,
}: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>("general");
  const sections: { value: SettingsSection; label: string }[] = [
    { value: "general", label: "General" },
    ...(assistantSettings === undefined
      ? []
      : [{ value: "assistant" as const, label: "Assistant" }]),
    { value: "keyboard", label: "Keyboard" },
    { value: "about", label: "About" },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Popup
          className="fixed inset-x-0 top-11 bottom-0 z-50 flex bg-background text-foreground outline-none"
          aria-label="Settings"
        >
          <nav
            aria-label="Settings sections"
            className="flex w-55 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2 py-4"
          >
            <Dialog.Title className="px-2.5 pb-3 text-sm font-semibold">Settings</Dialog.Title>
            {sections.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-current={entry.value === section ? "page" : undefined}
                onClick={() => setSection(entry.value)}
                className={cn(
                  "h-8 rounded-md px-2.5 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  entry.value === section && "bg-sidebar-accent text-foreground",
                )}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto px-12 py-10">
            <div className="flex max-w-150 flex-col gap-8">
              {section === "general" && (
                <GeneralSection
                  themePreference={themePreference}
                  onThemeChange={onThemeChange}
                  updates={updates}
                />
              )}
              {section === "assistant" && assistantSettings}
              {section === "keyboard" && <KeyboardSection />}
              {section === "about" && <AboutSection />}
            </div>
          </div>
          <Dialog.Close
            render={<Button size="icon-sm" variant="ghost" />}
            aria-label="Close settings"
            className="absolute top-3 right-4"
          >
            <XIcon />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3
        id={headingId}
        className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-sm">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function GeneralSection({
  themePreference,
  onThemeChange,
  updates,
}: {
  themePreference: ThemePreference;
  onThemeChange: (value: ThemePreference) => void;
  updates: UpdateCheck;
}) {
  const busy = updates.state.phase === "checking" || updates.state.phase === "installing";
  return (
    <>
      <h2 className="text-xl font-semibold">General</h2>
      <SettingsGroup title="Appearance">
        <SettingRow label="Theme" description="System follows macOS light and dark mode.">
          <SegmentedControl
            aria-label="Theme"
            value={themePreference}
            options={THEME_OPTIONS}
            onValueChange={onThemeChange}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Updates">
        <SettingRow
          label="Stable channel"
          description="Signed releases only. Grove checks when you ask and never in the background."
        >
          {updates.state.phase === "available" ? (
            <Button size="sm" onClick={updates.install}>
              Install {updates.state.update.version}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={updates.check}>
              {busy && <Spinner className="size-3.5" />}
              Check for Updates
            </Button>
          )}
        </SettingRow>
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {updateStatusText(updates.state)}
        </p>
      </SettingsGroup>
    </>
  );
}

function updateStatusText(state: UpdateState): string {
  switch (state.phase) {
    case "idle":
      return "";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Grove is up to date.";
    case "available":
      return `Grove ${state.update.version} is available (you have ${state.update.currentVersion}).`;
    case "installing":
      return `Installing Grove ${state.update.version}; Grove relaunches when it finishes.`;
    case "failed":
      return `Update check failed: ${state.message}`;
  }
}

function KeyboardSection() {
  const bound = COMMAND_SPECS.filter(
    (spec) => spec.shortcut !== undefined && !PROJECT_SLOT_IDS.includes(spec.id),
  );
  return (
    <>
      <h2 className="text-xl font-semibold">Keyboard</h2>
      <SettingsGroup title="Global shortcut">
        <GlobalShortcutRecorder />
      </SettingsGroup>
      <SettingsGroup title="In Grove">
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          {bound.map((spec) => (
            <div key={spec.id} className="contents">
              <dt className="text-muted-foreground">{spec.title}</dt>
              <dd>
                <Keycaps shortcut={spec.shortcut ?? ""} />
              </dd>
            </div>
          ))}
          <div className="contents">
            <dt className="text-muted-foreground">Project 1 to 9, in sidebar order</dt>
            <dd>
              <Keycaps shortcut="Mod+1…9" />
            </dd>
          </div>
        </dl>
      </SettingsGroup>
    </>
  );
}

function AboutSection() {
  const headingId = useId();
  return (
    <>
      <h2 className="text-xl font-semibold">About</h2>
      <p className="text-sm text-muted-foreground">
        Grove is a read-only viewer of uncommitted changes across your repositories.
      </p>
      <section className="flex flex-col gap-3">
        <h3
          id={headingId}
          className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
        >
          What Grove never does
        </h3>
        <ReadOnlyPromises headingId={headingId} />
      </section>
    </>
  );
}

const MODIFIER_KEYS = ["Meta", "Control", "Alt", "Shift"];

/** `event.code` → accelerator key, for the keys a global shortcut may use. */
function acceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named = ["Space", "Comma", "Period", "Slash", "Backslash", "Semicolon", "Quote"];
  return named.includes(code) || code.startsWith("Bracket") ? code : null;
}

/** A keydown as a Tauri accelerator, or why it cannot be one. */
export function readAccelerator(event: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): { accelerator: string } | { problem: string } {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    return { problem: "Include ⌘, ⌃, or ⌥ so the shortcut can't fire while you type." };
  }
  const key = acceleratorKey(event.code);
  if (key === null) return { problem: "That key can't be part of a global shortcut." };
  const parts = [
    event.metaKey && "CmdOrCtrl",
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ];
  return { accelerator: parts.filter(Boolean).join("+") };
}

/** Keycaps notation for a stored accelerator: `CmdOrCtrl+Shift+G` → `Mod+Shift+G`. */
function displayAccelerator(accelerator: string): string {
  return accelerator
    .replace(/^(CmdOrCtrl|CommandOrControl|Cmd|Command|Super)\b/, "Mod")
    .replace(/\bOption\b/, "Alt");
}

function GlobalShortcutRecorder() {
  const [current, setCurrent] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();

  useEffect(() => {
    getGlobalShortcut()
      .then(setCurrent)
      .catch((error: unknown) => setProblem(toError(error).message));
  }, []);

  const save = (accelerator: string) => {
    setSaving(true);
    setGlobalShortcut(accelerator)
      .then((stored) => {
        setCurrent(stored);
        setProblem(null);
      })
      .catch((error: unknown) => setProblem(toError(error).message))
      .finally(() => setSaving(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    if (MODIFIER_KEYS.includes(event.key)) return;
    setRecording(false);
    const read = readAccelerator(event);
    if ("problem" in read) setProblem(read.problem);
    else save(read.accelerator);
  };

  return (
    <div className="flex flex-col gap-2">
      <SettingRow
        label="Bring Grove forward"
        description="Works from any app. Press the new keys while recording; Esc cancels."
      >
        {current !== null && !recording && <Keycaps shortcut={displayAccelerator(current)} />}
        <Button
          size="sm"
          variant={recording ? "default" : "outline"}
          aria-pressed={recording}
          aria-describedby={problem === null ? undefined : problemId}
          disabled={saving}
          onClick={() => {
            setProblem(null);
            setRecording((value) => !value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
        >
          {saving && <Spinner className="size-3.5" />}
          {recording ? "Press keys…" : "Record"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving || current === DEFAULT_GLOBAL_SHORTCUT}
          onClick={() => save(DEFAULT_GLOBAL_SHORTCUT)}
        >
          Reset
        </Button>
      </SettingRow>
      {problem !== null && (
        <p id={problemId} role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </div>
  );
}
