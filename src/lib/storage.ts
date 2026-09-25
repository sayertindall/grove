export const storageKeys = {
  theme: "grove.theme",
  diffStyle: "grove.diffStyle",
  overflow: "grove.overflow",
  ignoreWhitespace: "grove.ignoreWhitespace",
  selectedProject: "grove.selectedProject",
  selectedFiles: "grove.selectedFiles",
  sidebarWidth: "grove.sidebarWidth",
  treeWidth: "grove.treeWidth",
  projectSort: "grove.projectSort",
  hideClean: "grove.hideClean",
  chatOpen: "grove.chatOpen",
  chatWidth: "grove.chatWidth",
} as const;

export type ThemePreference = "system" | "dark" | "light";
export type DiffStyle = "unified" | "split";
export type DiffOverflow = "wrap" | "scroll";
export type ProjectSort = "stored" | "dirty" | "name";

export const SIDEBAR_WIDTH = { min: 180, max: 420, fallback: 240 } as const;
export const TREE_WIDTH = { min: 180, max: 640, fallback: 280 } as const;
export const CHAT_WIDTH = { min: 280, max: 640, fallback: 400 } as const;

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A full quota or private-mode denial must not break the viewer.
  }
}

export function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = readRaw(key);
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function writeEnum(key: string, value: string): void {
  writeRaw(key, value);
}

export function readBoolean(key: string, fallback: boolean): boolean {
  const raw = readRaw(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

export function writeBoolean(key: string, value: boolean): void {
  writeRaw(key, value ? "true" : "false");
}

export function readClampedNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

export function writeNumber(key: string, value: number): void {
  writeRaw(key, String(value));
}

export function readString(key: string): string | null {
  const raw = readRaw(key);
  return raw === null || raw === "" ? null : raw;
}

export function writeString(key: string, value: string | null): void {
  if (value === null || value === "") {
    try {
      localStorage.removeItem(key);
    } catch {
      // Same as a failed write: the in-memory value still stands.
    }
    return;
  }
  writeRaw(key, value);
}

export function readSelectedFiles(): Record<string, string> {
  const raw = readRaw(storageKeys.selectedFiles);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const files: Record<string, string> = {};
    for (const [path, file] of Object.entries(parsed)) {
      if (typeof file === "string" && file !== "") files[path] = file;
    }
    return files;
  } catch {
    return {};
  }
}

export function writeSelectedFiles(files: Record<string, string>): void {
  writeRaw(storageKeys.selectedFiles, JSON.stringify(files));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
