// Unit tests for the FsWatcher ignore policy (isIgnoredPath) — pure, no fs.watch.

import { describe, it, expect } from "bun:test";
import { isIgnoredPath } from "./fs.js";

describe("isIgnoredPath — keeps real source files", () => {
  const keep = [
    "src/index.ts",
    "src\\state\\builder.ts",
    "README.md",
    "docs/scopes/phase-28.md",
    "a/b/c/deep.tsx",
    "./src/a.ts", // leading "./" must NOT be treated as a dotfile
    "../sibling/x.ts", // ".." must NOT be treated as a dotfile
  ];
  for (const p of keep) {
    it("keeps " + p, () => expect(isIgnoredPath(p)).toBe(false));
  }
});

describe("isIgnoredPath — ignores infra dirs", () => {
  const drop = [
    ".git/HEAD",
    "node_modules/foo/index.js",
    ".executive/events/git.jsonl",
    "src/node_modules/pkg/a.js",
  ];
  for (const p of drop) {
    it("ignores " + p, () => expect(isIgnoredPath(p)).toBe(true));
  }
});

describe("isIgnoredPath — ignores dotfiles / dot-dirs (atomic-write temps, swaps)", () => {
  const drop = [
    "report\\.tmp-notify-test", // the exact pollutant seen in real .executive data
    "report\\.tmp-notify-test\\exec-osalm4l1ha9",
    "report/.tmp-notify-test/notifications.jsonl",
    ".env",
    "src/.vscode/settings.json",
    "src/.x.swp", // vim swap (dotfile form)
  ];
  for (const p of drop) {
    it("ignores " + p, () => expect(isIgnoredPath(p)).toBe(true));
  }
});

describe("isIgnoredPath — ignores editor/OS temp + backup suffixes", () => {
  const drop = [
    "state.json.tmp", // atomic write before rename
    "src/report/digest.md.temp",
    "notes.txt~", // emacs backup
    "file.swp",
    "archive.bak",
  ];
  for (const p of drop) {
    it("ignores " + p, () => expect(isIgnoredPath(p)).toBe(true));
  }
});
