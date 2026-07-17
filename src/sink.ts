// StoreSink — the single subscriber that persists bus events via EventStore.

import { EventBus } from "./bus.js";
import { append } from "./events/store.js";
import type { EventSource } from "./events/types.js";

/**
 * Subscribe a sink that appends every published EventInput via EventStore.append().
 * Returns an unsubscribe function.
 *
 * Appends are naturally serialized because publish is synchronous and append
 * uses appendFileSync. On append error, logs to stderr and continues.
 */
export function attachStoreSink(bus: EventBus): () => void {
  const unsub = bus.subscribe(async (e) => {
    try {
      await append({ source: e.source as EventSource, type: e.type, data: e.data });
    } catch (err) {
      process.stderr.write("StoreSink error: " + (err as Error).message + "\n");
    }
  });

  return unsub;
}
