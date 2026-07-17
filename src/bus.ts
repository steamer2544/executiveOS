// In-process publish/subscribe event bus.
// Tiny typed implementation — no external dependencies.

import type { EventSource } from "./events/types.js";

export interface EventInput {
  source: EventSource;
  type: string;
  data?: Record<string, unknown>;
}

export type BusHandler = (e: EventInput) => void | Promise<void>;

export class EventBus {
  private handlers: BusHandler[] = [];

  /** Fire-and-forget to all subscribers in registration order. */
  publish(e: EventInput): void {
    for (const handler of this.handlers) {
      try {
        const result = handler(e);
        if (result instanceof Promise) {
          result.catch((err) => {
            process.stderr.write("Bus handler error: " + err.message + "\n");
          });
        }
      } catch (err) {
        process.stderr.write("Bus handler error: " + (err as Error).message + "\n");
      }
    }
  }

  /**
   * Subscribe a handler. Returns an unsubscribe function.
   * Handlers fire in registration order.
   */
  subscribe(handler: BusHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
}
