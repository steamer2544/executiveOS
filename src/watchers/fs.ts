// FsWatcher — watches directories for file changes, emits editor.save events.
// Uses node:fs.watch with debounce per file path.

import { watch } from "node:fs";
import { EventBus, type EventInput } from "../bus.js";
import type { Watcher } from "./index.js";
import type { EventSource } from "../events/types.js";

const IGNORE_DIRS = [".git", "node_modules", ".executive"];
// Editor/OS temp + backup suffixes we never treat as "the file being worked on"
// (atomic-write temps like "foo.jsonl.tmp", vim swaps, emacs backups).
const IGNORE_SUFFIXES = ["~", ".tmp", ".temp", ".swp", ".swo", ".swx", ".bak"];

export interface FsWatcherConfig {
  paths: string[];
  debounceMs: number;
  repo?: string; // when set, every editor.save event carries data.repo
}

/**
 * True if `filePath` should NOT produce an editor.save event. Pure + exported so
 * the ignore policy is unit-testable without spawning fs.watch.
 *
 * Segment-aware (splits on both separators, so it works on relative fs.watch
 * filenames and absolute paths). Ignores:
 *  - any segment that is an IGNORE_DIRS entry (".git" / "node_modules" /
 *    ".executive") — the last also prevents a feedback loop where writing the
 *    event log would itself trigger an editor.save;
 *  - any dotfile/dot-dir segment (".env", atomic-write temps like
 *    ".tmp-notify-test", vim swaps ".x.swp") — but never the "." / ".." parts;
 *  - a basename ending in an editor/OS temp/backup suffix ("state.json.tmp").
 */
export function isIgnoredPath(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/);
  if (
    segments.some(
      (seg) =>
        IGNORE_DIRS.includes(seg) ||
        (seg.startsWith(".") && seg !== "." && seg !== "..")
    )
  ) {
    return true;
  }
  const base = segments[segments.length - 1] ?? "";
  // Atomic-write scratch files often carry ".tmp"/".temp" as an INFIX, e.g.
  // "page.ts.tmp.16128.167982cfb2a4" (name + ".tmp." + pid + random) — the
  // suffix check alone misses these because the random token is last.
  if (base.includes(".tmp.") || base.includes(".temp.")) return true;
  return IGNORE_SUFFIXES.some((suf) => base.endsWith(suf));
}

export function createFsWatcher(config: FsWatcherConfig): Watcher {
  // Debounce timers per file path
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: ReturnType<typeof watch>[] = [];

  const shouldIgnore = isIgnoredPath;

  function emitDebounced(filePath: string, changeType: string, b: EventBus): void {
    if (shouldIgnore(filePath)) return;

    const existing = debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(filePath);
      const data: { path: string; changeType: string; repo?: string } = {
        path: filePath,
        changeType,
      };
      if (config.repo) {
        data.repo = config.repo;
      }
      const event: EventInput = {
        source: "editor" as EventSource,
        type: "editor.save",
        data,
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
          const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const filePath = typeof filename === "string" ? filename : String(filename);
            // eventType is "rename" | "change" from fs.watch.
            emitDebounced(filePath, eventType, bus);
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
