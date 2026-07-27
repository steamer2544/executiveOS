// Rotating backup for .executive/config.json — preserves previous contents before overwrite.
//
// Never throws: a backup failure must never block a config write.

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { configBackupDir, configPath } from "./paths.js";

/** How many rotating backups to keep (excluding the genesis snapshot). */
export const MAX_CONFIG_BACKUPS = 10;

/**
 * Preserve the current config.json before it is overwritten.
 * Never throws — a backup failure must never block a config write.
 */
export function backupConfig(): void {
  try {
    const cfgPath = configPath();
    if (!existsSync(cfgPath)) return; // no-op: nothing to preserve (init case)

    const current = readFileSync(cfgPath, "utf-8");

    // Ensure backup directory exists.
    mkdirSync(configBackupDir(), { recursive: true });

    // Genesis snapshot — written once, never overwritten, never rotated.
    const genesisPath = configBackupDir() + "/config-genesis.json";
    if (!existsSync(genesisPath)) {
      writeFileSync(genesisPath, current);
    }

    // Skip an identical backup — newest rotating backup already holds same bytes?
    // listRotatingBackups() is sorted OLDEST-first, so the newest is the LAST
    // element. Comparing against [0] would compare against the oldest, letting
    // duplicates accumulate as soon as more than one backup exists.
    const rotating = listRotatingBackups();
    const newestPath = rotating[rotating.length - 1];
    if (newestPath) {
      const newest = readFileSync(newestPath, "utf-8");
      if (newest === current) return;
    }

    // Rotating snapshot with filesystem-safe ISO-8601 timestamp.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = configBackupDir() + "/config-" + timestamp + ".json";
    writeFileSync(backupPath, current);

    // Rotate — delete oldest until at most MAX_CONFIG_BACKUPS remain.
    rotateBackups(rotating.length + 1);
  } catch {
    // Never throw — defensive, everything is wrapped.
  }
}

/**
 * Newest-first list of rotating backup file paths currently on disk.
 * Does not include config-genesis.json.
 */
export function listConfigBackups(): string[] {
  try {
    const rotating = listRotatingBackups();
    return rotating.sort().reverse();
  } catch {
    return [];
  }
}

/** List rotating backup paths (non-genesis), sorted oldest-first. */
function listRotatingBackups(): string[] {
  const dir = configBackupDir();
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  return entries
    .filter((name) => name.startsWith("config-") && name !== "config-genesis.json")
    .map((name) => dir + "/" + name)
    .sort(); // lexicographic = chronological for our timestamp format
}

/** Delete oldest rotating backups until count is at most `currentCount`. */
function rotateBackups(currentCount: number): void {
  const rotating = listRotatingBackups();
  while (rotating.length > MAX_CONFIG_BACKUPS) {
    const oldest = rotating.shift();
    if (oldest) {
      try {
        rmSync(oldest, { force: true });
      } catch {
        // Delete failure is ignored.
      }
    }
  }
}
