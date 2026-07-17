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

/** Absolute path to .executive/plan.json. */
export function planPath(): string {
  return execRoot() + "/plan.json";
}

/** Absolute path to .executive/proposals/ (proposal history). */
export function proposalsDir(): string {
  return execRoot() + "/proposals";
}

/** Absolute path to .executive/proposal.json (the latest proposal). */
export function proposalPath(): string {
  return execRoot() + "/proposal.json";
}

/** Absolute path to .executive/exec-report.json (the latest Executor report). */
export function execReportPath(): string {
  return execRoot() + "/exec-report.json";
}

/** Absolute path to .executive/changeset.json (the latest synthesized ChangeSet). */
export function changeSetPath(): string {
  return execRoot() + "/changeset.json";
}

/** Absolute path to .executive/synth-report.json (the latest Synthesizer report). */
export function synthReportPath(): string {
  return execRoot() + "/synth-report.json";
}

/** Absolute path to .executive/auto-report.json (the latest Autopilot report). */
export function autoReportPath(): string {
  return execRoot() + "/auto-report.json";
}
