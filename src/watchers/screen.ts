// ScreenWatcher — poll-based watcher for the active foreground window title.
// Polling (not native hooks) is the reliable cross-platform choice.
// All state lives in the closure below so multiple instances never clobber each other.
// Emits a screen.window event only when the (title, app) pair changes.

import type { EventBus } from "../bus.js";
import type { Watcher } from "./index.js";
import type { ForegroundWindow } from "../screen/capture.js";

export interface ScreenWatcherConfig {
  pollMs: number;
  /** injectable for tests: defaults to capture.foregroundWindow */
  read?: () => ForegroundWindow | null;
}

/**
 * Normalize a window title before dedup/emit.
 *
 * Many apps animate their title with a leading glyph — a terminal running an agent
 * cycles "⠂ task" → "⠐ task" → "✳ task" every few seconds, an editor prefixes "● " for
 * unsaved changes. Comparing raw titles treats each frame as a new window, which floods
 * the event log (measured: 51% of real screen events were spinner frames of one title).
 *
 * Strips two kinds of leading noise, repeatedly and in this order:
 *   1. a parenthesised unread count — browsers prefix "(81) " and bump it per notification;
 *      it must be matched BEFORE rule 2, which would otherwise eat only the "(" and leave
 *      an unbalanced "81) ".
 *   2. any run of characters that are neither letters nor digits (spinner glyphs, "● ", 🔴).
 * Then trims trailing junk (keeping a closing bracket, as in "build (2 errors)") and
 * collapses inner whitespace. Falls back to the trimmed raw title if nothing would survive.
 */
const LEADING_NOISE = /^(?:\(\d+\)\s*|[^\p{L}\p{N}]+)/u;

export function normalizeTitle(raw: string): string {
  let s = raw;
  for (let prev = ""; s !== prev && s.length > 0; ) {
    prev = s;
    s = s.replace(LEADING_NOISE, "");
  }
  const stripped = s
    .replace(/[^\p{L}\p{N})\]}]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : raw.trim();
}

export function createScreenWatcher(cfg: ScreenWatcherConfig): Watcher {
  let warned = false;
  let lastTitle: string | null = null;
  let lastApp: string | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentBus: EventBus | null = null;

  // Resolve the reader (injectable for tests, real capture in production).
  const read = cfg.read ?? (() => {
    // Lazy import — only when the real path is needed.
    return require("../screen/capture.js").foregroundWindow;
  })();

  function poll(): void {
    if (!currentBus) return;
    try {
      const w = read();

      // Unavailable — warn once, keep polling.
      if (w === null) {
        if (!warned) {
          process.stderr.write("ScreenWatcher: foreground window unavailable — will keep polling\n");
          warned = true;
        }
        return;
      }
      warned = false;

      // Dedup: only emit when the (normalized title, app) pair changes. The normalized
      // title is also what gets emitted, so state/digest show a stable name.
      const title = normalizeTitle(w.title);
      if (title !== lastTitle || w.app !== lastApp) {
        currentBus.publish({
          source: "screen",
          type: "screen.window",
          data: { title, app: w.app },
        });
        lastTitle = title;
        lastApp = w.app;
      }
    } catch (err) {
      // Any error in the poll is caught and logged; the daemon keeps running.
      process.stderr.write("ScreenWatcher: poll error: " + (err as Error).message + "\n");
    }
  }

  return {
    name: "screen",

    start(bus: EventBus): void {
      currentBus = bus;
      // Record the current window as the baseline without emitting (same as GitWatcher).
      const baseline = read();
      if (baseline) {
        lastTitle = normalizeTitle(baseline.title);
        lastApp = baseline.app;
      }
      interval = setInterval(poll, cfg.pollMs);
    },

    stop(): void {
      // Idempotent: clear the poll interval so the process can exit cleanly.
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      currentBus = null;
    },
  };
}
