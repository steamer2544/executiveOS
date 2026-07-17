// Canonical event type for ExecutiveOS event log.
// Every event is one JSON object on one line in a JSONL file.

/** The four event sources = the four jsonl files. */
export type EventSource = "git" | "terminal" | "editor" | "system";

/** Base fields present on every event. */
export interface BaseEvent {
  /** Monotonic global sequence number, unique & increasing across all sources. Starts at 1. */
  seq: number;
  /** Unique identifier (generated via crypto.randomUUID()). */
  id: string;
  /** ISO-8601 UTC timestamp, e.g. "2026-07-17T09:14:03.211Z". */
  ts: string;
  /** Which log this event belongs to. */
  source: EventSource;
  /** Event type, namespaced by source (e.g. "git.commit"). */
  type: string;
  /** Free-form payload; shape depends on type. */
  data: Record<string, unknown>;
}

export type ExecEvent = BaseEvent;

/** Validate that a type string is prefixed with its source. */
export function isValidType(source: EventSource, type: string): boolean {
  return type.startsWith(source + ".");
}
