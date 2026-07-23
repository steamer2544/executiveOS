// Offline tests for the Advisor (Phase 22).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MockAdvisor } from "./mock.js";
import { parseDrafts, extractText, salvageTruncatedArray, explainPatterns, hasGrounding, windowHistory, buildUserMessage, buildRequestBody } from "./anthropic.js";
import { readStore, writeStore, addDrafts, decide, pending, pendingTitles } from "./store.js";
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
