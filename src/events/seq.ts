// Monotonic global sequence counter for events.
//
// Concurrency note: exactly one writer at a time. In practice the `watch`
// daemon is the writer; manual `emit` from a second process while the
// daemon runs is a known unsupported edge case.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execRoot } from "../paths.js";

const META_FILENAME = "meta.json";

interface MetaJson {
  lastSeq: number;
}

function metaPath(): string {
  return execRoot() + "/" + META_FILENAME;
}

/** Read the current lastSeq from meta.json (0 if missing or empty). */
export function currentSeq(): number {
  const path = metaPath();
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed: MetaJson = JSON.parse(raw);
    return parsed.lastSeq;
  } catch {
    return 0;
  }
}

/**
 * Atomically increment and persist lastSeq, returning the new value.
 * Writes to a temp file then renames to avoid torn writes.
 */
export function nextSeq(): number {
  const path = metaPath();
  let last: number;

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed: MetaJson = JSON.parse(raw);
      last = parsed.lastSeq;
    } catch {
      last = 0;
    }
  } else {
    last = 0;
  }

  const next = last + 1;

  // Ensure the parent directory exists (tests may call nextSeq without bootstrap).
  const parentDir = path.substring(0, path.lastIndexOf("/"));
  if (parentDir) {
    mkdirSync(parentDir, { recursive: true });
  }

  // Atomic write: write to temp then rename.
  const tmpPath = path + "." + randomUUID();
  writeFileSync(tmpPath, JSON.stringify({ lastSeq: next }) + "\n");
  renameOverwrite(tmpPath, path);

  return next;
}

/**
 * rename() onto an existing file, tolerating a transient Windows EPERM/EBUSY.
 *
 * On Windows the destination cannot be replaced while another handle is open on
 * it, and an antivirus scan or the search indexer opens meta.json for a few ms
 * right after we write it. That surfaced as `StoreSink error: EPERM ... rename`
 * and cost the event its seq (so it was never persisted). Retry briefly with a
 * synchronous backoff — the lock is measured in milliseconds — and only give up
 * (rethrow) if it is really held, which means a genuine second writer.
 */
export function renameOverwrite(from: string, to: string, attempts = 8): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || i >= attempts - 1) {
        try {
          unlinkSync(from);
        } catch {
          // best effort: don't mask the original failure with a cleanup error
        }
        throw err;
      }
      sleepSync(5 * (i + 1)); // 5,10,15… ms — ~180ms total before giving up
    }
  }
}

/** Block the current thread for `ms`. Atomics.wait needs a SharedArrayBuffer view. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
