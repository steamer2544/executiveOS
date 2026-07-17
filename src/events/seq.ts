// Monotonic global sequence counter for events.
//
// Concurrency note: exactly one writer at a time. In practice the `watch`
// daemon is the writer; manual `emit` from a second process while the
// daemon runs is a known unsupported edge case.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
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
  renameSync(tmpPath, path);

  return next;
}
