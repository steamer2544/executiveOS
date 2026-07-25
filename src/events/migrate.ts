/**
 * Migrate JSONL event logs into the SQLite event store.
 *
 * DRY-RUN BY DEFAULT — `--apply` is opt-in. The JSONL files are never
 * deleted or rewritten; they remain on disk as the backup.
 */

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EventSource, ExecEvent } from "./types.js";
import { createJsonlBackend } from "./jsonl-backend.js";
import { ALL_SOURCES } from "./backend.js";
import { openEventDb } from "./sqlite-backend.js";
import { eventDbPath, execRoot } from "../paths.js";
import { renameOverwrite } from "../fs-atomic.js";
import { currentSeq } from "./seq.js";

export interface MigrationReport {
  mode: "dry-run" | "apply";
  /** Per source: how many events were read from JSONL. */
  read: Record<EventSource, number>;
  /** How many rows were (or would be) inserted. */
  inserted: number;
  /** Rows already present in the DB with the SAME id — a re-run, not a problem. */
  alreadyPresent: number;
  /** seq collisions: DB already holds this seq with a DIFFERENT id. Must be reported. */
  conflicts: Array<{ seq: number; existingId: string; incomingId: string }>;
  dbPath: string;
}

/**
 * Migrate JSONL event logs into the SQLite event store.
 *
 * @param opts - options
 * @param opts.apply - if true, actually insert rows (default: dry-run)
 * @returns a report describing what happened
 */
export function migrateEventsToSqlite(opts?: { apply?: boolean }): MigrationReport {
  const apply = opts?.apply === true;
  const mode: "dry-run" | "apply" = apply ? "apply" : "dry-run";
  const dbPath = eventDbPath();

  // 1. Read all five JSONL logs directly from disk (not via getBackend,
  //    because the active backend may already be sqlite).
  const jsonlBackend = createJsonlBackend();
  const jsonlEvents = {} as Record<EventSource, ExecEvent[]>;
  const readCounts: Record<EventSource, number> = {} as Record<EventSource, number>;
  for (const source of ALL_SOURCES) {
    jsonlEvents[source] = jsonlBackend.read(source);
    readCounts[source] = jsonlEvents[source].length;
  }

  // 2. Open / init the SQLite DB. Our own handle, closed in the `finally` below — a
  //    leaked handle keeps the file locked on Windows for the rest of the process.
  const db = openEventDb();
  try {

  // 3. Collect all events across sources, sorted by seq ascending (tie-break ts).
  const allEvents: ExecEvent[] = [];
  for (const source of ALL_SOURCES) {
    for (const event of jsonlEvents[source]) {
      allEvents.push(event);
    }
  }
  allEvents.sort((a, b) => a.seq - b.seq || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // 4. First pass: classify each event (alreadyPresent / conflict / new).
  //    This is a read-only pass — no writes.
  let alreadyPresent = 0;
  const conflicts: Array<{ seq: number; existingId: string; incomingId: string }> = [];
  const toInsert: ExecEvent[] = [];

  const checkStmt = db.prepare("SELECT id FROM events WHERE seq = ?");

  for (const event of allEvents) {
    const existing = checkStmt.get(event.seq) as { id: string } | null;
    if (existing) {
      if (existing.id === event.id) {
        alreadyPresent++;
      } else {
        conflicts.push({
          seq: event.seq,
          existingId: existing.id,
          incomingId: event.id,
        });
      }
      continue;
    }
    toInsert.push(event);
  }

  // 5. Second pass: insert in a single transaction (apply mode only).
  //    Dry-run does nothing — zero rows written. But `inserted` reports
  //    how many rows were (or would be) inserted.
  const inserted = toInsert.length;
  if (apply) {
    const insertStmt = db.prepare(
      "INSERT INTO events (seq, id, ts, source, type, data) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertTx = db.transaction((events: ExecEvent[]) => {
      for (const event of events) {
        insertStmt.run(
          event.seq,
          event.id,
          event.ts,
          event.source,
          event.type,
          JSON.stringify(event.data)
        );
      }
    });
    insertTx(toInsert);
  }

  // 6. After a successful apply, advance meta.json if the max migrated seq
  //    exceeds currentSeq(), so the shared counter can never hand out a used number.
  if (apply && toInsert.length > 0) {
    const maxSeq = Math.max(...toInsert.map((e) => e.seq));
    if (maxSeq > currentSeq()) {
      const metaPath = execRoot() + "/meta.json";
      const tmpPath = metaPath + "." + randomUUID();
      writeFileSync(tmpPath, JSON.stringify({ lastSeq: maxSeq }) + "\n");
      renameOverwrite(tmpPath, metaPath);
    }
  }

  // 7. Never deletes or rewrites any .jsonl file — they stay as the backup.

  return {
    mode,
    read: readCounts,
    inserted,
    alreadyPresent,
    conflicts,
    dbPath,
  };

  } finally {
    db.close();
  }
}
