// FsWatcher — watches directories for file changes, emits editor.save events.
// Uses node:fs.watch with debounce per file path.

import { watch } from "node:fs";
import { EventBus, type EventInput } from "../bus.js";
import type { Watcher } from "./index.js";
import type { EventSource } from "../events/types.js";

const IGNORE_DIRS = [".git", "node_modules", ".executive"];

export interface FsWatcherConfig {
  paths: string[];
  debounceMs: number;
}

export function createFsWatcher(config: FsWatcherConfig): Watcher {
  // Debounce timers per file path
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: ReturnType<typeof watch>[] = [];

  function shouldIgnore(filePath: string): boolean {
    // Check if path is under any ignored directory
    for (const ignoreDir of IGNORE_DIRS) {
      if (
        filePath.includes("/" + ignoreDir + "/") ||
        filePath.includes("/" + ignoreDir) ||
        filePath.includes("\\" + ignoreDir + "\\") ||
        filePath.includes("\\" + ignoreDir)
      ) {
        return true;
      }
    }
    return false;
  }

  function emitDebounced(filePath: string, changeType: string, b: EventBus): void {
    if (shouldIgnore(filePath)) return;

    const existing = debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(filePath);
      const event: EventInput = {
        source: "editor" as EventSource,
        type: "editor.save",
        data: { path: filePath, changeType },
      };
      b.publish(event);
    }, config.debounceMs);

    debounceTimers.set(filePath, timer);
  }

  return {
    name: "fs",

    async start(bus: EventBus): Promise<void> {
      for (const dir of config.paths) {
        try {
          const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
            if (!filename) return;
            const filePath = typeof filename === "string" ? filename : String(filename);
            emitDebounced(filePath, "change", bus);
          });
          watchers.push(watcher);
        } catch (err) {
          process.stderr.write("FsWatcher: failed to watch " + dir + ": " + (err as Error).message + "\n");
        }
      }
    },

    stop(): void {
      // Clear all debounce timers
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();

      // Close all watchers
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Ignore close errors
        }
      }
    },
  };
}
