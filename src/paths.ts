// Resolve filesystem paths for the .executive/ directory tree.
// Default: <cwd>/.executive. Overridable via EXECUTIVE_HOME env var.

import type { EventSource } from "./events/types.js";

/** Absolute path to the .executive/ directory. */
export function execRoot(): string {
  const env = process.env.EXECUTIVE_HOME;
  if (env) return env;
  return process.cwd() + "/.executive";
}

/** Absolute path to config.json inside .executive/. */
export function configPath(): string {
  return execRoot() + "/config.json";
}

/** Absolute path to .executive/events/. */
export function eventsDir(): string {
  return execRoot() + "/events";
}

/** Absolute path to .executive/logs/. */
export function logsDir(): string {
  return execRoot() + "/logs";
}

/** Absolute path to the JSONL log for a given source. */
export function eventLogPath(source: EventSource): string {
  return eventsDir() + "/" + source + ".jsonl";
}

/** Absolute path to .executive/state.json. */
export function statePath(): string {
  return execRoot() + "/state.json";
}

/** Absolute path to .executive/context.json. */
export function contextPath(): string {
  return execRoot() + "/context.json";
}
