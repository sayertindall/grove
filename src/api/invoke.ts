import { invoke } from "@tauri-apps/api/core";

import type { GroveErrorCode, GroveErrorPayload } from "@/types/grove";

/** An Error carrying the backend's stable failure code and the path it names. */
export class GroveError extends Error {
  readonly code: GroveErrorCode;
  readonly path: string | undefined;

  constructor(payload: GroveErrorPayload) {
    super(payload.message);
    this.name = "GroveError";
    this.code = payload.code;
    this.path = payload.path;
  }
}

function isGroveErrorPayload(error: unknown): error is GroveErrorPayload {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

/**
 * Normalizes any rejection into an Error. A command's `{ code, message, path }`
 * becomes a `GroveError` that keeps the code; strings and unknown shapes become
 * plain Errors.
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (isGroveErrorPayload(error)) return new GroveError(error);
  if (typeof error === "string") return new Error(error);
  return new Error("Something went wrong");
}

/** Every command invoke goes through here so callers only ever see Errors. */
export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toError(error);
  }
}
