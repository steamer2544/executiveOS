// The outward channel the runtime speaks through (Phase 36).
//
// Everything the system knows has lived behind a page the owner has to remember to
// open. A Channel is the other direction: it reaches the owner with the dashboard
// closed, and carries their reply back into the SAME conversation the dashboard uses.
//
// The interface is deliberately tiny. It exists so a second channel is POSSIBLE later,
// not so a second one ships now — Discord (DM, text) is the only implementation.

/** What the runtime sends out. */
export interface OutboundMessage {
  text: string;
  /**
   * Present when a write tool is parked waiting for the owner's tap. The adapter
   * renders it as three buttons; whichever is tapped comes back as an InboundMessage
   * carrying the same `pendingId` — the same id the dashboard's confirm chip uses, so
   * both front doors resume the identical turn.
   */
  confirm?: { pendingId: string };
}

/** What comes back from the owner. Anything from anyone else must never reach here. */
export type InboundMessage =
  | { kind: "text"; text: string }
  | { kind: "confirm"; pendingId: string; decision: "run" | "trust" | "no" };

export interface Channel {
  name: string;
  /**
   * Deliver a message. NEVER throws — a channel that is down must report
   * `{ ok: false }` so the caller can decline to spend the nudge budget on a message
   * that was not delivered.
   */
  send(msg: OutboundMessage): Promise<{ ok: boolean; error?: string }>;
  /** Register the handler for owner-authored inbound messages. Called before `start()`. */
  onInbound(handler: (m: InboundMessage) => Promise<void>): void;
  start(): Promise<void>;
  /** Idempotent. */
  stop(): Promise<void>;
}

/** The slice of WebSocket the Discord adapter uses, so tests can inject a fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  onopen: (() => void) | null;
}
