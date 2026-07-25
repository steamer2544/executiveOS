// Discord channel adapter — hand-rolled Gateway + REST over WebSocket/fetch.
//
// Phase 36: the runtime speaks first. This adapter connects the proactive nudge
// system to Discord DMs so the owner gets interrupted even with the dashboard closed.
//
// Zero runtime dependencies: the gateway is a plain WebSocket, REST uses globalThis.fetch.
// The bot token is read from process.env only — never a literal, never logged.

import type { Channel, InboundMessage, OutboundMessage, WebSocketLike } from "./types.js";

// ── types ────────────────────────────────────────────────────────────────────

/** Options passed to createDiscordChannel. */
export interface DiscordChannelOptions {
  token: string;
  /** Discord user id allowed to talk to the bot. Anything else is ignored. */
  ownerId: string;
  /** Injected in tests. Default: globalThis.WebSocket / globalThis.fetch. */
  wsFactory?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
}

/**
 * One line in the Discord Gateway wire protocol.
 * op 2 = IDENTIFY, op 1 = HEARTBEAT.
 */
interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

// ── constants ────────────────────────────────────────────────────────────────

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_CONTENT_LIMIT = 2000;

/** Split content into Discord-sized (≤2000-char) chunks, preferring newline boundaries so a
 *  long answer arrives whole across several messages instead of being truncated. A single
 *  overlong line with no newline is hard-cut. Exported for tests. */
export function chunkContent(text: string, limit = DISCORD_CONTENT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    // Avoid a tiny sliver: if the nearest newline is in the front 60%, hard-cut at the limit.
    if (cut < limit * 0.6) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (rest.startsWith("\n")) rest = rest.slice(1);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Create a Channel backed by Discord's Gateway + REST APIs.
 *
 * The adapter opens a persistent WebSocket to the Gateway (receive path) and
 * uses fetch for outbound messages (send path). Both are injected in tests.
 */
export function createDiscordChannel(opts: DiscordChannelOptions): Channel {
  const { token, ownerId, wsFactory, fetchImpl } = opts;

  let handler: ((m: InboundMessage) => Promise<void>) | null = null;
  let dmChannelId: string | null = null;
  let ws: WebSocketLike | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Last gateway sequence number seen; echoed in every heartbeat. */
  let lastSeq: number | null = null;

  // ── REST helpers ─────────────────────────────────────────────────────────

  /** Resolve the DM channel id, caching it for the process lifetime. */
  async function resolveDmChannel(): Promise<string> {
    if (dmChannelId) return dmChannelId;
    const fetch = fetchImpl ?? globalThis.fetch;
    const res = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: ownerId }),
    });
    if (!res.ok) {
      throw new Error(`create DM failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { id: string };
    dmChannelId = data.id;
    return dmChannelId;
  }

  /** Send a message to the DM channel, splitting content > 2000 chars across several
   *  messages (Discord's per-message limit) instead of truncating. Buttons ride the LAST
   *  chunk so they sit under the full answer. Never throws. */
  async function sendDiscordMessage(
    content: string,
    components?: unknown
  ): Promise<{ ok: boolean; error?: string }> {
    const fetch = fetchImpl ?? globalThis.fetch;
    try {
      const channelId = await resolveDmChannel();
      const chunks = chunkContent(content);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const body: Record<string, unknown> = { content: chunks[i] };
        if (isLast && components) body.components = components;

        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `network: ${String(e)}` };
    }
  }

  /**
   * Respond to a button click within the 3-second deadline with an UPDATE_MESSAGE (type 7):
   * edit the confirm message in place to STRIP the buttons and stamp the owner's choice, so
   * the tap has visible feedback (issue: buttons used to linger with no "clicked" state).
   * `originalContent` is the confirm text (from the interaction's `message`) so it is kept.
   */
  async function updateInteractionMessage(
    interactionId: string,
    interactionToken: string,
    newContent: string
  ): Promise<void> {
    const fetch = fetchImpl ?? globalThis.fetch;
    try {
      await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: 7, // UPDATE_MESSAGE
          data: { content: chunkContent(newContent)[0], components: [] },
        }),
      });
    } catch {
      // Best effort — if this fails Discord shows "interaction failed", but we still
      // call the handler so the decision is acted on.
    }
  }

  /** The status line stamped onto a confirm message once the owner taps a button. */
  function decisionStamp(decision: "run" | "trust" | "no"): string {
    if (decision === "no") return "❌ ยกเลิกแล้ว";
    if (decision === "trust") return "🤝 ไว้ใจ tool นี้ตลอด — กำลังทำ…";
    return "✅ ทำเลย — กำลังทำ…";
  }

  // ── button components ────────────────────────────────────────────────────

  /** Build the Discord components array for a confirm message. */
  function buildConfirmComponents(pendingId: string, trustable = true): unknown {
    const components: unknown[] = [
      {
        type: 2, // Button
        style: 1, // Primary
        label: "ทำเลย",
        custom_id: `confirm:${pendingId}:run`,
      },
    ];
    // run_command / edit_files are never blanket-trustable (Phase 38) — omit the trust button.
    if (trustable) {
      components.push({
        type: 2,
        style: 2, // Secondary
        label: "ไว้ใจ tool นี้ตลอด",
        custom_id: `confirm:${pendingId}:trust`,
      });
    }
    components.push({
      type: 2,
      style: 4, // Danger
      label: "ไม่",
      custom_id: `confirm:${pendingId}:no`,
    });
    return [{ type: 1, components }]; // ActionRow
  }

  // ── gateway helpers ──────────────────────────────────────────────────────

  /** Send an op to the gateway. */
  function sendToGateway(payload: GatewayPayload): void {
    if (ws && !stopped) {
      ws.send(JSON.stringify(payload));
    }
  }

  /**
   * Send a heartbeat (op 1) carrying the last sequence number seen.
   * `null` until the first dispatch — sending 0 there is a lie about how much of
   * the stream we have, and the gateway may invalidate the session over it.
   */
  function sendHeartbeat(): void {
    sendToGateway({ op: 1, d: lastSeq });
  }

  /** Send IDENTIFY (op 2). The heartbeat is started by HELLO, which owns the interval. */
  function sendIdentify(): void {
    sendToGateway({
      op: 2,
      d: {
        token,
        intents: 4096, // DIRECT_MESSAGES
        properties: { os: "windows", browser: "executiveos", device: "executiveos" },
      },
    });
  }

  /** Start the heartbeat interval. */
  function startHeartbeat(intervalMs: number): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
  }

  /** Stop the heartbeat interval. */
  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** Handle a HELLO payload — start heartbeat and IDENTIFY. */
  function handleHello(d: { heartbeat_interval: number }): void {
    sendIdentify();
    startHeartbeat(d.heartbeat_interval);
  }

  /** Process a MESSAGE_CREATE event. */
  function handleMessageCreate(d: { author: { id: string }; content: string }): void {
    // Security boundary: only the owner's messages are accepted.
    if (d.author.id !== ownerId) return;
    if (!handler) return;
    handler({ kind: "text", text: d.content });
  }

  /**
   * Process an INTERACTION_CREATE event.
   * 1. Ack the interaction immediately (3s deadline).
   * 2. Parse custom_id and call the handler.
   */
  function handleInteractionCreate(d: {
    id: string;
    token: string;
    member?: { user?: { id: string } };
    user?: { id: string };
    message?: { content?: string };
    data?: { custom_id: string };
  }): void {
    const senderId = d.member?.user?.id ?? d.user?.id;
    if (senderId !== ownerId) return;
    if (!handler) return;
    if (!d.data?.custom_id) return;

    const match = d.data.custom_id.match(/^confirm:(.+):(run|trust|no)$/);
    if (!match) return;

    const pendingId = match[1]!;
    const decision = match[2] as "run" | "trust" | "no";

    // Update the confirm message in place (strip buttons + stamp the choice) before
    // calling the handler — this IS the interaction ack, within the 3-second deadline.
    const original = d.message?.content ?? "";
    const updated = (original ? original + "\n\n" : "") + decisionStamp(decision);
    void updateInteractionMessage(d.id, d.token, updated).then(() => {
      const h = handler;
      if (h) h({ kind: "confirm", pendingId, decision });
    });
  }

  /** Dispatch an incoming gateway event. */
  function dispatch(payload: GatewayPayload): void {
    const { op, t, d, s } = payload;

    // Every payload can carry a sequence number; the heartbeat has to echo the
    // latest one back. (We still do not RESUME — a fresh IDENTIFY after a drop is
    // enough for a personal nudge bot.)
    if (typeof s === "number") lastSeq = s;

    if (op !== 0) return; // only handle dispatch events (op 0)

    switch (t) {
      case "MESSAGE_CREATE":
        handleMessageCreate(d as { author: { id: string }; content: string });
        break;
      case "INTERACTION_CREATE":
        handleInteractionCreate(d as {
          id: string;
          token: string;
          member?: { user?: { id: string } };
          user?: { id: string };
          message?: { content?: string };
          data?: { custom_id: string };
        });
        break;
    }
  }

  /** Open the WebSocket connection. */
  function connect(): void {
    if (stopped) return;
    // wsFactory is a function in tests; in production we use the global WebSocket constructor.
    // Create the instance directly — the factory pattern is for test injection only.
    const factory = wsFactory;
    if (factory) {
      ws = factory(GATEWAY_URL);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WS = globalThis.WebSocket as any;
      ws = new WS(GATEWAY_URL);
    }

    const socket = ws;
    if (!socket) return;

    socket.onmessage = (ev: { data: string }) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(ev.data) as GatewayPayload;
      } catch {
        return; // skip malformed messages
      }

      // op 10 = HELLO
      if (payload.op === 10) {
        handleHello(payload.d as { heartbeat_interval: number });
        return;
      }

      // op 0 = dispatch
      dispatch(payload);
    };

    socket.onclose = () => {
      if (stopped) return;
      stopHeartbeat();
      // Reconnect after fixed 5s delay.
      reconnectTimer = setTimeout(connect, 5000);
    };

    socket.onerror = () => {
      // Errors are non-fatal — the close handler will trigger reconnect.
    };
  }

  // ── Channel implementation ───────────────────────────────────────────────

  return {
    name: "discord",

    send(msg: OutboundMessage): Promise<{ ok: boolean; error?: string }> {
      if (msg.confirm) {
        return sendDiscordMessage(
          msg.text,
          buildConfirmComponents(msg.confirm.pendingId, msg.confirm.trustable !== false)
        );
      }
      return sendDiscordMessage(msg.text);
    },

    onInbound(h: (m: InboundMessage) => Promise<void>): void {
      handler = h;
    },

    async start(): Promise<void> {
      stopped = false;
      connect();
    },

    async stop(): Promise<void> {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try { ws.close(); } catch { /* best effort */ }
        ws = null;
      }
    },
  };
}
