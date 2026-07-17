// Load and validate config.json from .executive/.

import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

export interface Config {
  /** Config schema version (always 1 for Phase 1). */
  version: 1;
  /** ISO timestamp set once at init time. */
  createdAt: string;
  /** IANA timezone identifier. */
  timezone: string;
  /** Watcher configuration (defaults applied when absent). */
  watch?: {
    git: {
      enabled?: boolean;
      repoPath?: string;
      pollMs?: number;
    };
    fs: {
      enabled?: boolean;
      paths?: string[];
      debounceMs?: number;
    };
  };
}

/** Default configuration values. */
export function defaultConfig(): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    watch: {
      git: {
        enabled: true,
        repoPath: process.cwd(),
        pollMs: 5000,
      },
      fs: {
        enabled: true,
        paths: [process.cwd() + "/src"],
        debounceMs: 300,
      },
    },
  };
}

/**
 * Read config.json. Merges missing watch fields with defaults so a
 * Phase 1 config (no `watch` key) still works.
 * Throws a clear error if the file is missing or if JSON is malformed.
 */
export function loadConfig(): Config {
  const cfgPath = configPath();

  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf-8");
  } catch {
    throw new Error("Config file not found. Run `executive init` first.");
  }

  if (!raw.trim()) {
    throw new Error("Config file is empty. Run `executive init` to create a valid config.");
  }

  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch {
    throw new Error("Config file contains malformed JSON: " + cfgPath);
  }

  // Merge missing watch fields with defaults.
  const defaults = defaultConfig();
  if (!parsed.watch) {
    parsed.watch = defaults.watch!;
  }
  if (!parsed.watch.git) {
    parsed.watch.git = defaults.watch!.git;
  }
  if (!parsed.watch.fs) {
    parsed.watch.fs = defaults.watch!.fs;
  }

  // Fill in missing individual fields with defaults.
  parsed.watch.git.enabled = parsed.watch.git.enabled ?? defaults.watch!.git.enabled!;
  parsed.watch.git.repoPath = parsed.watch.git.repoPath ?? defaults.watch!.git.repoPath!;
  parsed.watch.git.pollMs = parsed.watch.git.pollMs ?? defaults.watch!.git.pollMs!;
  parsed.watch.fs.enabled = parsed.watch.fs.enabled ?? defaults.watch!.fs.enabled!;
  parsed.watch.fs.paths = parsed.watch.fs.paths ?? defaults.watch!.fs.paths!;
  parsed.watch.fs.debounceMs = parsed.watch.fs.debounceMs ?? defaults.watch!.fs.debounceMs!;

  return parsed;
}
