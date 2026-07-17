// Resolve filesystem paths for the .executiveOS/ directory tree.
// Default: <cwd>/.executiveOS. Overridable via EXECUTIVE_HOME env var.

import type { EventSource } from "./events/types.js";

/** Absolute path to the .executiveOS/ directory. */
export function execRoot(): string {
  const env = process.env.EXECUTIVE_HOME;
  if (env) return env;
  return process.cwd() + "/.executiveOS";
}

/** Absolute path to config.json inside .executiveOS/. */
export function configPath(): string {
  return execRoot() + "/config.json";
}

/** Absolute path to .executiveOS/events/. */
export function eventsDir(): string {
  return execRoot() + "/events";
}

/** Absolute path to .executiveOS/logs/. */
export function logsDir(): string {
  return execRoot() + "/logs";
}

/** Absolute path to the JSONL log for a given source. */
export function eventLogPath(source: EventSource): string {
  return eventsDir() + "/" + source + ".jsonl";
}

/** Absolute path to .executiveOS/state.json. */
export function statePath(): string {
  return execRoot() + "/state.json";
}

/** Absolute path to .executiveOS/context.json. */
export function contextPath(): string {
  return execRoot() + "/context.json";
}

/** Absolute path to .executiveOS/plan.json. */
export function planPath(): string {
  return execRoot() + "/plan.json";
}
