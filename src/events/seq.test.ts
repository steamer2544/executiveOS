// Tests for the seq counter's monotonic increment and no stray temp files.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
