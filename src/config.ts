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
}

/** Default configuration values. */
export function defaultConfig(): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
  };
}

/**
 * Read config.json. Throws a clear error if the file is missing
 * (tell the user to run `init`) or if JSON is malformed.
 */
export function loadConfig(): Config {
  const cfgPath = configPath();

  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf-8");
  } catch {
    throw new Error(
      "Config file not found. Run `executive init` first."
    );
  }

  if (!raw.trim()) {
    throw new Error(
      "Config file is empty. Run `executive init` to create a valid config."
    );
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed as Config;
  } catch {
    throw new Error(
      "Config file contains malformed JSON: " + cfgPath
    );
  }
}
