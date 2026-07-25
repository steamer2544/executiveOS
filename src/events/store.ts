// EventStore: append, read, and tail events. The public API of this module is the
// event-append contract every other layer depends on; where the events actually live
// (JSONL files or SQLite) is the backend's business — see events/backend.ts.
//
// Concurrency note (JSONL backend): each append writes the full line in one write call.
// If multiple callers append concurrently, lines may interleave at the byte level for
// very large payloads, but for these event sizes this is not a concern.

import type { EventSource, ExecEvent } from "./types.js";
import { isValidType } from "./types.js";
import { nextSeq } from "./seq.js";
import { getBackend } from "./backend.js";

/** Append one event to the store. */
export async function append(input: {
  source: EventSource;
  type: string;
  data?: Record<string, unknown>;
  seq?: number; // Optional seq for testing; auto-assigned if omitted
}): Promise<ExecEvent> {
  const { source, type, data = {}, seq: providedSeq } = input;

  // Validate type prefix matches source.
  if (!isValidType(source, type)) {
    throw new Error(
      `Invalid type "${type}" for source "${source}". ` +
        `Type must be prefixed with "${source}."`
    );
  }

  // Get the backend and ensure it's initialized.
  const backend = getBackend();
  backend.init();

  const seq = providedSeq !== undefined ? providedSeq : nextSeq();

  const event: ExecEvent = {
    seq,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    source,
    type,
    data,
  };

  // Persist via the backend.
  backend.append(event);

  return event;
}

/** Read all events from one source's log, oldest → newest. */
export async function read(source: EventSource): Promise<ExecEvent[]> {
  return getBackend().read(source);
}

/**
 * Read the last N events from one source (or all sources merged &
 * sorted by seq ascending if source is omitted).
 */
export async function tail(
  n: number,
  source?: EventSource
): Promise<ExecEvent[]> {
  return getBackend().tail(n, source);
}

/**
 * Synchronous read of all events from one source, oldest → newest.
 * Used by the synchronous State Builder.
 */
export function readSync(source: EventSource): ExecEvent[] {
  return getBackend().read(source);
}

/**
 * Synchronous read of the last N events (same semantics as `tail`).
 * Used by the synchronous State Builder.
 */
export function tailSync(n: number, source?: EventSource): ExecEvent[] {
  return getBackend().tail(n, source);
}
