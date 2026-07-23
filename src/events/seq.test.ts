// Tests for the seq counter's atomic write (Windows EPERM tolerance).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameOverwrite } from "./seq.js";
import { nextSeq, currentSeq } from "./seq.js";

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exec-seq-"));
  prevHome = process.env.EXECUTIVE_HOME;
  process.env.EXECUTIVE_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.EXECUTIVE_HOME;
  else process.env.EXECUTIVE_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("renameOverwrite", () => {
  test("replaces an existing destination", () => {
    const from = join(dir, "src.txt");
    const to = join(dir, "dst.txt");
    writeFileSync(from, "new");
    writeFileSync(to, "old");

    renameOverwrite(from, to);

    expect(readFileSync(to, "utf-8")).toBe("new");
    expect(existsSync(from)).toBe(false);
  });

  test("throws immediately on a non-retryable error instead of looping", () => {
    const from = join(dir, "missing.txt"); // ENOENT: retrying can never help
    const to = join(dir, "dst.txt");

    const started = Date.now();
    expect(() => renameOverwrite(from, to)).toThrow();
    // A retry loop over ENOENT would burn the full ~180ms backoff.
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("nextSeq", () => {
  test("increments monotonically and leaves no temp files behind", () => {
    expect(currentSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
    expect(nextSeq()).toBe(2);
    expect(currentSeq()).toBe(2);

    const strays = readdirSync(dir).filter((f) => f.startsWith("meta.json."));
    expect(strays).toEqual([]);
  });
});
