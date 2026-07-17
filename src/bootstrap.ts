// Ensure .executive/ directory structure exists.
// Idempotent: running twice never errors or loses data.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execRoot, eventsDir, logsDir, configPath } from "./paths.js";
import type { EventSource } from "./events/types.js";
import { defaultConfig } from "./config.js";

/** The four event sources that get their own jsonl file. */
const SOURCES: EventSource[] = ["git", "terminal", "editor", "system"];

/**
 * Create .executive/, its subdirs, empty jsonl files, default config,
 * and meta.json (seq counter) if they don't already exist.
 * Safe to call multiple times.
 */
export async function bootstrap(): Promise<void> {
  // Create directory tree (recursive, idempotent).
  mkdirSync(execRoot(), { recursive: true });
  mkdirSync(eventsDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });

  // Create each source jsonl file if missing (empty file, never overwrite).
  for (const source of SOURCES) {
    const path = eventsDir() + "/" + source + ".jsonl";
    if (!existsSync(path)) {
      writeFileSync(path, "");
    }
  }

  // Write config.json only if it does not already exist.
  const cfgPath = configPath();
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify(defaultConfig(), null, 2) + "\n");
  }

  // Write meta.json (seq counter) only if it does not already exist.
  const metaPath = execRoot() + "/meta.json";
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({ lastSeq: 0 }) + "\n");
  }
}
