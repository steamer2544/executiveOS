// StoreSink — the single subscriber that persists bus events via EventStore.

import type { EventBus } from "./bus.js";
import { append } from "./events/store.js";
import type { EventSource, ExecEvent } from "./events/types.js";

/**
 * Subscribe a sink that appends every published EventInput via EventStore.append().
 * Returns an unsubscribe function.
 *
 * Appends are naturally serialized: publish is synchronous and append does its
 * work (nextSeq + appendFileSync) synchronously before yielding, so events are
 * persisted in publish order. On append error, logs to stderr and continues
 * (never crashes the daemon).
 *
 * `onPersist`, if provided, is called with the fully persisted event (with its
 * assigned `seq`) — the daemon uses this to print/log each event.
 */
export function attachStoreSink(
  bus: EventBus,
  onPersist?: (e: ExecEvent) => void
): () => void {
  return bus.subscribe(async (e) => {
    try {
      const stored = await append({
        source: e.source as EventSource,
        type: e.type,
        data: e.data,
      });
      if (onPersist) onPersist(stored);
    } catch (err) {
      process.stderr.write("StoreSink error: " + (err as Error).message + "\n");
    }
  });
}
