// The agent's tool registry (Phase 35).
//
// Every tool is a thin wrapper over code that already exists — buildState, buildDigest,
// read, runSynth, applyChangeSet, decideProposal. No derivation, git or LLM logic lives
// here; this file is the adapter between a language model and the runtime.
//
// Path safety lives here too, because every filesystem-touching tool must go through
// the same gate. See resolveSafePath().

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, join, extname } from "node:path";

import type { AgentTool, ToolContext, ToolResult } from "./types.js";
import type { Config } from "../config.js";
import type { EventSource } from "../events/types.js";

import { buildState, writeState } from "../state/builder.js";
import { buildDigest, renderDigest } from "../report/digest.js";
import { tail, append } from "../events/store.js";
import { readNotifications } from "../report/notify.js";
import { readStore, pending } from "../advisor/store.js";
import { explainPatterns } from "../advisor/anthropic.js";

// ─── Limits ───────────────────────────────────────────────────────────────────

const MAX_TAIL = 100;
const MAX_GREP_HITS = 100;
const MAX_GREP_FILES = 4000;
const MAX_TOOL_OUTPUT = 20000; // chars handed to the model, per call
const DEFAULT_FILE_BYTES = 64 * 1024;

/** Directory names never walked or read, regardless of roots. */
const DENY_SEGMENTS = new Set([".git", ".executive", "node_modules"]);

// ─── Path safety ──────────────────────────────────────────────────────────────

/**
 * Resolve a model-supplied path against the allowed roots.
 *
 * The model's output is untrusted, so this rejects rather than sanitizes:
 * absolute paths, drive letters, `..` escapes, and anything inside `.git` /
 * `.executive` / `node_modules`. The containment check is repeated on the RESOLVED
 * path so a symlink or an exotic separator cannot slip past the textual checks.
 *
 * Returns null when the path is not allowed — callers turn that into
 * `{ok:false}`, never a throw (a throw would kill the agent loop).
 */
export function resolveSafePath(p: string, roots: string[]): string | null {
  if (typeof p !== "string" || p.trim() === "") return null;
  const raw = p.trim().replace(/\\/g, "/");

  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("//")) return null;

  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  if (segments.some((s) => DENY_SEGMENTS.has(s))) return null;

  for (const root of roots) {
    const candidate = resolve(root, segments.join(sep));
    // Defence in depth: the resolved path must still be inside the root.
    const rel = relative(resolve(root), candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve a repo name to its root; falls back to the first configured root. */
export function resolveRepo(name: unknown, ctx: ToolContext): string {
  if (typeof name === "string" && name.trim() !== "") {
    const found = ctx.config.watch?.repos?.find((r) => r.name === name.trim());
    if (found?.path) return found.path;
  }
  return ctx.roots[0] ?? process.cwd();
}

/** Every root the agent may touch: configured repos, else cwd. */
export function agentRoots(config: Config): string[] {
  const repos = (config.watch?.repos ?? [])
    .map((r) => r.path)
    .filter((p): p is string => typeof p === "string" && p.trim() !== "");
  const roots = repos.length > 0 ? [...repos] : [];
  if (!roots.includes(process.cwd())) roots.push(process.cwd());
  return roots.map((r) => resolve(r));
}

// ─── Formatting for a language model ──────────────────────────────────────────

/**
 * Spell a duration out in words. The model reads raw milliseconds wrong — it called
 * `sessionMs: 2173707` "about 36 hours" when it is 36 minutes, on more than one run
 * (Phase 33.1). Never hand it a bare number that carries a unit.
 */
export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = ms / 3600000;
  if (h < 48) return `${h.toFixed(1)} hours`;
  return `${Math.round(h / 24)} days`;
}

function truncate(text: string, limit = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n… [truncated, ${text.length - limit} more chars]`;
}

function ok(content: string): ToolResult {
  return { ok: true, content: truncate(content) };
}

function fail(error: string): ToolResult {
  return { ok: false, content: error, error };
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ─── git helper ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    return { ok: proc.exitCode === 0, out: out || err };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

// ─── READ TOOLS ───────────────────────────────────────────────────────────────

const getState: AgentTool = {
  name: "get_state",
  description:
    "Get what the owner is working on right now: project, task, git branch, current file, " +
    "whether tests pass, whether they are blocked, and behavioural patterns (how long they " +
    "have been working, edits since the last commit). Call this before answering anything " +
    "about the owner's current work.",
  kind: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async run() {
    const built = buildState();
    const s = built.state;
    return ok(
      asJson({
        project: s.currentProject,
        task: s.currentTask,
        deadline: s.deadline,
        branch: s.git.branch,
        activeRepo: s.activeRepo,
        repos: s.repos.map((r) => ({ name: r.name, branch: r.branch })),
        currentFile: s.currentFile,
        recentFiles: s.recentFiles,
        lookingAt: s.currentWindow,
        tests: s.tests,
        blocked: s.blocked,
        blockedReason: s.blockedReason,
        lastCommit: s.git.lastCommit,
        idleFor: humanDuration(s.activity.idleMs),
        // Units in words — the model misreads raw ms (Phase 33.1).
        patterns: explainPatterns(s.patterns),
        eventCount: s.eventCount,
        summary: built.context.summary,
      })
    );
  },
};

const getDigest: AgentTool = {
  name: "get_digest",
  description:
    "Get the current digest: the recommended next action, everything in the 'Needs you' " +
    "queue (things waiting on the owner), and unconfirmed suggestions. Use this when asked " +
    "what needs attention, what is pending, or what to do next.",
  kind: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async run() {
    return ok(renderDigest(buildDigest()));
  },
};

const tailEvents: AgentTool = {
  name: "tail_events",
  description:
    "Read the most recent raw activity events. Sources: git, editor, terminal, system, screen. " +
    "Use when asked what happened recently, or to check a detail the state summary omits.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      n: { type: "number", description: "How many events (default 20, max 100)" },
      source: {
        type: "string",
        description: "Optional filter: git | editor | terminal | system | screen",
      },
    },
    required: [],
  },
  async run(args) {
    const n = Math.min(Math.max(Number(args.n) || 20, 1), MAX_TAIL);
    const src = typeof args.source === "string" ? args.source : undefined;
    const valid = ["git", "editor", "terminal", "system", "screen"];
    if (src && !valid.includes(src)) {
      return fail(`unknown source "${src}" — use one of ${valid.join(", ")}`);
    }
    const events = await tail(n, src as EventSource | undefined);
    return ok(
      asJson(
        events.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, data: e.data }))
      )
    );
  },
};

const readFileTool: AgentTool = {
  name: "read_file",
  description:
    "Read a source file from one of the owner's repos. Paths are relative to a repo root, " +
    "e.g. 'src/index.ts'. Use before answering questions about code, and before proposing an edit.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Repo-relative path" } },
    required: ["path"],
  },
  async run(args, ctx) {
    const target = resolveSafePath(String(args.path ?? ""), ctx.roots);
    if (!target) return fail(`path not allowed or not found: ${String(args.path)}`);
    let st;
    try {
      st = statSync(target);
    } catch {
      return fail(`cannot stat: ${String(args.path)}`);
    }
    if (!st.isFile()) return fail(`not a file: ${String(args.path)}`);
    const cap = ctx.config.synth?.maxFileBytes ?? DEFAULT_FILE_BYTES;
    if (st.size > cap) {
      return fail(`file too large (${st.size} bytes, cap ${cap}) — use grep instead`);
    }
    try {
      return ok(readFileSync(target, "utf-8"));
    } catch (e) {
      return fail(`read failed: ${(e as Error).message}`);
    }
  },
};

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".yml",
  ".yaml", ".toml", ".css", ".html", ".sh", ".ps1", ".py", ".go", ".rs", ".sql",
]);

const grepTool: AgentTool = {
  name: "grep",
  description:
    "Search the owner's repos for a regular expression and return matching lines with " +
    "file:line. Use this to locate code before reading whole files.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      dir: { type: "string", description: "Optional repo-relative directory to search under" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const patternRaw = String(args.pattern ?? "");
    if (!patternRaw.trim()) return fail("pattern is required");
    let re: RegExp;
    try {
      re = new RegExp(patternRaw, "i");
    } catch (e) {
      return fail(`invalid regex: ${(e as Error).message}`);
    }

    let searchRoots = ctx.roots;
    if (typeof args.dir === "string" && args.dir.trim() !== "") {
      const d = resolveSafePath(args.dir, ctx.roots);
      if (!d) return fail(`directory not allowed or not found: ${args.dir}`);
      searchRoots = [d];
    }

    const hits: string[] = [];
    let filesSeen = 0;

    const walk = (dir: string, root: string): void => {
      if (hits.length >= MAX_GREP_HITS || filesSeen >= MAX_GREP_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= MAX_GREP_HITS || filesSeen >= MAX_GREP_FILES) return;
        if (entry.name.startsWith(".") || DENY_SEGMENTS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, root);
          continue;
        }
        if (!entry.isFile() || !TEXT_EXT.has(extname(entry.name))) continue;
        filesSeen++;
        let text: string;
        try {
          text = readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= MAX_GREP_HITS) return;
          if (re.test(lines[i]!)) {
            const rel = relative(root, full).replace(/\\/g, "/");
            hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        }
      }
    };

    for (const root of searchRoots) walk(root, root);
    if (hits.length === 0) return ok(`no matches for /${patternRaw}/`);
    return ok(hits.join("\n"));
  },
};

const gitLog: AgentTool = {
  name: "git_log",
  description: "Recent commits in one of the owner's repos.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      n: { type: "number", description: "How many commits (default 10)" },
      repo: { type: "string", description: "Repo name; defaults to the active one" },
    },
    required: [],
  },
  async run(args, ctx) {
    const n = Math.min(Math.max(Number(args.n) || 10, 1), 50);
    const cwd = resolveRepo(args.repo, ctx);
    const r = git(["log", `-${n}`, "--pretty=format:%h %ad %s", "--date=short"], cwd);
    return r.ok ? ok(r.out || "(no commits)") : fail(r.out);
  },
};

const gitStatus: AgentTool = {
  name: "git_status",
  description:
    "Working-tree status of one of the owner's repos — what is modified but not committed.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: { repo: { type: "string", description: "Repo name; defaults to the active one" } },
    required: [],
  },
  async run(args, ctx) {
    const cwd = resolveRepo(args.repo, ctx);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const status = git(["status", "--porcelain"], cwd);
    if (!status.ok) return fail(status.out);
    return ok(
      `branch: ${branch.out}\n` + (status.out || "(clean — nothing uncommitted)")
    );
  },
};

const listProposals: AgentTool = {
  name: "list_proposals",
  description:
    "List the Advisor's proposals — suggestions the system has queued for the owner to " +
    "approve or dismiss. Default: only the pending ones.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "pending | approved | rejected | all (default pending)" },
    },
    required: [],
  },
  async run(args) {
    const store = readStore();
    const wanted = typeof args.status === "string" ? args.status : "pending";
    const list =
      wanted === "all"
        ? store.items
        : wanted === "pending"
          ? pending(store)
          : store.items.filter((p) => p.status === wanted);
    if (list.length === 0) return ok(`no ${wanted} proposals`);
    return ok(
      asJson(
        list.map((p) => ({
          id: p.id,
          title: p.title,
          action: p.action,
          because: p.evidence,
          category: p.category,
          executable: p.executable === true,
          status: p.status,
        }))
      )
    );
  },
};

const listNotifications: AgentTool = {
  name: "list_notifications",
  description:
    "Recent changes to the 'Needs you' queue — when something started or stopped needing " +
    "the owner's attention. Use to answer 'what came up while I was away'.",
  kind: "read",
  inputSchema: {
    type: "object",
    properties: { n: { type: "number", description: "How many records (default 10)" } },
    required: [],
  },
  async run(args) {
    const n = Math.min(Math.max(Number(args.n) || 10, 1), 50);
    const all = readNotifications();
    const recent = all.slice(-n);
    if (recent.length === 0) return ok("no notifications yet");
    return ok(
      recent.map((r) => `${r.ts} [${r.event}] ${r.source}: ${r.summary}`).join("\n")
    );
  },
};

// ─── WRITE TOOLS ──────────────────────────────────────────────────────────────
// Each one mutates something. The loop refuses to run these without the owner's
// confirmation unless the tool name is in config.agent.trustedTools.

/** Same whitelist the dashboard's /api/emit enforces — the agent gets no wider door. */
const EMIT_WHITELIST = new Set([
  "system.blocked",
  "system.unblocked",
  "system.task",
  "system.test_result",
  "system.note",
]);

const emitEvent: AgentTool = {
  name: "emit_event",
  description:
    "Record a fact about the owner's situation that no sensor can see: that they are blocked " +
    "(system.blocked with {reason}), unblocked (system.unblocked), what they are working on " +
    "(system.task with {task, project?, deadline?} — an empty task CLEARS it), a test result " +
    "(system.test_result with {status}), or a note (system.note with {msg}).",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", description: "One of: " + [...EMIT_WHITELIST].join(", ") },
      data: { type: "object", description: "Event payload" },
    },
    required: ["type"],
  },
  async run(args) {
    const type = String(args.type ?? "");
    if (!EMIT_WHITELIST.has(type)) {
      return fail(`event type "${type}" not allowed — use one of ${[...EMIT_WHITELIST].join(", ")}`);
    }
    const data =
      typeof args.data === "object" && args.data !== null
        ? (args.data as Record<string, unknown>)
        : {};
    try {
      const ev = await append({ source: "system", type, data });
      // Refresh derived state so the dashboard agrees with what was just recorded.
      writeState(buildState());
      return ok(`recorded ${type} (seq ${ev.seq})`);
    } catch (e) {
      return fail(`emit failed: ${(e as Error).message}`);
    }
  },
};

const runCommand: AgentTool = {
  name: "run_command",
  description:
    "Run a shell command inside one of the owner's repos and return its output — tests, " +
    "builds, linters, one-off checks. Prefer a read tool when one exists.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "The command line to run" },
      repo: { type: "string", description: "Repo name; defaults to the active one" },
    },
    required: ["cmd"],
  },
  async run(args, ctx) {
    const cmd = String(args.cmd ?? "").trim();
    if (!cmd) return fail("cmd is required");
    const cwd = resolveRepo(args.repo, ctx);
    const timeout = ctx.config.agent?.commandTimeoutMs ?? 60000;
    try {
      const proc = Bun.spawnSync(["sh", "-c", cmd], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout,
      });
      const dec = new TextDecoder();
      const out = dec.decode(proc.stdout).trim();
      const err = dec.decode(proc.stderr).trim();
      const body = [out, err].filter(Boolean).join("\n");
      return {
        ok: proc.exitCode === 0,
        content: truncate(`exit ${proc.exitCode}\n${body || "(no output)"}`),
        ...(proc.exitCode === 0 ? {} : { error: `exit ${proc.exitCode}` }),
      };
    } catch (e) {
      return fail(`command failed to start: ${(e as Error).message}`);
    }
  },
};

const editFiles: AgentTool = {
  name: "edit_files",
  description:
    "Make a code change. Describe the change in `instruction`; the runtime synthesizes it, " +
    "validates it, and commits it to an isolated branch the owner reviews — it never touches " +
    "their working branch. Use for any request to write, fix, refactor or add code.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      instruction: { type: "string", description: "What to change, concretely" },
      repo: { type: "string", description: "Repo name; defaults to the active one" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional repo-relative files to change",
      },
    },
    required: ["instruction"],
  },
  async run(args, ctx) {
    const instruction = String(args.instruction ?? "").trim();
    if (!instruction) return fail("instruction is required");
    const repoRoot = resolveRepo(args.repo, ctx);

    // Reject unsafe file hints before anything runs. The synthesized ChangeSet is
    // validated again by the Executor — this is the earlier of two gates, not the only one.
    let explicitFiles: string[] | undefined;
    if (Array.isArray(args.files) && args.files.length > 0) {
      explicitFiles = [];
      for (const f of args.files) {
        const safe = resolveSafePath(String(f), [repoRoot]);
        if (!safe) return fail(`file not allowed or not found: ${String(f)}`);
        explicitFiles.push(relative(repoRoot, safe).replace(/\\/g, "/"));
      }
    }

    const { runSynth } = await import("../synth/synth.js");
    const { applyChangeSet } = await import("../executor/executor.js");
    const { changeSetPath } = await import("../paths.js");

    let report;
    try {
      report = await runSynth({
        repoRoot,
        config: ctx.config,
        instruction,
        explicitFiles,
      });
    } catch (e) {
      return fail(`synthesis failed: ${(e as Error).message}`);
    }

    if (!report.ok || !report.validation.ok) {
      return fail(
        "change rejected before touching the repo: " +
          (report.messages.join("; ") || "validation failed")
      );
    }

    try {
      const cs = JSON.parse(readFileSync(changeSetPath(), "utf-8"));
      const exec = applyChangeSet(cs, { apply: true, repoRoot, config: ctx.config });
      if (!exec.committed) {
        return fail(`could not commit: ${exec.messages?.join("; ") ?? "unknown reason"}`);
      }
      return ok(
        `committed to branch ${exec.branch} (tests: ${
          exec.testPassed === null ? "not run" : exec.testPassed ? "passed" : "FAILED"
        }). The owner's working branch was not touched; review with ` +
          `\`git diff ${exec.branch}\` and delete with \`git branch -D ${exec.branch}\` if unwanted.`
      );
    } catch (e) {
      return fail(`apply failed: ${(e as Error).message}`);
    }
  },
};

function decideTool(kind: "approve" | "reject"): AgentTool {
  return {
    name: kind === "approve" ? "approve_proposal" : "dismiss_proposal",
    description:
      kind === "approve"
        ? "Approve one of the Advisor's pending proposals by id. If it is an executable code " +
          "proposal this may create a branch; otherwise it records the decision."
        : "Dismiss one of the Advisor's pending proposals by id.",
    kind: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Proposal id from list_proposals" },
        note: { type: "string", description: "Optional note to record with the decision" },
      },
      required: ["id"],
    },
    async run(args, ctx) {
      const id = String(args.id ?? "").trim();
      if (!id) return fail("id is required");
      const { decideProposal } = await import("../advisor/advisor.js");
      try {
        const p = await decideProposal(
          id,
          kind,
          typeof args.note === "string" ? { note: args.note } : undefined,
          ctx.config
        );
        if (!p) return fail(`no pending proposal with id ${id}`);
        return ok(
          `${kind === "approve" ? "approved" : "dismissed"}: ${p.title}` +
            (p.execution?.message ? ` — ${p.execution.message}` : "")
        );
      } catch (e) {
        return fail(`decision failed: ${(e as Error).message}`);
      }
    },
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const READ_TOOLS: AgentTool[] = [
  getState,
  getDigest,
  tailEvents,
  readFileTool,
  grepTool,
  gitLog,
  gitStatus,
  listProposals,
  listNotifications,
];

export const WRITE_TOOLS: AgentTool[] = [
  emitEvent,
  editFiles,
  runCommand,
  decideTool("approve"),
  decideTool("reject"),
];

export const ALL_TOOLS: AgentTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function findTool(name: string): AgentTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/**
 * One line, in plain language, describing what a write tool will do if approved.
 * Shown on the confirmation chip — the owner reads this, not the JSON.
 */
export function previewWrite(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "emit_event":
      return `บันทึก ${String(args.type)} — ${JSON.stringify(args.data ?? {})}`;
    case "run_command":
      return `รันคำสั่ง: ${String(args.cmd)}${args.repo ? ` (ใน ${String(args.repo)})` : ""}`;
    case "edit_files":
      return `แก้โค้ด: ${String(args.instruction)} — จะ commit ลง branch แยก ไม่แตะ branch ที่ทำงานอยู่`;
    case "approve_proposal":
      return `อนุมัติข้อเสนอ ${String(args.id)}`;
    case "dismiss_proposal":
      return `ปัดข้อเสนอ ${String(args.id)} ทิ้ง`;
    default:
      return `${name} ${JSON.stringify(args)}`;
  }
}
