// Offline tests for the Discord channel adapter.
//
// Phase 36 — Job B. Every test injects a FakeWebSocket and FakeFetch so
// nothing touches the network.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { WebSocketLike, InboundMessage, OutboundMessage } from "./types.js";
import { createDiscordChannel, chunkContent } from "./discord.js";

// ── test doubles ─────────────────────────────────────────────────────────────

/** A fake WebSocket that records sends and lets the caller fire events. */
class FakeWebSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(_url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate receiving a message from the gateway. */
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Simulate a close from the server. */
  emitClose(): void {
    this.onclose?.();
  }

  /** Simulate an error. */
  emitError(e: unknown): void {
    this.onerror?.(e);
  }
}

/** A fake fetch that records requests and returns canned responses. */
class FakeFetch {
  calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  dmResponse: unknown = { id: "dm-channel-123" };
  messageStatus = 200;
  messageBody = "";

  mock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof init.headers === "object" && !(init.headers instanceof Headers)) {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k] = String(v);
        }
      }
    }
    this.calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
    });
    return {
      ok: this.messageStatus >= 200 && this.messageStatus < 300,
      status: this.messageStatus,
      statusText: this.messageStatus === 200 ? "OK" : "Error",
      json: async () => this.dmResponse,
      text: async () => this.messageBody,
    } as Response;
  };
}

function makeWsFactory(fake: FakeWebSocket): (url: string) => WebSocketLike {
  return () => fake;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseSent(payload: string): unknown {
  return JSON.parse(payload);
}

/** Every heartbeat (op 1) the adapter sent, in order, with its `d` payload. */
function heartbeats(sent: string[]): Array<{ op: number; d?: unknown }> {
  return sent
    .map((s) => parseSent(s) as { op: number; d?: unknown })
    .filter((p) => p.op === 1);
}

function identifyPayload(sent: string[]): { op: number; d: unknown } | null {
  for (const s of sent) {
    const p = parseSent(s) as { op: number; d: unknown };
    if (p.op === 2) return p;
  }
  return null;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("createDiscordChannel", () => {
  const token = "bot-token-test";
  const ownerId = "owner-1";

  describe("HELLO → IDENTIFY", () => {
    it("sends IDENTIFY with the correct token and intents", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      // Simulate HELLO with heartbeat interval 500ms.
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      const ident = identifyPayload(fakeWs.sent);
      expect(ident).not.toBeNull();
      expect(ident!.op).toBe(2);
      const d = ident!.d as { token: string; intents: number };
      expect(d.token).toBe(token);
      expect(d.intents).toBe(4096);
    });

    it("sends a heartbeat after the HELLO interval", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      // Wait for the heartbeat interval (500ms + buffer).
      await new Promise((r) => setTimeout(r, 600));

      const hb = heartbeats(fakeWs.sent);
      expect(hb.length).toBeGreaterThanOrEqual(1);
      // No dispatch has arrived, so there is no sequence number to echo yet.
      // `null` is the honest answer; 0 would claim we had seen the stream's start.
      expect(hb[0]!.d).toBeNull();
      await ch.stop();
    });

    it("does not start heartbeating before HELLO says how often", async () => {
      // IDENTIFY used to also start an interval — with a 0ms period, which is a spin
      // loop until HELLO's real interval replaces it.
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 100000 } });
      await new Promise((r) => setTimeout(r, 250));

      expect(heartbeats(fakeWs.sent)).toHaveLength(0);
      await ch.stop();
    });

    it("echoes the last dispatch sequence number in the heartbeat", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 400 } });
      fakeWs.emit({ op: 0, s: 7, t: "TYPING_START", d: {} });
      await new Promise((r) => setTimeout(r, 500));

      const hb = heartbeats(fakeWs.sent);
      expect(hb.length).toBeGreaterThanOrEqual(1);
      expect(hb[hb.length - 1]!.d).toBe(7);
      await ch.stop();
    });
  });

  describe("MESSAGE_CREATE from owner", () => {
    it("calls the handler with { kind: 'text', text }", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      const received: InboundMessage[] = [];
      ch.onInbound((m) => {
        received.push(m);
        return Promise.resolve();
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      // Simulate a MESSAGE_CREATE from the owner.
      fakeWs.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { author: { id: ownerId }, content: "hello owner" },
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ kind: "text", text: "hello owner" });
    });
  });

  describe("MESSAGE_CREATE from non-owner", () => {
    it("handler is NOT called — security boundary", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      const received: InboundMessage[] = [];
      ch.onInbound((m) => {
        received.push(m);
        return Promise.resolve();
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      // Simulate a MESSAGE_CREATE from a different user.
      fakeWs.emit({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { author: { id: "hacker-999" }, content: "evil" },
      });

      // Handler must NOT be called.
      expect(received).toHaveLength(0);
    });
  });

  describe("INTERACTION_CREATE", () => {
    it("sends deferred callback POST before calling the handler", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      const received: InboundMessage[] = [];
      ch.onInbound((m) => {
        received.push(m);
        return Promise.resolve();
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      const interactionId = "interaction-abc";
      const interactionToken = "interaction-token-xyz";

      fakeWs.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: interactionId,
          token: interactionToken,
          user: { id: ownerId },
          message: { content: "รันคำสั่ง: git status" },
          data: { custom_id: "confirm:pending-1:run" },
        },
      });

      // Wait for the async ack + handler call.
      await new Promise((r) => setTimeout(r, 100));

      // The callback updates the message in place (type 7): strips buttons + stamps the choice.
      const ackCall = fakeFetch.calls.find(
        (c) => c.url.includes("/interactions/") && c.url.includes("/callback")
      );
      expect(ackCall).toBeDefined();
      expect(ackCall!.method).toBe("POST");
      const ackBody = JSON.parse(ackCall!.body!);
      expect(ackBody.type).toBe(7); // UPDATE_MESSAGE
      expect(ackBody.data.components).toEqual([]); // buttons removed
      expect(ackBody.data.content).toContain("รันคำสั่ง: git status"); // original kept
      expect(ackBody.data.content).toContain("✅"); // choice stamped

      // Handler should still have been called with correct parsed data.
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        kind: "confirm",
        pendingId: "pending-1",
        decision: "run",
      });
    });

    it("rejects INTERACTION_CREATE from a non-owner", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      const received: InboundMessage[] = [];
      ch.onInbound((m) => {
        received.push(m);
        return Promise.resolve();
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      fakeWs.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "interaction-abc",
          token: "interaction-token-xyz",
          user: { id: "hacker-999" },
          data: { custom_id: "confirm:pending-1:run" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(0);
    });

    it("ignores a malformed custom_id", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      const received: InboundMessage[] = [];
      ch.onInbound((m) => {
        received.push(m);
        return Promise.resolve();
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      fakeWs.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "interaction-abc",
          token: "interaction-token-xyz",
          user: { id: ownerId },
          data: { custom_id: "not-a-confirm-id" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(0);
      await ch.stop();
    });

    it("ignores a custom_id whose decision is not run/trust/no", async () => {
      // The decision word is fed straight into resumeTurn. A loose parse would let a
      // crafted custom_id put an unknown decision into the agent's control flow.
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      const received: InboundMessage[] = [];
      ch.onInbound((m) => {
        received.push(m);
        return Promise.resolve();
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });
      fakeWs.emit({
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "i-1",
          token: "t-1",
          user: { id: ownerId },
          data: { custom_id: "confirm:p-1:banana" },
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(0);
      await ch.stop();
    });
  });

  describe("send", () => {
    it("creates the DM channel on first use and reuses it on the second call", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      // First send → should POST to /users/@me/channels to create DM.
      const result1 = await ch.send({ text: "hello" });
      expect(result1.ok).toBe(true);
      expect(fakeFetch.calls).toHaveLength(2); // create DM + send message

      const createDmCall = fakeFetch.calls[0]!;
      expect(createDmCall.method).toBe("POST");
      expect(createDmCall.url).toBe("https://discord.com/api/v10/users/@me/channels");
      expect(JSON.parse(createDmCall.body!).recipient_id).toBe(ownerId);

      const msgCall = fakeFetch.calls[1]!;
      expect(msgCall.method).toBe("POST");
      expect(msgCall.url).toBe("https://discord.com/api/v10/channels/dm-channel-123/messages");
      expect(JSON.parse(msgCall.body!).content).toBe("hello");

      // Second send → should reuse the cached DM channel id.
      fakeFetch.calls = [];
      const result2 = await ch.send({ text: "again" });
      expect(result2.ok).toBe(true);
      expect(fakeFetch.calls).toHaveLength(1); // only send message, no DM creation
      expect(fakeFetch.calls[0]!.url).toBe(
        "https://discord.com/api/v10/channels/dm-channel-123/messages"
      );
    });

    it("send with confirm includes three buttons with exact custom_ids", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      await ch.send({
        text: "do this?",
        confirm: { pendingId: "p-42" },
      });

      const msgCall = fakeFetch.calls[fakeFetch.calls.length - 1]!;
      const body = JSON.parse(msgCall.body!);
      expect(body.content).toBe("do this?");
      expect(body.components).toBeDefined();
      expect(body.components[0].components).toHaveLength(3);

      const buttons = body.components[0].components as Array<{
        type: number;
        style: number;
        label: string;
        custom_id: string;
      }>;

      expect(buttons[0]).toMatchObject({
        style: 1,
        label: "ทำเลย",
        custom_id: "confirm:p-42:run",
      });
      expect(buttons[1]).toMatchObject({
        style: 2,
        label: "ไว้ใจ tool นี้ตลอด",
        custom_id: "confirm:p-42:trust",
      });
      expect(buttons[2]).toMatchObject({
        style: 4,
        label: "ไม่",
        custom_id: "confirm:p-42:no",
      });
    });

    it("truncates content to ≤ 2000 chars", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      const longText = "x".repeat(3000);
      await ch.send({ text: longText });

      const msgCall = fakeFetch.calls[fakeFetch.calls.length - 1]!;
      const body = JSON.parse(msgCall.body!);
      expect(body.content.length).toBeLessThanOrEqual(2000);
    });

    it("a non-2xx response returns { ok: false }, no throw", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      fakeFetch.messageStatus = 429;
      fakeFetch.messageBody = "Rate limited";
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      const result = await ch.send({ text: "hello" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("429");
    });
  });

  describe("stop", () => {
    it("is idempotent — calling twice does not throw", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

      await ch.stop();
      await ch.stop(); // second call — must not throw
    });

    it("stops the heartbeat after stop()", async () => {
      const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      const fakeFetch = new FakeFetch();
      const ch = createDiscordChannel({
        token,
        ownerId,
        wsFactory: makeWsFactory(fakeWs),
        fetchImpl: fakeFetch.mock as unknown as typeof fetch,
      });

      await ch.start();
      fakeWs.emit({ op: 10, d: { heartbeat_interval: 100 } });

      // Let one heartbeat fire.
      await new Promise((r) => setTimeout(r, 150));

      const sentBefore = fakeWs.sent.length;
      await ch.stop();

      // Wait past another heartbeat interval.
      await new Promise((r) => setTimeout(r, 200));

      // No more heartbeats should be sent.
      expect(fakeWs.sent.length).toBe(sentBefore);
    });
  });
});

// ── issue 3: long messages are chunked, not truncated ────────────────────────

describe("chunkContent", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkContent("short", 2000)).toEqual(["short"]);
  });

  it("splits a long message into ≤limit pieces (nothing lost)", () => {
    const text = Array.from({ length: 50 }, (_, i) => "line " + i + " " + "x".repeat(60)).join("\n");
    const chunks = chunkContent(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    // Re-joining recovers the original (newlines at split points are consumed by the cut).
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-cuts a single overlong line with no newline", () => {
    const chunks = chunkContent("y".repeat(4500), 2000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.length).toBe(2000);
    expect(chunks.join("")).toBe("y".repeat(4500));
  });

  it("preserves full Thai content across chunks (the opm-be truncation bug)", () => {
    const thai = "ผู้รับผิดชอบ ".repeat(400); // > 2000 chars
    expect(thai.length).toBeGreaterThan(2000);
    const chunks = chunkContent(thai);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(thai); // no "…" truncation, all of it survives
  });
});

// ── issue 2: session-trust button for never-persistently-trustable tools ─────

describe("confirm button: session vs persistent trust", () => {
  const token = "bot-token-test";
  const ownerId = "owner-1";

  async function componentsFor(trustable: boolean): Promise<Array<{ custom_id: string; label: string }>> {
    const fakeFetch = new FakeFetch();
    const ch = createDiscordChannel({
      token, ownerId,
      wsFactory: makeWsFactory(new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json")),
      fetchImpl: fakeFetch.mock as unknown as typeof fetch,
    });
    await ch.send({ text: "รันคำสั่ง: ls", confirm: { pendingId: "p1", trustable } });
    const msg = fakeFetch.calls.find((c) => c.url.includes("/messages") && c.method === "POST");
    const body = JSON.parse(msg!.body!);
    return body.components[0].components as Array<{ custom_id: string; label: string }>;
  }

  it("a non-trustable tool (run_command/edit_files) gets a SESSION-trust button", async () => {
    const btns = await componentsFor(false);
    const ids = btns.map((b) => b.custom_id);
    expect(ids).toContain("confirm:p1:trust_session");
    expect(ids).not.toContain("confirm:p1:trust"); // never persistent (Phase 38)
    expect(btns.some((b) => b.label === "ไว้ใจทั้งแชทนี้")).toBe(true);
  });

  it("a trustable tool keeps the persistent-trust button", async () => {
    const btns = await componentsFor(true);
    const ids = btns.map((b) => b.custom_id);
    expect(ids).toContain("confirm:p1:trust");
    expect(ids).not.toContain("confirm:p1:trust_session");
  });

  it("parses a trust_session button click into the right decision", async () => {
    const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    const fakeFetch = new FakeFetch();
    const ch = createDiscordChannel({
      token, ownerId, wsFactory: makeWsFactory(fakeWs),
      fetchImpl: fakeFetch.mock as unknown as typeof fetch,
    });
    const received: InboundMessage[] = [];
    ch.onInbound((m) => { received.push(m); return Promise.resolve(); });
    await ch.start();
    fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });
    fakeWs.emit({
      op: 0, t: "INTERACTION_CREATE",
      d: { id: "i", token: "t", user: { id: ownerId },
        message: { content: "รันคำสั่ง: ls" },
        data: { custom_id: "confirm:p1:trust_session" } },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ kind: "confirm", pendingId: "p1", decision: "trust_session" }]);
  });
});

// The owner names a folder, or the destination turns out to be inside a git repo — both
// need a button that the fixed run/trust/no set cannot express.
describe("confirm buttons: extra choices", () => {
  const token = "bot-token-test";
  const ownerId = "owner-1";

  async function componentsFor(extraChoices: Array<"allow_dir" | "branch">) {
    const fakeFetch = new FakeFetch();
    const ch = createDiscordChannel({
      token, ownerId,
      wsFactory: makeWsFactory(new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json")),
      fetchImpl: fakeFetch.mock as unknown as typeof fetch,
    });
    await ch.send({ text: "บันทึกไฟล์", confirm: { pendingId: "p9", trustable: false, extraChoices } });
    const msg = fakeFetch.calls.find((c) => c.url.includes("/messages") && c.method === "POST");
    return JSON.parse(msg!.body!).components[0].components as Array<{ custom_id: string; label: string }>;
  }

  it("renders a button per extra choice, with cancel still last", async () => {
    const btns = await componentsFor(["allow_dir", "branch"]);
    const ids = btns.map((b) => b.custom_id);
    expect(ids).toContain("confirm:p9:allow_dir");
    expect(ids).toContain("confirm:p9:branch");
    expect(ids[ids.length - 1]).toBe("confirm:p9:no");
  });

  it("renders none when there are none — an ordinary write is unchanged", async () => {
    const ids = (await componentsFor([])).map((b) => b.custom_id);
    expect(ids).toEqual(["confirm:p9:run", "confirm:p9:trust_session", "confirm:p9:no"]);
  });

  it("parses the new buttons, and still refuses an invented decision", async () => {
    const fakeWs = new FakeWebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    const fakeFetch = new FakeFetch();
    const ch = createDiscordChannel({
      token, ownerId, wsFactory: makeWsFactory(fakeWs),
      fetchImpl: fakeFetch.mock as unknown as typeof fetch,
    });
    const received: InboundMessage[] = [];
    ch.onInbound((m) => { received.push(m); return Promise.resolve(); });
    await ch.start();
    fakeWs.emit({ op: 10, d: { heartbeat_interval: 500 } });

    for (const id of ["confirm:p9:allow_dir", "confirm:p9:branch", "confirm:p9:rm_rf"]) {
      fakeWs.emit({
        op: 0, t: "INTERACTION_CREATE",
        d: { id: "i1", token: "tok", member: { user: { id: ownerId } }, data: { custom_id: id } },
      });
    }
    await Bun.sleep(20);
    const decisions = received.filter((m) => m.kind === "confirm").map((m) => (m as { decision: string }).decision);
    expect(decisions).toEqual(["allow_dir", "branch"]); // the invented one is dropped
  });
});
