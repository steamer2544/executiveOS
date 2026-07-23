// Tests for the atomic-write retry loop in fs-atomic.ts.
//
// These tests inject a fake RenameIo so the retry/backoff/cleanup logic is
// actually exercised. Verified by sabotage (GOTCHA.md §4): reduce renameOverwrite
// to a bare `io.rename(from, to)` and 5 of these 8 go red. The three tests added in
// Phase 34.1 all stayed green against that same stub, which is why they were replaced.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameOverwrite, sleepSync, type RenameIo } from "./fs-atomic.js";

// ─── Fake Io helpers ──────────────────────────────────────────────────────────

/**
 * Build a fake RenameIo.
 * @param script — error (or null to succeed) for each rename attempt in order.
 */
function fakeIo(script: (Error | null)[]) {
  const calls = { rename: 0, unlink: 0, sleeps: [] as number[] };
  const io: RenameIo = {
    rename(_f: string, _t: string) {
      const e = script[calls.rename] ?? null;
      calls.rename++;
      if (e) throw e;
    },
    unlink(_p: string) {
      calls.unlink++;
    },
    sleep(ms: number) {
      calls.sleeps.push(ms);
    },
  };
  return { io, calls };
}

function errWithCode(code: string): Error {
  const e = new Error(code + ": simulated") as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("renameOverwrite", () => {
  test("succeeds first try — no sleep, no unlink", () => {
    const { io, calls } = fakeIo([null]);
    renameOverwrite("a", "b", 8, io);
    expect(calls.rename).toBe(1);
    expect(calls.sleeps).toEqual([]);
    expect(calls.unlink).toBe(0);
  });

  test("retries a transient EPERM and then succeeds", () => {
    const { io, calls } = fakeIo([errWithCode("EPERM"), errWithCode("EPERM"), null]);
    renameOverwrite("a", "b", 8, io);
    expect(calls.rename).toBe(3);
    expect(calls.sleeps).toEqual([5, 10]);
    expect(calls.unlink).toBe(0);
  });

  test("retries EBUSY and EACCES too", () => {
    const { io, calls } = fakeIo([errWithCode("EBUSY"), errWithCode("EACCES"), null]);
    renameOverwrite("a", "b", 8, io);
    expect(calls.rename).toBe(3);
    expect(calls.sleeps).toEqual([5, 10]);
  });

  test("gives up after the attempt budget, rethrows the original error, removes the temp", () => {
    const script = Array.from({ length: 8 }, () => errWithCode("EPERM"));
    const { io, calls } = fakeIo(script);
    // The ORIGINAL error must come back out — not a cleanup error, not a wrapper.
    let thrown: NodeJS.ErrnoException | null = null;
    try {
      renameOverwrite("a", "b", 8, io);
    } catch (e) {
      thrown = e as NodeJS.ErrnoException;
    }
    expect(thrown?.code).toBe("EPERM");
    expect(calls.rename).toBe(8);
    expect(calls.sleeps).toEqual([5, 10, 15, 20, 25, 30, 35]);
    expect(calls.unlink).toBe(1);
  });

  test("does not retry a non-retryable error", () => {
    const { io, calls } = fakeIo([errWithCode("ENOENT")]);
    expect(() => renameOverwrite("a", "b", 8, io)).toThrow();
    expect(calls.rename).toBe(1);
    expect(calls.sleeps).toEqual([]);
    expect(calls.unlink).toBe(1);
  });

  test("honours a custom attempts count", () => {
    const { io, calls } = fakeIo([errWithCode("EPERM"), errWithCode("EPERM"), errWithCode("EPERM")]);
    expect(() => renameOverwrite("a", "b", 3, io)).toThrow();
    expect(calls.rename).toBe(3);
    expect(calls.sleeps).toEqual([5, 10]);
  });

  test("replaces an existing destination through the real filesystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-fs-atomic-"));
    const src = join(dir, "src.txt");
    const dst = join(dir, "dst.txt");
    writeFileSync(src, "new");
    writeFileSync(dst, "old");

    renameOverwrite(src, dst);

    expect(readFileSync(dst, "utf-8")).toBe("new");
    expect(existsSync(src)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sleepSync", () => {
  test("blocks for at least the requested time", () => {
    const t = Date.now();
    sleepSync(20);
    expect(Date.now() - t).toBeGreaterThanOrEqual(15);
  });
});

