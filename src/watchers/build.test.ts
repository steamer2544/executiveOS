import { describe, it, expect } from "bun:test";
import type { Config } from "../config.js";
import { buildWatchers } from "./build.js";

describe("buildWatchers", () => {
  it("legacy path: returns 2 watchers (git + fs) with activeNames [git, fs]", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: { git: {}, fs: {} },
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(2);
    expect(result.activeNames).toEqual(["git", "fs"]);
  });

  it("legacy path respects enabled:false for git", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: { git: { enabled: false }, fs: {} },
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(1);
    expect(result.activeNames).toEqual(["fs"]);
    expect(result.watchers[0]!.name).toBe("fs");
  });

  it("legacy path respects enabled:false for fs", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: { git: {}, fs: { enabled: false } },
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(1);
    expect(result.activeNames).toEqual(["git"]);
    expect(result.watchers[0]!.name).toBe("git");
  });

  it("legacy path: both disabled yields empty watchers", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: { git: { enabled: false }, fs: { enabled: false } },
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(0);
    expect(result.activeNames).toEqual([]);
  });

  it("multi-repo path: git+fs for first entry, git-only for second (watchFiles:false)", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: {
        git: {},
        fs: {},
        repos: [
          {
            path: "/home/user/project-a",
            name: "project-a",
            pollMs: 5000,
            watchFiles: true,
            filePaths: ["/home/user/project-a/src"],
            fileDebounceMs: 300,
          },
          {
            path: "/home/user/project-b",
            name: "project-b",
            pollMs: 10000,
            watchFiles: false,
            filePaths: [],
            fileDebounceMs: 500,
          },
        ],
      },
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(3);
    expect(result.activeNames).toEqual(["git:project-a", "fs:project-a", "git:project-b"]);

    // Verify watcher names are correct
    expect(result.watchers[0]!.name).toBe("git");
    expect(result.watchers[1]!.name).toBe("fs");
    expect(result.watchers[2]!.name).toBe("git");
  });

  it("multi-repo path: no legacy watchers included when repos is non-empty", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: {
        git: {},
        fs: {},
        repos: [
          {
            path: "/home/user/repo",
            name: "repo",
            pollMs: 5000,
            watchFiles: true,
            filePaths: ["/home/user/repo/src"],
            fileDebounceMs: 300,
          },
        ],
      },
    };
    const result = buildWatchers(config);
    // Only the multi-repo entry — no legacy git/fs watchers
    expect(result.watchers).toHaveLength(2);
    expect(result.activeNames).toEqual(["git:repo", "fs:repo"]);
  });

  it("empty repos array falls back to legacy path", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
      watch: { git: {}, fs: {}, repos: [] },
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(2);
    expect(result.activeNames).toEqual(["git", "fs"]);
  });

  it("no watch block at all: returns empty watchers", () => {
    const config: Config = {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      timezone: "Asia/Bangkok",
    };
    const result = buildWatchers(config);
    expect(result.watchers).toHaveLength(0);
    expect(result.activeNames).toEqual([]);
  });
});
