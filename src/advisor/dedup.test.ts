// Tests for Advisor intent dedup (Phase 32).
// The titles below are the real duplicates the live queue accumulated.

import { describe, it, expect } from "bun:test";
import { contentTokens, jaccard, intentBucket, isRepeatIntent, addDrafts } from "./store.js";
import type { AdvisorStore, ProposalDraft } from "./types.js";

const draft = (title: string, category = "general"): ProposalDraft => ({
  title,
  category,
  detail: "",
  action: "",
});

describe("intentBucket", () => {
  it("buckets self-care wording, however phrased", () => {
    expect(intentBucket("Take a 10-minute screen break")).toBe("rest");
    expect(intentBucket("Stretch neck and shoulders")).toBe("rest");
    expect(intentBucket("Quick desk stretch and water")).toBe("rest");
    expect(intentBucket("Step away for a 5-minute walk")).toBe("rest");
  });

  it("does not bucket work proposals", () => {
    expect(intentBucket("Draft OPM backend test skeleton")).toBeNull();
    expect(intentBucket("List OPM backend endpoints for testing")).toBeNull();
  });
});

describe("jaccard / contentTokens", () => {
  it("ignores stopwords and durations", () => {
    expect(contentTokens("Take a 10-minute screen break").has("take")).toBe(false);
    expect(contentTokens("Take a 10-minute screen break").has("screen")).toBe(true);
  });

  it("scores near-identical titles high and unrelated titles zero", () => {
    const a = contentTokens("Run local test suite for UI changes");
    expect(jaccard(a, contentTokens("Run the local test suite"))).toBeGreaterThan(0.6);
    expect(jaccard(a, contentTokens("Archive old voice notes"))).toBe(0);
  });
});

describe("isRepeatIntent", () => {
  it("catches the same idea in different words", () => {
    const open = ["Take a 10-minute screen break"];
    expect(isRepeatIntent("Quick desk stretch and water", open)).toBe(true);
    expect(isRepeatIntent("Step away for a 5-minute walk", open)).toBe(true);
  });

  it("lets a genuinely different proposal through", () => {
    const open = ["Take a 10-minute screen break"];
    expect(isRepeatIntent("Draft OPM backend test skeleton", open)).toBe(false);
  });

  it("is empty-safe", () => {
    expect(isRepeatIntent("Anything at all", [])).toBe(false);
  });
});

describe("addDrafts — intent dedup", () => {
  it("keeps only the first of four self-care variants", () => {
    const store: AdvisorStore = { items: [] };
    const added = addDrafts(
      store,
      [
        draft("Take a 10-minute screen break"),
        draft("Stretch neck and shoulders"),
        draft("Quick desk stretch and water"),
        draft("Step away for a 5-minute walk"),
        draft("Draft OPM backend test skeleton"),
      ],
      "mock",
      20
    );
    expect(added.map((p) => p.title)).toEqual([
      "Take a 10-minute screen break",
      "Draft OPM backend test skeleton",
    ]);
  });

  it("allows a self-care nudge again once the open one is decided", () => {
    const store: AdvisorStore = { items: [] };
    addDrafts(store, [draft("Take a 10-minute screen break")], "mock", 20);
    store.items[0]!.status = "approved"; // no longer open
    const again = addDrafts(store, [draft("Stretch neck and shoulders")], "mock", 20);
    expect(again.length).toBe(1);
  });
});

describe("isRepeatIntent — no false positives on thin titles", () => {
  it("single-content-word titles are not merged", () => {
    expect(isRepeatIntent("Fix login", ["Fix build"])).toBe(false);
    expect(isRepeatIntent("T1", ["T0"])).toBe(false);
  });

  it("distinct multi-word work proposals coexist", () => {
    const open = ["Draft OPM backend test skeleton"];
    expect(isRepeatIntent("List OPM backend endpoints for testing", open)).toBe(false);
    expect(isRepeatIntent("Add opm backend smoke test", open)).toBe(false);
  });
});
