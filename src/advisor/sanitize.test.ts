import { describe, expect, it } from "bun:test";
import { sanitizeExecutable } from "./advisor.js";
import type { ProposalDraft } from "./types.js";

describe("sanitizeExecutable", () => {
  function draft(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
    return {
      category: "work",
      title: "Fix thing",
      detail: "d",
      action: "do it",
      executable: true,
      repo: "myrepo",
      files: ["src/a.ts"],
      ...overrides,
    };
  }

  // 1. Happy path
  it("returns executable:true for a valid work category with repo and action", () => {
    const res = sanitizeExecutable(draft());
    expect(res.executable).toBe(true);
    expect(res.repo).toBe("myrepo");
    expect(res.files).toEqual(["src/a.ts"]);
  });

  // 2. Every category alias works
  it.each([
    "work", "code", "dev", "engineering", "refactor", "test", "bug",
  ])("returns executable:true for category '%s'", (cat) => {
    const res = sanitizeExecutable(draft({ category: cat }));
    expect(res.executable).toBe(true);
  });

  // 3. Every sensitive keyword forces executable:false
  it.each([
    "relationship", "relationships", "romance", "family", "friend",
    "moral", "morality", "ethic", "ethics",
    "spend", "spending", "money", "finance", "financial",
    "invest", "purchase", "buy",
    "goal", "life goal", "life-goal", "career-change",
  ])("returns executable:false when category contains sensitive keyword '%s'", (kw) => {
    const res = sanitizeExecutable(draft({ category: kw }));
    expect(res.executable).toBe(false);
  });

  // 4. Missing/empty repo → executable:false
  it("returns executable:false when repo is missing", () => {
    const res = sanitizeExecutable(draft({ repo: undefined }));
    expect(res.executable).toBe(false);
  });

  it("returns executable:false when repo is empty string", () => {
    const res = sanitizeExecutable(draft({ repo: "" }));
    expect(res.executable).toBe(false);
  });

  // 5. Empty action → executable:false
  it("returns executable:false when action is empty string", () => {
    const res = sanitizeExecutable(draft({ action: "" }));
    expect(res.executable).toBe(false);
  });

  // 6. draft.executable is false → executable:false
  it("returns executable:false when draft.executable is false", () => {
    const res = sanitizeExecutable(draft({ executable: false }));
    expect(res.executable).toBe(false);
  });

  // 7. Unrelated category (not work/code, not sensitive) → executable:false
  it("returns executable:false for unrelated categories like 'health'", () => {
    const res = sanitizeExecutable(draft({ category: "health" }));
    expect(res.executable).toBe(false);
  });

  it("returns executable:false for unrelated categories like 'admin'", () => {
    const res = sanitizeExecutable(draft({ category: "admin" }));
    expect(res.executable).toBe(false);
  });

  // Edge: category is "work" but action is missing → executable:false
  it("returns executable:false when action is missing", () => {
    const res = sanitizeExecutable({
      category: "work",
      title: "t",
      detail: "d",
      action: "",
      executable: true,
      repo: "r",
    });
    expect(res.executable).toBe(false);
  });
});
