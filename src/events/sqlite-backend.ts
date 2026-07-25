// SQLite-backed EventBackend (Phase 40).
//
// `seq INTEGER PRIMARY KEY` makes seq the rowid: unique, indexed, and never renumbered
// when rows are deleted — so compaction keeps the same guarantee it has on JSONL.
// This backend NEVER allocates a seq; callers pass a fully-formed event.

import { Database } from "bun:sqlite";
import type { EventSource, ExecEvent } from "./types.js";
import type { EventBackend } from "./backend.js";
import { eventDbPath } from "../paths.js";

/** Schema for the events table. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq    INTEGER PRIMARY KEY,
    id     TEXT    NOT NULL,
    ts     TEXT    NOT NULL,
    source TEXT    NOT NULL,
    type   TEXT    NOT NULL,
    data   TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_source_seq ON events(source, seq);
`;

const INSERT_SQL =
  "INSERT INTO events (seq, id, ts, source, type, data) VALUES (?, ?, ?, ?, ?, ?)";

interface EventRow {
  seq: number;
  id: string;
  ts: string;
  source: string;
  type: string;
  data: string;
}

/** Open handles, keyed by resolved db path, so a test can close them before rmSync.
 *  On Windows an open SQLite handle (plus its -wal/-shm files) blocks directory removal. */
const openDatabases = new Map<string, Database>();

/** Close every open handle. Tests call this before deleting a temp EXECUTIVE_HOME. */
export function closeSqliteDatabases(): void {
  for (const db of openDatabases.values()) {
    try {
      db.close();
    } catch {
      // A handle that is already closed is not an error worth propagating.
    }
  }
  openDatabases.clear();
}

/** A row → ExecEvent. A `data` column that will not parse yields `{}` rather than
 *  throwing — the same "one corrupt record must not kill the read" rule the JSONL
 *  backend applies to a corrupt line. */
function rowToEvent(row: EventRow): ExecEvent {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    process.stderr.write(
      `Warning: unparseable data for event seq=${row.seq} in events.db — using {}\n`
    );
  }
  return {
    seq: row.seq,
    id: row.id,
    ts: row.ts,
    source: row.source as EventSource,
    type: row.type,
    data,
  };
}

export function createSqliteBackend(): EventBackend {
  const dbPath = eventDbPath();
  let db = openDatabases.get(dbPath);
  if (!db) {
    db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    openDatabases.set(dbPath, db);
  }
  const handle = db;

  return {
    init(): void {
      // Schema is created when the handle is opened; re-running it is harmless
      // but pointless, so this is intentionally a no-op.
    },

    append(event: ExecEvent): void {
      handle
        .prepare(INSERT_SQL)
        .run(
          event.seq,
          event.id,
          event.ts,
          event.source,
          event.type,
          JSON.stringify(event.data)
        );
    },

    read(source: EventSource): ExecEvent[] {
      const rows = handle
        .prepare("SELECT * FROM events WHERE source = ? ORDER BY seq ASC")
        .all(source) as EventRow[];
      return rows.map(rowToEvent);
    },

    tail(n: number, source?: EventSource): ExecEvent[] {
      // The DB does the work: ORDER BY seq DESC LIMIT n, then reverse to hand back
      // seq-ascending — never a full read + sort in the process.
      const rows = (
        source
          ? handle
              .prepare(
                "SELECT * FROM events WHERE source = ? ORDER BY seq DESC LIMIT ?"
              )
              .all(source, n)
          : handle
              .prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?")
              .all(n)
      ) as EventRow[];

      rows.reverse();
      return rows.map(rowToEvent);
    },

    replaceAll(source: EventSource, events: ExecEvent[]): void {
      const del = handle.prepare("DELETE FROM events WHERE source = ?");
      const insert = handle.prepare(INSERT_SQL);
      handle.transaction(() => {
        del.run(source);
        for (const event of events) {
          insert.run(
            event.seq,
            event.id,
            event.ts,
            event.source,
            event.type,
            JSON.stringify(event.data)
          );
        }
      })();
    },
  };
}
