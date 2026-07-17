// Watcher interface and WatcherManager.

import { EventBus } from "../bus.js";

export interface Watcher {
  readonly name: string;
  start(bus: EventBus): Promise<void> | void;
  stop(): Promise<void> | void;
}

export class WatcherManager {
  private entries: { watcher: Watcher; started: boolean }[] = [];

  constructor(private bus: EventBus, watchers: Watcher[]) {
    this.entries = watchers.map((w) => ({ watcher: w, started: false }));
  }

  async startAll(): Promise<void> {
    for (const entry of this.entries) {
      try {
        await entry.watcher.start(this.bus);
        entry.started = true;
      } catch (err) {
        process.stderr.write(
          "WatcherManager: failed to start " + entry.watcher.name + ": " + (err as Error).message + "\n"
        );
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries) {
      try {
        await entry.watcher.stop();
      } catch (err) {
        process.stderr.write(
          "WatcherManager: error stopping " + entry.watcher.name + ": " + (err as Error).message + "\n"
        );
      }
    }
  }
}
