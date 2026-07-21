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

      // Dedup: only emit when (title, app) changes from the last observed value.
      if (w.title !== lastTitle || w.app !== lastApp) {
        currentBus.publish({
          source: "screen",
          type: "screen.window",
          data: { title: w.title, app: w.app },
        });
        lastTitle = w.title;
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
        lastTitle = baseline.title;
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
