import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import {
  chatCliStatus,
  chatKeyStatus,
  chatUsage,
  clearChatKey,
  setChatKey,
  setChatSettings,
} from "@/api/chat";
import { compactCount } from "@/components/chat/Composer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  ChatCliCommand,
  ChatCliStatus,
  ChatSettings,
  ChatUsage,
  CostCaps,
  LocalModelServer,
} from "@/types/grove";

type PresetId = "anthropic" | "openai-compatible" | "ollama" | "lmstudio" | "claude" | "codex";
type Reach = "cloud" | "local" | "delegate";

interface Preset {
  id: PresetId;
  label: string;
  reach: Reach;
  /** Applies the preset over the current settings, keeping what still fits. */
  apply: (current: ChatSettings) => ChatSettings;
}

function isLoopbackUrl(baseUrl: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function withEndpoint(
  current: ChatSettings,
  provider: ChatSettings["provider"],
  baseUrl: string,
  model: string,
): ChatSettings {
  return { ...current, provider, baseUrl, model };
}

function delegateTo(current: ChatSettings, cliCommand: ChatCliCommand): ChatSettings {
  const sameCli = current.provider === "cli" && current.cliCommand === cliCommand;
  return { ...current, provider: "cli", cliCommand, model: sameCli ? current.model : "" };
}

const PRESETS: Preset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    reach: "cloud",
    apply: (current) =>
      current.provider === "anthropic"
        ? current
        : withEndpoint(current, "anthropic", "https://api.anthropic.com", "claude-sonnet-4-5"),
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    reach: "cloud",
    apply: (current) =>
      current.provider === "openai-compatible" && !isLoopbackUrl(current.baseUrl)
        ? current
        : withEndpoint(current, "openai-compatible", "https://api.deepseek.com", "deepseek-chat"),
  },
  {
    id: "ollama",
    label: "Ollama",
    reach: "local",
    apply: (current) =>
      withEndpoint(current, "openai-compatible", "http://127.0.0.1:11434/v1", "llama3.1"),
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    reach: "local",
    apply: (current) => withEndpoint(current, "openai-compatible", "http://127.0.0.1:1234/v1", ""),
  },
  {
    id: "claude",
    label: "Use installed claude CLI",
    reach: "delegate",
    apply: (current) => delegateTo(current, "claude"),
  },
  {
    id: "codex",
    label: "Use installed codex CLI",
    reach: "delegate",
    apply: (current) => delegateTo(current, "codex"),
  },
];

/** Which preset the stored settings correspond to. */
function presetOf(settings: ChatSettings): PresetId {
  if (settings.provider === "cli") return settings.cliCommand;
  if (settings.provider === "anthropic") return "anthropic";
  if (settings.baseUrl.includes(":11434")) return "ollama";
  if (settings.baseUrl.includes(":1234")) return "lmstudio";
  return "openai-compatible";
}

const REACH_CLASS: Record<Reach, string> = {
  cloud: "bg-muted text-muted-foreground",
  local: "bg-success/15 text-success-foreground",
  delegate: "bg-muted text-muted-foreground",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-[13px] text-foreground">{label}</span>
        <span className="text-2xs text-muted-foreground">{detail}</span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        className="mt-0.5 data-checked:bg-success"
      />
    </label>
  );
}

/** The key column of one provider row. */
function useKeyStates(draft: ChatSettings) {
  const [keys, setKeys] = useState<Partial<Record<"anthropic" | "openai-compatible", boolean>>>({});
  const [clis, setClis] = useState<Partial<Record<ChatCliCommand, ChatCliStatus>>>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    for (const provider of ["anthropic", "openai-compatible"] as const) {
      chatKeyStatus(provider)
        .then((found) => !cancelled && setKeys((current) => ({ ...current, [provider]: found })))
        .catch(() => !cancelled && setKeys((current) => ({ ...current, [provider]: false })));
    }
    for (const command of ["claude", "codex"] as const) {
      chatCliStatus(command)
        .then((status) => !cancelled && setClis((current) => ({ ...current, [command]: status })))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [version, draft.baseUrl]);
  return { keys, clis, refresh: () => setVersion((current) => current + 1) };
}

function keyState(
  preset: Preset,
  keys: Partial<Record<"anthropic" | "openai-compatible", boolean>>,
  clis: Partial<Record<ChatCliCommand, ChatCliStatus>>,
): { tone: string; text: string; detail: string } {
  if (preset.reach === "local")
    return { tone: "bg-muted-foreground", text: "Not needed", detail: "" };
  if (preset.id === "claude" || preset.id === "codex") {
    const status = clis[preset.id];
    if (status === undefined) return { tone: "bg-muted-foreground", text: "Checking…", detail: "" };
    return status.found
      ? {
          tone: "bg-success",
          text: `Found ${status.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? ""}`.trim(),
          detail: `${status.path ?? ""} · its own auth`,
        }
      : { tone: "bg-muted-foreground", text: "Not installed", detail: "not found on PATH" };
  }
  const found = keys[preset.id as "anthropic" | "openai-compatible"];
  return found === true
    ? { tone: "bg-success", text: "Key stored", detail: "" }
    : { tone: "bg-destructive", text: found === undefined ? "Checking…" : "Missing", detail: "" };
}

function capValue(value: string): number | null {
  const parsed = Number(value.replace(/[,_\s]/g, ""));
  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/** Provider, privacy, cost caps, and cache settings for the assistant. */
export function SettingsForm({
  settings,
  projectInView,
  onSaved,
}: {
  settings: ChatSettings;
  projectInView: string | null;
  onSaved: (settings: ChatSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [keyDraft, setKeyDraft] = useState("");
  const [neverSendDraft, setNeverSendDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const { keys, clis, refresh } = useKeyStates(draft);
  const selected = presetOf(draft);
  const selectedPreset = PRESETS.find((preset) => preset.id === selected) ?? PRESETS[0];

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    chatUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  const update = (patch: Partial<ChatSettings>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateCaps = (patch: Partial<CostCaps>) =>
    setDraft((current) => ({ ...current, caps: { ...current.caps, ...patch } }));
  const fail = (fallback: string) => (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : fallback);

  const save = () => {
    setSaving(true);
    setError(null);
    setChatSettings(draft)
      .then(onSaved)
      .catch(fail("Could not save settings"))
      .finally(() => setSaving(false));
  };

  const saveKey = () => {
    if (keyDraft.trim() === "") return;
    setSaving(true);
    setError(null);
    setChatKey(draft.provider, keyDraft.trim())
      .then(refresh)
      .catch(fail("Could not store the key"))
      .finally(() => {
        setSaving(false);
        setKeyDraft("");
      });
  };

  const addNeverSend = (path: string) => {
    const trimmed = path.trim();
    if (trimmed === "" || draft.neverSend.includes(trimmed)) return;
    update({ neverSend: [...draft.neverSend, trimmed] });
    setNeverSendDraft("");
  };

  const monthShare =
    usage !== null && draft.caps.perMonthTokens !== null
      ? Math.min(1, usage.monthTokens / draft.caps.perMonthTokens)
      : null;

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold text-foreground">Assistant</h2>
        <p className="text-2xs text-muted-foreground">
          Choose where questions go. Grove only reads; no provider can change a repository.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Provider"
        className="flex flex-col overflow-hidden rounded-lg border border-border"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          <span>Provider</span>
          <span>Key</span>
        </div>
        {PRESETS.map((preset) => {
          const state = keyState(preset, keys, clis);
          const checked = preset.id === selected;
          const endpoint =
            preset.reach === "delegate"
              ? state.detail
              : preset.apply(draft).baseUrl.replace(/^https?:\/\//, "");
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setDraft((current) => preset.apply(current))}
              className={cn(
                "flex items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0",
                checked ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                  checked ? "border-foreground" : "border-muted-foreground",
                )}
              >
                {checked && <span className="size-1.5 rounded-full bg-foreground" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[13px] text-foreground">
                  {preset.label}
                  <span className={cn("rounded-sm px-1 text-[10px]", REACH_CLASS[preset.reach])}>
                    {preset.reach}
                  </span>
                </span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {endpoint}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                <span aria-hidden className={cn("size-1.5 rounded-full", state.tone)} />
                {state.text}
              </span>
            </button>
          );
        })}
      </div>

      <Section title={selectedPreset.label}>
        {draft.provider !== "cli" && (
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">Base URL</span>
            <Input
              className="h-8 text-[12.5px]"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </label>
        )}
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">Model</span>
            <Input
              className="h-8 text-[12.5px]"
              value={draft.model}
              placeholder={draft.provider === "cli" ? "the CLI's default" : "model id"}
              onChange={(event) => update({ model: event.target.value })}
            />
          </label>
          <label className="flex w-28 flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">Max output tokens</span>
            <Input
              className="h-8 text-[12.5px]"
              type="number"
              value={String(draft.maxTokens)}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed) && parsed > 0)
                  update({ maxTokens: Math.round(parsed) });
              }}
            />
          </label>
        </div>
        {draft.provider === "cli" && draft.cliCommand === "codex" && (
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">Model server</span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground"
              value={draft.cliLocalServer ?? "cloud"}
              onChange={(event) =>
                update({
                  cliLocalServer:
                    event.target.value === "cloud"
                      ? null
                      : (event.target.value as LocalModelServer),
                })
              }
            >
              <option value="cloud">Codex's own (cloud)</option>
              <option value="ollama">Ollama on this machine (--oss)</option>
              <option value="lmstudio">LM Studio on this machine (--oss)</option>
            </select>
          </label>
        )}
        {selectedPreset.reach === "cloud" && (
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">
              API key{" "}
              {keys[draft.provider as "anthropic" | "openai-compatible"]
                ? "(stored — type to replace)"
                : "(not stored)"}
            </span>
            <span className="flex gap-1.5">
              <Input
                className="h-8 text-[12.5px]"
                type="password"
                value={keyDraft}
                placeholder="sk-…"
                onChange={(event) => setKeyDraft(event.target.value)}
              />
              <Button size="sm" disabled={keyDraft.trim() === "" || saving} onClick={saveKey}>
                Save key
              </Button>
              {keys[draft.provider as "anthropic" | "openai-compatible"] === true && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void clearChatKey(draft.provider).then(refresh, refresh)}
                >
                  Remove
                </Button>
              )}
            </span>
          </label>
        )}
        {selectedPreset.reach === "delegate" && (
          <p className="text-2xs text-muted-foreground">
            The CLI answers with its own login and model. Grove's tools are off for it: the diffs in
            view travel in the prompt (up to 200 KiB), and the CLI runs with its own tools disabled
            or sandboxed read-only in an empty directory.
          </p>
        )}
      </Section>

      <Section title="Privacy">
        <Toggle
          label="Cloud egress"
          detail="Off by default. When off, only local providers can be used."
          checked={draft.allowCloudEgress}
          onChange={(allowCloudEgress) => update({ allowCloudEgress })}
        />
        <Toggle
          label="Preview before send"
          detail="Show every part that will leave before each turn."
          checked={draft.previewBeforeSend}
          onChange={(previewBeforeSend) => update({ previewBeforeSend })}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-foreground">Never send</span>
          <span className="text-2xs text-muted-foreground">
            These repositories never reach a cloud provider.
          </span>
          <ul
            aria-label="Never-send repositories"
            className="flex flex-col rounded-md border border-border"
          >
            {draft.neverSend.map((path) => (
              <li
                key={path}
                className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
                  {path}
                </span>
                <button
                  type="button"
                  aria-label={`Allow ${path} again`}
                  onClick={() =>
                    update({ neverSend: draft.neverSend.filter((entry) => entry !== path) })
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
            <li className="flex items-center gap-1.5 px-1.5 py-1.5">
              <Input
                className="h-7 text-2xs"
                value={neverSendDraft}
                placeholder="/path/to/repository"
                onChange={(event) => setNeverSendDraft(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && addNeverSend(neverSendDraft)}
              />
              <Button size="sm" variant="outline" onClick={() => addNeverSend(neverSendDraft)}>
                Add
              </Button>
              {projectInView !== null && !draft.neverSend.includes(projectInView) && (
                <Button size="sm" variant="outline" onClick={() => addNeverSend(projectInView)}>
                  Add project in view
                </Button>
              )}
            </li>
          </ul>
        </div>
      </Section>

      <Section title="Cost caps">
        {(
          [
            ["Per turn", "perTurnTokens"],
            ["Per session", "perSessionTokens"],
            ["Monthly", "perMonthTokens"],
          ] as const
        ).map(([label, field]) => (
          <label key={field} className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-foreground">{label}</span>
            <span className="flex w-40 items-center gap-1.5 rounded-md border border-input px-2">
              <input
                className="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                inputMode="numeric"
                placeholder="no cap"
                value={draft.caps[field] === null ? "" : String(draft.caps[field])}
                onChange={(event) => updateCaps({ [field]: capValue(event.target.value) })}
              />
              <span className="text-2xs text-muted-foreground">tokens</span>
            </span>
          </label>
        ))}
        {usage !== null && (
          <div className="flex items-center gap-2">
            {monthShare !== null && (
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-input">
                <span
                  className="block h-full rounded-full bg-foreground"
                  style={{ width: `${Math.round(monthShare * 100)}%` }}
                />
              </span>
            )}
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {compactCount(usage.monthTokens)} this month · {compactCount(usage.sessionTokens)}{" "}
              this session
            </span>
          </div>
        )}
        <p className="text-2xs text-muted-foreground">
          Input is checked by estimate before anything is sent; the answer's length is capped
          through max tokens. A turn over a cap is refused with the cap it hit.
        </p>
      </Section>

      <Section title="Cache">
        <Toggle
          label="Summary cache"
          detail="Reuse an answer when the exact same request is sent again. Stored locally."
          checked={draft.summaryCache}
          onChange={(summaryCache) => update({ summaryCache })}
        />
      </Section>

      {error !== null && <p className="text-[12px] text-destructive-foreground">{error}</p>}
      <Button size="sm" disabled={saving} onClick={save} className="self-start">
        Save settings
      </Button>
    </div>
  );
}
