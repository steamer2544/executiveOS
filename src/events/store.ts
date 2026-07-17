// EventStore: append, read, and tail events from JSONL log files.
//
// Concurrency note: each append writes the full line in one write call
// (Bun.write is atomic for small writes). If multiple callers append
// concurrently, lines may interleave at the byte level for very large
// payloads, but for Phase 1 event sizes this is not a concern.

import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { eventLogPath, eventsDir } from "../paths.js";
import type { EventSource, ExecEvent } from "./types.js";
import { isValidType } from "./types.js";

/** Append one event to the source's JSONL log. */
export async function append(input: {
  source: EventSource;
  type: string;
  data?: Record<string, unknown>;
}): Promise<ExecEvent> {
  const { source, type, data = {} } = input;

  // Validate type prefix matches source.
  if (!isValidType(source, type)) {
    throw new Error(
      `Invalid type "${type}" for source "${source}". ` +
        `Type must be prefixed with "${source}."`
    );
  }

  // Ensure the log file and directory exist (bootstrap-level safety).
  ensureLogExists(source);

  const event: ExecEvent = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    source,
    type,
    data,
  };

  // Write the full line in one call to avoid partial-line interleaving.
  const line = JSON.stringify(event) + "\n";
  appendFileSync(eventLogPath(source), line);

  return event;
}

/** Read all events from one source's log, oldest → newest. */
export async function read(source: EventSource): Promise<ExecEvent[]> {
  const path = eventLogPath(source);
  if (!existsSync(path)) {
    return [];
  }

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  const events: ExecEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === "") continue; // skip blank lines

    try {
      const event = JSON.parse(line) as ExecEvent;
      events.push(event);
    } catch {
      // A single corrupt line must NOT crash the whole read.
      // Log a warning to stderr with the line number.
      process.stderr.write(
        `Warning: skipping corrupt line ${i + 1} in ${path}\n`
      );
    }
  }

  return events;
}

/**
 * Read the last N events from one source (or all sources merged &
 * sorted by ts ascending if source is omitted).
 */
export async function tail(
  n: number,
  source?: EventSource
): Promise<ExecEvent[]> {
  if (source) {
    // Single source: read all, return last n.
    const events = await read(source);
    return events.slice(-n);
  }

  // All sources: read all 4 logs, merge, sort ascending by ts, return last n.
  const sources: EventSource[] = ["git", "terminal", "editor", "system"];
  const all: ExecEvent[] = [];
  for (const src of sources) {
    const events = await read(src);
    all.push(...events);
  }

  // Sort ascending by timestamp.
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return all.slice(-n);
}

/** Ensure the directory and jsonl file for a source exist. */
function ensureLogExists(source: EventSource): void {
  const dir = eventsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = eventLogPath(source);
  if (!existsSync(path)) {
    writeFileSync(path, "");
  }
}
