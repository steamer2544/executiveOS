// Offline tests for the Advisor (Phase 22).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MockAdvisor } from "./mock.js";
import { parseDrafts, extractText } from "./anthropic.js";
import { readStore, writeStore, addDrafts, decide, pending, pendingTitles } from "./store.js";
import { runAdvisor, decideProposal } from "./advisor.js";
import type { Context } from "../state/types.js";
import type { Config } from "../config.js";
import type { AdvisorStore, ProposalDraft } from "./types.js";

function ctx(over?: Partial<Context["state"]>): Context {
  return {
    generatedAt: "x", summary: "sum",
    state: {
      generatedAt: "x", eventCount: 1, lastEventTs: null, currentProject: "myshi",
      currentTask: "fix login", deadline: null, currentFile: null, recentFiles: [],
      git: { branch: "feat/login", lastCommit: null }, tests: "failing", blocked: false,
      blockedReason: null, currentWindow: null, activity: { active: true, idleMs: 0 }, activeRepo: null, repos: [], ...over,
    },
    recentEvents: [],
  };
}
const MOCK_CONFIG = { worker: { backend: "mock" }, advisor: { maxOpen: 8 } } as Config;

describe("MockAdvisor", () => {
  it("proposes work + rest cards from context", async () => {
    const drafts = await new MockAdvisor().propose(ctx(), []);
    const titles = drafts.map((d) => d.title);
    expect(titles).toContain("Fix the failing tests");
    expect(titles.some((t) => t.startsWith("Timebox"))).toBe(true);
    expect(titles).toContain("Take a 10-minute break");
  });
  it("skips titles already open", async () => {
    const drafts = await new MockAdvisor().propose(ctx(), ["Take a 10-minute break"]);
    expect(drafts.map((d) => d.title)).not.toContain("Take a 10-minute break");
  });
});

describe("parseDrafts", () => {
  it("parses a JSON array", () => {
    const d = parseDrafts('[{"category":"work","title":"A","detail":"d","action":"do"}]');
    expect(d.length).toBe(1);
    expect(d[0]!.title).toBe("A");
  });
  it("parses inside fences + prose, drops title-less items", () => {
    const d = parseDrafts('here: ```json\n[{"title":"Keep"},{"detail":"no title"}]\n```');
    expect(d.map((x) => x.title)).toEqual(["Keep"]);
  });
  it("extractText throws with no text", () => {
    expect(() => extractText({ content: [] })).toThrow();
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
