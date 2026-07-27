// Offline tests for the Advisor (Phase 22).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MockAdvisor } from "./mock.js";
import { parseDrafts, extractText, salvageTruncatedArray, explainPatterns, hasGrounding, windowHistory, buildUserMessage, buildRequestBody } from "./anthropic.js";
import { readStore, writeStore, addDrafts, decide, pending, pendingTitles, expireStale, pendingCount, PROPOSAL_TTL_DAYS } from "./store.js";
import { runAdvisor, decideProposal } from "./advisor.js";
import type { Context } from "../state/types.js";
import type { Config } from "../config.js";
import type { AdvisorStore, ProposalDraft } from "./types.js";
import { emptyPatterns } from "../state/patterns.js";

function ctx(over?: Partial<Context["state"]>): Context {
  return {
    generatedAt: "x", summary: "sum",
    state: {
      generatedAt: "x", eventCount: 1, lastEventTs: null, currentProject: "myshi",
      currentTask: "fix login", deadline: null, currentFile: null, recentFiles: [],
      git: { branch: "feat/login", lastCommit: null }, tests: "failing", blocked: false,
      blockedReason: null, currentWindow: null, activity: { active: true, idleMs: 0 }, activeRepo: null, repos: [], patterns: emptyPatterns(), ...over,
    },
    recentEvents: [],
  };
}
const MOCK_CONFIG = { worker: { backend: "mock" }, advisor: { maxOpen: 8 } } as Config;

/** A long unbroken session — the only thing that justifies a rest card (Phase 33). */
const LONG_SESSION = { ...emptyPatterns(), sessionMs: 100 * 60_000 };

describe("MockAdvisor", () => {
  it("proposes work cards from context", async () => {
    const drafts = await new MockAdvisor().propose(ctx(), []);
    const titles = drafts.map((d) => d.title);
    expect(titles).toContain("Fix the failing tests");
    expect(titles.some((t) => t.startsWith("Timebox"))).toBe(true);
  });
  it("every draft cites evidence", async () => {
    const drafts = await new MockAdvisor().propose(ctx({ patterns: LONG_SESSION }), []);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(hasGrounding(d.evidence)).toBe(true);
  });
  it("proposes a rest card only when a long session justifies it", async () => {
    const short = await new MockAdvisor().propose(ctx(), []);
    expect(short.map((d) => d.title)).not.toContain("Take a 10-minute break");

    const long = await new MockAdvisor().propose(ctx({ patterns: LONG_SESSION }), []);
    const rest = long.find((d) => d.title === "Take a 10-minute break");
    expect(rest).toBeDefined();
    // The evidence must carry the measurement, not just assert tiredness.
    expect(rest!.evidence).toContain("100 min");
  });
  it("skips titles already open", async () => {
    const drafts = await new MockAdvisor().propose(
      ctx({ patterns: LONG_SESSION }),
      ["Take a 10-minute break"]
    );
    expect(drafts.map((d) => d.title)).not.toContain("Take a 10-minute break");
  });
});

describe("parseDrafts", () => {
  it("parses a JSON array and keeps the evidence", () => {
    const d = parseDrafts(
      '[{"category":"work","title":"A","detail":"d","action":"do","evidence":"state.tests is failing"}]'
    );
    expect(d.length).toBe(1);
    expect(d[0]!.title).toBe("A");
    expect(d[0]!.evidence).toBe("state.tests is failing");
  });
  it("parses inside fences + prose, drops title-less items", () => {
    const d = parseDrafts(
      'here: ```json\n[{"title":"Keep","evidence":"currentFile is synth.ts"},{"detail":"no title"}]\n```'
    );
    expect(d.map((x) => x.title)).toEqual(["Keep"]);
  });
  it("drops ungrounded drafts — the whole point of the evidence field", () => {
    const d = parseDrafts(
      '[{"title":"Grounded","evidence":"branch is feat/login"},' +
        '{"title":"No evidence key"},' +
        '{"title":"Empty","evidence":""},' +
        '{"title":"Shrug","evidence":"n/a"},' +
        '{"title":"Too short","evidence":"tests"}]'
    );
    expect(d.map((x) => x.title)).toEqual(["Grounded"]);
  });
  it("extractText throws with no text", () => {
    expect(() => extractText({ content: [] })).toThrow();
  });
});

describe("hasGrounding", () => {
  it("accepts a specific observation and rejects filler", () => {
    expect(hasGrounding("state.currentFile is advisor/execute.ts")).toBe(true);
    expect(hasGrounding(undefined)).toBe(false);
    expect(hasGrounding("   ")).toBe(false);
    expect(hasGrounding("N/A")).toBe(false);
    expect(hasGrounding("None")).toBe(false);
    expect(hasGrounding("short")).toBe(false);
  });
});

describe("buildUserMessage — behavioural context (Phase 33)", () => {
  const withEvents = (events: Context["recentEvents"]): Context => ({
    ...ctx({ patterns: LONG_SESSION }),
    recentEvents: events,
  });
  const win = (seq: number, app: string, title: string) => ({
    seq, ts: "x", source: "screen", type: "screen.window", data: { app, title },
  });

  it("sends patterns so the model can reason about behaviour, not just a snapshot", () => {
    const msg = JSON.parse(buildUserMessage(withEvents([]), []));
    expect(msg.patterns.sessionMs).toBe(LONG_SESSION.sessionMs);
  });

  it("collapses consecutive repeats in the window history", () => {
    const h = windowHistory(
      withEvents([win(1, "Zed", "a.ts"), win(2, "Zed", "a.ts"), win(3, "brave", "docs")])
    );
    expect(h).toEqual([
      { app: "Zed", title: "a.ts" },
      { app: "brave", title: "docs" },
    ]);
  });

  it("caps the window history at the limit, keeping the newest", () => {
    const events = Array.from({ length: 30 }, (_, i) => win(i, "Zed", "file-" + i + ".ts"));
    const h = windowHistory(withEvents(events), 20);
    expect(h.length).toBe(20);
    expect(h[h.length - 1]!.title).toBe("file-29.ts");
  });

  it("ignores non-window events and malformed window data", () => {
    const h = windowHistory(
      withEvents([
        { seq: 1, ts: "x", source: "editor", type: "editor.save", data: { path: "a.ts" } },
        { seq: 2, ts: "x", source: "screen", type: "screen.window", data: { app: "Zed" } },
        win(3, "brave", "docs"),
      ])
    );
    expect(h).toEqual([{ app: "brave", title: "docs" }]);
  });
});

describe("advisor system prompt", () => {
  it("bans ungrounded generic advice", () => {
    const body = buildRequestBody(ctx(), [], "m", 100) as { system: string };
    expect(body.system).toContain("evidence");
    expect(body.system.toLowerCase()).toContain("generic");
  });
});

describe("store", () => {
  const DIR = "/tmp/executive-test-advisor-" + randomUUID();
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} delete process.env.EXECUTIVE_HOME; });

  const drafts: ProposalDraft[] = [
    { category: "work", title: "A", detail: "da", action: "aa" },
    { category: "rest", title: "B", detail: "db", action: "ab" },
  ];

  it("adds drafts, dedups by title, caps at maxOpen", () => {
    const s: AdvisorStore = { items: [] };
    expect(addDrafts(s, drafts, "mock", 8).length).toBe(2);
    // re-adding same titles → no dup
    expect(addDrafts(s, drafts, "mock", 8).length).toBe(0);
    // cap
    const s2: AdvisorStore = { items: [] };
    const many = Array.from({ length: 10 }, (_, i) => ({ category: "x", title: "T" + i, detail: "", action: "" }));
    expect(addDrafts(s2, many, "mock", 3).length).toBe(3);
  });

  it("decide approves/rejects with edits, and persists via write/read", () => {
    const s: AdvisorStore = { items: [] };
    const added = addDrafts(s, drafts, "mock", 8);
    writeStore(s);
    const id = added[0]!.id;
    const s2 = readStore();
    const p = decide(s2, id, "approve", { action: "edited action", note: "my note" });
    expect(p?.status).toBe("approved");
    expect(p?.action).toBe("edited action");
    expect(p?.note).toBe("my note");
    // pending now excludes the approved one
    expect(pending(s2).map((x) => x.id)).not.toContain(id);
  });

  it("pendingTitles lists only pending", () => {
    const s: AdvisorStore = { items: [] };
    addDrafts(s, drafts, "mock", 8);
    decide(s, s.items[0]!.id, "reject");
    expect(pendingTitles(s)).toEqual(["B"]);
  });
});

describe("runAdvisor + decideProposal", () => {
  const DIR = "/tmp/executive-test-advisor2-" + randomUUID();
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} delete process.env.EXECUTIVE_HOME; });

  it("runAdvisor adds proposals via injected advisor", async () => {
    const r = await runAdvisor(ctx(), { config: MOCK_CONFIG, advisorOverride: new MockAdvisor() });
    expect(r.error).toBeNull();
    expect(r.added.length).toBeGreaterThan(0);
    expect(pending(readStore()).length).toBe(r.added.length);
  });

  it("runAdvisor captures an advisor error", async () => {
    const throwing = { name: "boom", async propose() { throw new Error("net down"); } };
    const r = await runAdvisor(ctx(), { config: MOCK_CONFIG, advisorOverride: throwing });
    expect(r.error).toBe("net down");
    expect(r.added).toEqual([]);
  });

  it("decideProposal approves a queued proposal and returns it", async () => {
    const r = await runAdvisor(ctx(), { config: MOCK_CONFIG, advisorOverride: new MockAdvisor() });
    const id = r.added[0]!.id;
    const p = await decideProposal(id, "approve", { note: "yes please" }, MOCK_CONFIG);
    expect(p?.status).toBe("approved");
    expect(p?.note).toBe("yes please");
    expect(await decideProposal("nope", "approve")).toBeNull();
  });
});

// ─── Phase 46: a full queue must not keep paying for LLM calls it cannot use ──
// Found by reading the live runtime, not by review: advisor.enabled=true with a 10-minute
// cooldown against a queue saturated at maxOpen=8 had burned ~144 gateway calls a day for
// 3.5 days and written nothing, because addDrafts breaks on the first draft once
// pendingCount >= maxOpen. The 8 items holding it shut were pre-Phase-33 generic ones.

describe("advisor queue saturation + expiry (Phase 46)", () => {
  const DIR = "/tmp/executive-test-advisor-ttl-" + randomUUID();
  beforeEach(() => { process.env.EXECUTIVE_HOME = DIR; });
  afterEach(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} delete process.env.EXECUTIVE_HOME; });

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  function storeWith(count: number, createdAt: string): AdvisorStore {
    return {
      items: Array.from({ length: count }, (_, i) => ({
        id: "id" + i, createdAt, category: "work", title: "T" + i,
        detail: "d", action: "a", status: "pending" as const,
      })),
    };
  }

  /** Records whether the LLM was reached at all. */
  function spyAdvisor() {
    const calls: number[] = [];
    return {
      calls,
      advisor: {
        name: "spy",
        async propose(): Promise<ProposalDraft[]> {
          calls.push(1);
          return [{ category: "work", title: "fresh idea", detail: "d", action: "a", evidence: "branch is main" }];
        },
      },
    };
  }

  it("expireStale retires pending proposals past the TTL and keeps the record", () => {
    const s = storeWith(1, daysAgo(5));
    const out = expireStale(s, 3);
    expect(out.length).toBe(1);
    expect(s.items[0]!.status).toBe("expired");
    expect(s.items[0]!.decidedAt).toBeDefined();
    expect(s.items.length).toBe(1);            // kept, never deleted
    expect(pendingCount(s)).toBe(0);           // but no longer occupies a slot
  });

  it("leaves a fresh proposal, a decided one, and an unparseable date alone", () => {
    const fresh = storeWith(1, daysAgo(1));
    expect(expireStale(fresh, 3)).toEqual([]);
    expect(fresh.items[0]!.status).toBe("pending");

    const decided = storeWith(1, daysAgo(9));
    decided.items[0]!.status = "approved";
    expect(expireStale(decided, 3)).toEqual([]);
    expect(decided.items[0]!.status).toBe("approved");

    // Uncertain → keep (the Phase 39 rule).
    const bad = storeWith(1, "not a date");
    expect(expireStale(bad, 3)).toEqual([]);
    expect(bad.items[0]!.status).toBe("pending");
  });

  it("a TTL of 0, a negative TTL or NaN disables expiry entirely", () => {
    for (const ttl of [0, -1, Number.NaN]) {
      const s = storeWith(1, daysAgo(400));
      expect(expireStale(s, ttl)).toEqual([]);
      expect(s.items[0]!.status).toBe("pending");
    }
  });

  it("expires exactly at the boundary, not before it", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const justUnder = { items: [{ ...storeWith(1, "2026-07-24T12:00:00.001Z").items[0]! }] };
    expect(expireStale(justUnder, 3, now)).toEqual([]);      // 1ms younger than the TTL
    const justOver = { items: [{ ...storeWith(1, "2026-07-24T11:59:59.999Z").items[0]! }] };
    expect(expireStale(justOver, 3, now).length).toBe(1);    // 1ms older
  });

  it("does NOT call the LLM when the queue is full, and says why", async () => {
    writeStore(storeWith(8, daysAgo(1)));                    // full, none stale
    const spy = spyAdvisor();
    const r = await runAdvisor(ctx(), {
      config: { worker: { backend: "mock" }, advisor: { maxOpen: 8, proposalTtlDays: 3 } } as Config,
      advisorOverride: spy.advisor,
    });
    expect(spy.calls.length).toBe(0);                        // the whole point
    expect(r.skipped).toContain("queue full");
    expect(r.error).toBeNull();
    expect(r.added).toEqual([]);
    expect(pendingCount(readStore())).toBe(8);               // untouched
  });

  it("expiry runs FIRST, so a full-but-stale queue unblocks itself in one pass", async () => {
    writeStore(storeWith(8, daysAgo(10)));                   // full AND all stale
    const spy = spyAdvisor();
    const r = await runAdvisor(ctx(), {
      config: { worker: { backend: "mock" }, advisor: { maxOpen: 8, proposalTtlDays: 3 } } as Config,
      advisorOverride: spy.advisor,
    });
    expect(r.expired.length).toBe(8);
    expect(spy.calls.length).toBe(1);                        // slots freed → it asked
    expect(r.skipped).toBeNull();
    expect(r.added.map((p) => p.title)).toEqual(["fresh idea"]);
    // and the expiry is persisted, not just reported
    const onDisk = readStore();
    expect(onDisk.items.filter((i) => i.status === "expired").length).toBe(8);
    expect(pendingCount(onDisk)).toBe(1);
  });

  it("persists the expiry even when the gateway call then fails", async () => {
    writeStore(storeWith(8, daysAgo(10)));
    const r = await runAdvisor(ctx(), {
      config: { worker: { backend: "mock" }, advisor: { maxOpen: 8, proposalTtlDays: 3 } } as Config,
      advisorOverride: { name: "boom", async propose(): Promise<ProposalDraft[]> { throw new Error("net down"); } },
    });
    expect(r.error).toBe("net down");
    expect(r.expired.length).toBe(8);
    // The queue must unblock even when the LLM is unreachable.
    expect(pendingCount(readStore())).toBe(0);
  });

  it("falls back to PROPOSAL_TTL_DAYS when the config omits it", async () => {
    // Older than the default, younger than any value a caller passed explicitly.
    writeStore(storeWith(8, daysAgo(PROPOSAL_TTL_DAYS + 1)));
    const spy = spyAdvisor();
    const r = await runAdvisor(ctx(), {
      config: { worker: { backend: "mock" }, advisor: { maxOpen: 8 } } as Config,  // no proposalTtlDays
      advisorOverride: spy.advisor,
    });
    expect(r.expired.length).toBe(8);
    expect(spy.calls.length).toBe(1);
  });

  it("a configured null disables expiry, so a full stale queue is skipped not drained", async () => {
    writeStore(storeWith(8, daysAgo(400)));
    const spy = spyAdvisor();
    const r = await runAdvisor(ctx(), {
      config: { worker: { backend: "mock" }, advisor: { maxOpen: 8, proposalTtlDays: null } } as Config,
      advisorOverride: spy.advisor,
    });
    expect(r.expired).toEqual([]);
    expect(spy.calls.length).toBe(0);
    expect(r.skipped).toContain("queue full");
    expect(pendingCount(readStore())).toBe(8);
  });

  it("an expired title can be proposed again; a rejected one too, an approved one not", () => {
    const s: AdvisorStore = { items: [] };
    addDrafts(s, [{ category: "work", title: "Same idea", detail: "d", action: "a" }], "mock", 8);
    expireStale(s, 3, new Date(Date.now() + 10 * 24 * 60 * 60 * 1000));
    expect(s.items[0]!.status).toBe("expired");
    // Retiring a proposal must not blacklist its title forever — that would be the
    // opposite of unblocking the queue.
    expect(addDrafts(s, [{ category: "work", title: "Same idea", detail: "d", action: "a" }], "mock", 8).length).toBe(1);

    const approved: AdvisorStore = { items: [] };
    addDrafts(approved, [{ category: "work", title: "Done thing", detail: "d", action: "a" }], "mock", 8);
    decide(approved, approved.items[0]!.id, "approve");
    expect(addDrafts(approved, [{ category: "work", title: "Done thing", detail: "d", action: "a" }], "mock", 8).length).toBe(0);
  });
});

// ─── Reasoning-model truncation (found live against the 9arm Qwen gateway) ────

describe("salvageTruncatedArray", () => {
  it("keeps the complete elements of an array cut off mid-object", () => {
    const s = '[{"title":"A","evidence":"branch is main"},{"title":"B","evidence":"file is a';
    const out = salvageTruncatedArray(s);
    expect(out).toBe('[{"title":"A","evidence":"branch is main"}]');
  });

  it("is not confused by braces or brackets inside strings", () => {
    const s = '[{"title":"A}","evidence":"has ] and { inside"},{"title":"B';
    expect(JSON.parse(salvageTruncatedArray(s)!)).toEqual([
      { title: "A}", evidence: "has ] and { inside" },
    ]);
  });

  it("handles an escaped quote before the cut", () => {
    const s = '[{"title":"say \\"hi\\"","evidence":"window title quoted"},{"tit';
    expect(JSON.parse(salvageTruncatedArray(s)!)).toEqual([
      { title: 'say "hi"', evidence: "window title quoted" },
    ]);
  });

  it("returns null when nothing complete can be salvaged", () => {
    expect(salvageTruncatedArray('[{"title":"only par')).toBeNull();
    expect(salvageTruncatedArray('not an array')).toBeNull();
  });
});

describe("parseDrafts — truncated responses", () => {
  it("recovers the finished proposals instead of losing them all", () => {
    const text =
      '[{"category":"work","title":"Keep me","detail":"d","action":"a","evidence":"currentFile is patterns.ts"},' +
      '{"category":"rest","title":"Cut off here","evidence":"pat';
    expect(parseDrafts(text).map((d) => d.title)).toEqual(["Keep me"]);
  });

  it("still throws when the text is not JSON at all", () => {
    expect(() => parseDrafts("the model refused")).toThrow();
  });
});

describe("extractText — names the budget failure", () => {
  it("reports max_tokens rather than a generic 'no text'", () => {
    expect(() => extractText({ content: [], stop_reason: "max_tokens" })).toThrow(/max_tokens/);
    expect(() => extractText({ stop_reason: "max_tokens" })).toThrow(/max_tokens/);
  });

  it("keeps the generic message when the budget was not the problem", () => {
    expect(() => extractText({ content: [], stop_reason: "end_turn" })).toThrow(/no text in response/);
  });
});

describe("explainPatterns — units spelled out", () => {
  it("renders the duration the model kept misreading (2173707 ms is 36 minutes, not hours)", () => {
    const e = explainPatterns({ ...emptyPatterns(), sessionMs: 2173707 });
    expect(e.sessionLength).toBe("36 minutes");
  });

  it("switches to hours past the hour mark", () => {
    const e = explainPatterns({ ...emptyPatterns(), msSinceLastCommit: 41317381 });
    expect(e.timeSinceLastCommit).toBe("11.5 hours");
  });

  it("passes nulls through rather than inventing a zero duration", () => {
    const e = explainPatterns(emptyPatterns());
    expect(e.sessionLength).toBeNull();
    expect(e.timeSinceLastCommit).toBeNull();
  });

  it("is included in the user message next to the raw patterns", () => {
    const msg = JSON.parse(buildUserMessage(ctx({ patterns: LONG_SESSION }), []));
    expect(msg.patternsExplained.sessionLength).toBe("1.7 hours");
    expect(msg.patterns.sessionMs).toBe(LONG_SESSION.sessionMs);
  });
});
