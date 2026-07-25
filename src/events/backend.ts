import type { EventSource, ExecEvent } from "./types.js";
import { loadConfig } from "../config.js";
import { createJsonlBackend } from "./jsonl-backend.js";
import { createSqliteBackend, closeSqliteDatabases } from "./sqlite-backend.js";
import { eventDbPath } from "../paths.js";

/**
 * A place events are stored. Implementations are SYNCHRONOUS — the State Builder needs a
 * synchronous read, and both backends (file I/O, bun:sqlite) are natively sync.
 * A backend NEVER allocates `seq`; callers pass a fully-formed event.
 */
export interface EventBackend {
  /** Create files / schema if missing. Idempotent, safe to call repeatedly. */
  init(): void;
  /** Persist one fully-formed event. */
  append(event: ExecEvent): void;
  /** Every event of one source, oldest → newest (seq ascending). Missing store → []. */
  read(source: EventSource): ExecEvent[];
  /**
   * The last `n` events of one source, or merged across ALL sources when `source` is
   * omitted. Returned seq ascending (oldest → newest), same as today's `tail`.
   */
  tail(n: number, source?: EventSource): ExecEvent[];
  /** Replace every event of one source (used only by compaction). */
  replaceAll(source: EventSource, events: ExecEvent[]): void;
}

/** All five sources, in the order `tail()` merges them. */
export const ALL_SOURCES: EventSource[] = ["git", "terminal", "editor", "system", "screen"];

// Module-level cache keyed by resolved DB path so repeated calls don't reopen.
const sqliteCache = new Map<string, EventBackend>();

/**
 * Drop the cached sqlite backends AND close their underlying database handles.
 * Call this in tests when EXECUTIVE_HOME changes: a still-open handle (plus its
 * -wal/-shm files) blocks `rmSync` of the temp dir on Windows, and a stale handle
 * would otherwise point at a database that has been deleted.
 */
export function clearSqliteCache(): void {
  sqliteCache.clear();
  closeSqliteDatabases();
}

/**
 * The backend selected by config. Read config on EVERY call (cheap, and tests switch
 * EXECUTIVE_HOME between cases); cache only the underlying sqlite handle, keyed by db path.
 */
export function getBackend(): EventBackend {
  let backend: string | undefined;
  try {
    backend = loadConfig().storage?.backend;
  } catch {
    // Config file missing — fall through to default jsonl.
    backend = "jsonl";
  }

  if (backend === "sqlite") {
    const dbPath = eventDbPath();
    let cached = sqliteCache.get(dbPath);
    if (!cached) {
      cached = createSqliteBackend();
      sqliteCache.set(dbPath, cached);
    }
    return cached;
  }

  // Default: jsonl (or any unrecognized value — caller validates).
  return createJsonlBackend();
}
