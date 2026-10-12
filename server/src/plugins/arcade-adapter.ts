import { APIError } from "@arcadeai/arcadejs";
import type { ArcadeFailure } from "./arcade";

/**
 * THE VENDOR'S ONLY DOOR INTO THE SERVER. This is the one file under `server/src` that imports
 * `@arcadeai/arcadejs`, so a version bump has exactly this file to be read against, the same
 * convention `createComposioClient` states for its SDK. It imports the transport (`./arcade`) for
 * the `ArcadeFailure` shape; the transport never imports it, because that direction is a cycle and
 * `broker.ts` records why.
 */

/** Deeper than any real wrapping; a bound, so a cyclic `cause` cannot loop. */
const MAX_CAUSE_DEPTH = 16;

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Walk the `cause` chain to the FIRST `APIError` and read its `status` and the response body's
 * `error.name` / `error.message`. The SDK's own fields are `status`, `headers` and `error` (the
 * parsed body); nothing on it names the tool, so nothing here looks for one. No `APIError` anywhere
 * in the chain answers `null`.
 *
 * `status` is undefined for `APIConnectionError` and `APIUserAbortError`, which extend `APIError`:
 * no response was ever read, so the outcome is uncertain, not refused.
 */
export function normalizeArcadeError(error: unknown): ArcadeFailure | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    if (current instanceof APIError) {
      const body = current.error;
      const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
      return {
        status: typeof current.status === "number" ? current.status : undefined,
        name: textOf(record.name),
        message: textOf(record.message),
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
