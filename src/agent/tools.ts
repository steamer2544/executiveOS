// The agent's tool registry (Phase 35).
//
// Every tool is a thin wrapper over code that already exists — buildState, buildDigest,
// read, runSynth, applyChangeSet, decideProposal. No derivation, git or LLM logic lives
// here; this file is the adapter between a language model and the runtime.
//
// Path safety lives here too, because every filesystem-touching tool must go through
// the same gate. See resolveSafePath().

import { existsSync, readFileSync, statSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, join, extname, dirname, basename } from "node:path";

import type { AgentTool, ToolContext, ToolResult } from "./types.js";
import type { Config } from "../config.js";
import type { EventSource } from "../events/types.js";

import { buildState, writeState } from "../state/builder.js";
import { buildDigest, renderDigest } from "../report/digest.js";
import { tail, append } from "../events/store.js";
import { readNotifications } from "../report/notify.js";
import { readStore, pending } from "../advisor/store.js";
import { explainPatterns } from "../advisor/anthropic.js";
import { classifyCommand } from "./command-guard.js";

// ─── Limits ───────────────────────────────────────────────────────────────────

const MAX_TAIL = 100;
const MAX_GREP_HITS = 100;
const MAX_GREP_FILES = 4000;
const MAX_TOOL_OUTPUT = 20000; // chars handed to the model, per call
const DEFAULT_FILE_BYTES = 64 * 1024;

/** Directory names never walked or read, regardless of roots. */
const DENY_SEGMENTS = new Set([
  ".git", ".executive", "node_modules",
  ".ssh", ".aws", ".gnupg", ".gpg", // secret-bearing directories
]);

/**
 * Final-segment file names that hold secrets — never handed to the model, even
 * inside an allowed root. read_file/edit_files reach every discovered repo now
 * (Phase 37), so a `.env` in any of them is one prompt-injection away from being
 * echoed into a reply, the conversation log, or a Discord DM. grep already skips
 * dotfiles; this closes the same door for the path-based tools.
 */
function isSecretFile(name: string): boolean {
  const n = name.toLowerCase();
  // .env / .env.local / .env.production — but NOT the committed templates.
  if (n === ".env") return true;
  if (n.startsWith(".env.") && !/\.(example|sample|template|dist)$/.test(n)) return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(n)) return true;
  return [".npmrc", ".pgpass", ".netrc", ".htpasswd", "credentials", "id_rsa",
    "id_dsa", "id_ecdsa", "id_ed25519"].includes(n);
}

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
  // The target file itself must not be a secret (the last segment).
  const leaf = segments[segments.length - 1];
  if (leaf !== undefined && isSecretFile(leaf)) return null;

  for (const root of roots) {
    const candidate = resolve(root, segments.join(sep));
    // Defence in depth: the resolved path must still be inside the root.
    const rel = relative(resolve(root), candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * File types Windows executes on a double-click.
 *
 * A guardrail in code, not config — `agent.fileOutput.allowExecutable` decides whether the
 * gate applies, but the LIST is not owner-editable, for the same reason the run_command
 * denylist is not (Phase 38): a confused model that can drop a `.bat` on the Desktop has
 * turned "write me a calculator" into "run arbitrary code next time you click something".
 * `.js`/`.vbs` are here because Windows Script Host runs them directly; a `.js` meant for a
 * project belongs in a repo (edit_files), not loose on the Desktop.
 */
export const EXECUTABLE_EXT = new Set([
  "exe", "com", "scr", "msi", "msp", "cpl", "dll",
  "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "reg", "lnk", "hta", "pif", "jar", "msc",
]);

/** The file's extension, lowercased, or "" when it has none. */
export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * Resolve a path for a file the agent is about to CREATE inside one of `dirs`.
 *
 * **Only a file name survives — every directory component is dropped.** The model reliably
 * prefixes the destination it was asked for ("Desktop/calculator.html"), which produced a
 * nested `เดสก์ท็อป\Desktop\calculator.html` twice in live testing. Matching that prefix
 * against the folder's own name does not work either: the owner's Desktop is literally named
 * `เดสก์ท็อป`, while the model says "Desktop" — any alias table for that is guesswork in every
 * language. Since this tool exists to drop ONE finished file where the owner will see it, a
 * subfolder buys nothing and costs a whole class of confusion. The resolved path is echoed in
 * both the confirm preview and the tool result, so what actually happened is never hidden.
 *
 * Same rejections as `resolveSafePath` — absolute paths, drive letters, `..`, deny-listed
 * segments, secret names — but the target is NOT required to exist, because the whole point
 * is to write something new. Returns null when the name is not allowed.
 */
export function resolveOutputPath(p: string, dirs: string[]): string | null {
  if (typeof p !== "string" || p.trim() === "") return null;
  const raw = p.trim().replace(/\\/g, "/");
  if (raw.startsWith("//")) return null;

  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  if (segments.some((s) => DENY_SEGMENTS.has(s))) return null;

  // Flatten to the file name. A drive letter or leading slash is already gone with the
  // directory part, but re-check the name itself rather than assuming that.
  const leaf = segments[segments.length - 1];
  if (!leaf || !isSafeName(leaf) || /^[a-zA-Z]:/.test(leaf) || isSecretFile(leaf)) return null;

  for (const dir of dirs) {
    if (typeof dir !== "string" || dir.trim() === "") continue;
    const root = resolve(dir);
    const candidate = resolve(root, leaf);
    const rel = relative(root, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    return candidate;
  }
  return null;
}

/**
 * A path that does not collide with an existing file: `note.txt` → `note-2.txt` → `note-3.txt`.
 * Used when overwriting is off, so a name clash costs the owner nothing instead of destroying
 * a file that (unlike a repo edit) has no git history to recover it from.
 */
export function nextFreePath(target: string): string {
  if (!existsSync(target)) return target;
  const dir = dirname(target);
  const base = basename(target);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = join(dir, `${stem}-${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

/** A single, safe path segment: no separators, no `..`, no drive letter, not a deny name. */
function isSafeName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (/[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return false;
  return !DENY_SEGMENTS.has(name);
}

/** Is `dir` a git repository (has a .git entry)? */
function isGitRepo(dir: string): boolean {
  try {
    return existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}

/**
 * Discover git repos under the configured search roots, up to 2 levels deep.
 *
 * This is what lets the owner say "look at opm-be" without registering it: a
 * search root like `C:/Users/.../source/repos` is scanned for child folders that
 * are git repos. Bounded (depth ≤ 2, ignored dirs skipped) so it stays cheap.
 * Returns name → absolute path; a name that collides keeps the first seen.
 */
export function discoverRepos(config: Config): Map<string, string> {
  const found = new Map<string, string>();
  const roots = (config.agent?.repoSearchRoots ?? []).filter(
    (r) => typeof r === "string" && r.trim() !== ""
  );

  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || DENY_SEGMENTS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (isGitRepo(full)) {
        if (!found.has(entry.name)) found.set(entry.name, resolve(full));
        continue; // do not descend into a repo
      }
      walk(full, depth + 1); // an intermediate folder — look one level deeper
    }
  };

  for (const root of roots) {
    const abs = resolve(root);
    // The root itself may be a repo (e.g. a search root pointed straight at one).
    if (isGitRepo(abs)) {
      const base = abs.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
      if (base && !found.has(base)) found.set(base, abs);
    }
    walk(abs, 1);
  }
  return found;
}

/**
 * Resolve a repo name to its root.
 *
 * When NO name is given, defaults to the first configured root. When a name IS
 * given, it is looked up in (1) the registered watch.repos, then (2) discovered
 * repos under the configured search roots. A name that matches nothing returns
 * `null` — the caller must fail rather than silently answer about a DIFFERENT
 * repo. (Before this fell back to the default repo, so asking about "opm-be"
 * while it was unknown returned executive's files with `ok:true`, and the agent
 * confidently reported the wrong project.)
 */
export function resolveRepo(name: unknown, ctx: ToolContext): string | null {
  if (typeof name === "string" && name.trim() !== "") {
    const wanted = name.trim();
    const registered = ctx.config.watch?.repos?.find((r) => r.name === wanted);
    if (registered?.path) return registered.path;
    if (!isSafeName(wanted)) return null;
    return discoverRepos(ctx.config).get(wanted) ?? null;
  }
  return ctx.roots[0] ?? process.cwd();
}

/** The repo names the agent can reach (registered + discovered), for a miss message. */
export function repoNames(ctx: ToolContext): string {
  const names = new Set<string>();
  for (const r of ctx.config.watch?.repos ?? []) {
    if (typeof r.name === "string" && r.name.trim() !== "") names.add(r.name);
  }
  for (const n of discoverRepos(ctx.config).keys()) names.add(n);
  return names.size > 0 ? [...names].join(", ") : "(none found — configure agent.repoSearchRoots)";
}

/** Turn a null resolveRepo result into a uniform error string. */
function unknownRepo(name: unknown, ctx: ToolContext): string {
  return `unknown repo "${String(name)}" — configured repos: ${repoNames(ctx)}`;
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
    properties: {
      path: { type: "string", description: "Repo-relative path" },
      repo: { type: "string", description: "Repo name to read from; defaults to searching all repos" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    let roots = ctx.roots;
    if (typeof args.repo === "string" && args.repo.trim() !== "") {
      const repoRoot = resolveRepo(args.repo, ctx);
      if (!repoRoot) return fail(unknownRepo(args.repo, ctx));
      roots = [repoRoot];
    }
    const target = resolveSafePath(String(args.path ?? ""), roots);
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
  ".yaml", ".toml", ".css", ".scss", ".html", ".sh", ".ps1", ".py", ".go", ".rs", ".sql",
  // .NET / other backends the owner works in (opm-be is C#/ASP.NET).
  ".cs", ".csproj", ".cshtml", ".razor", ".vb", ".fs", ".fsproj", ".sln", ".props",
  ".xml", ".config", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cpp", ".hpp",
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
      repo: { type: "string", description: "Repo name to search in; defaults to all repos" },
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
    if (typeof args.repo === "string" && args.repo.trim() !== "") {
      const repoRoot = resolveRepo(args.repo, ctx);
      if (!repoRoot) return fail(unknownRepo(args.repo, ctx));
      searchRoots = [repoRoot];
    }
    if (typeof args.dir === "string" && args.dir.trim() !== "") {
      const d = resolveSafePath(args.dir, searchRoots);
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
    if (!cwd) return fail(unknownRepo(args.repo, ctx));
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
    if (!cwd) return fail(unknownRepo(args.repo, ctx));
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

const listRepos: AgentTool = {
  name: "list_repos",
  description:
    "List the repositories the agent can look at — both the ones registered for watching and " +
    "any discovered under the owner's configured search roots. Use this to find the right repo " +
    "name before reading files, grepping, or checking git in a project other than the current one.",
  kind: "read",
  inputSchema: { type: "object", properties: {}, required: [] },
  async run(_args, ctx) {
    const registered = new Map<string, string>();
    for (const r of ctx.config.watch?.repos ?? []) {
      if (typeof r.name === "string" && r.name.trim() !== "" && r.path) {
        registered.set(r.name, r.path);
      }
    }
    const discovered = discoverRepos(ctx.config);
    const rows: Array<{ name: string; path: string; source: string }> = [];
    for (const [name, path] of registered) rows.push({ name, path, source: "watched" });
    for (const [name, path] of discovered) {
      if (!registered.has(name)) rows.push({ name, path, source: "discovered" });
    }
    if (rows.length === 0) {
      return ok(
        "no repos registered or discoverable. The current directory is the only root; " +
          "set agent.repoSearchRoots to let me find other projects by name."
      );
    }
    return ok(asJson(rows));
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
    // Security boundary (Phase 38): a destructive command is refused HERE and never spawns,
    // even though the owner already confirmed it. The denylist lives in code, not config.
    const verdict = classifyCommand(cmd, ctx.config);
    if (verdict.decision === "deny") {
      return fail(`คำสั่งนี้ถูกปฏิเสธ (${verdict.reason}) — ดูอันตราย ถ้าจำเป็นให้ owner รันเอง`);
    }
    const cwd = resolveRepo(args.repo, ctx);
    if (!cwd) return fail(unknownRepo(args.repo, ctx));
    const timeout = ctx.config.agent?.commandTimeoutMs ?? 60000;
    try {
      const proc = Bun.spawnSync(shellFor(cmd), {
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
    if (!repoRoot) return fail(unknownRepo(args.repo, ctx));

    // Reject unsafe file hints before anything runs. The synthesized ChangeSet is
    // validated again by the Executor — this is the earlier of two gates, not the only one.
    let explicitFiles: string[] | undefined;
    if (Array.isArray(args.files) && args.files.length > 0) {
      explicitFiles = [];
      for (const f of args.files) {
        // `resolveSafePath` requires the file to EXIST — right for reading, wrong here:
        // "add pong.html" names a file that does not exist yet, and every such request was
        // rejected with "file not allowed or not found" (5 times in one live turn). Use the
        // create-path resolver for containment, then keep only the ones already on disk as
        // context for the synthesizer; a new file needs no context.
        const safe = resolveNewRepoPath(String(f), repoRoot);
        if (!safe) return fail(`file not allowed: ${String(f)}`);
        if (existsSync(safe)) explicitFiles.push(relative(repoRoot, safe).replace(/\\/g, "/"));
      }
      // All named files are new → let the synthesizer pick its own context.
      if (explicitFiles.length === 0) explicitFiles = undefined;
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
      // Spell out where the files ARE and how to get them out. The model once read
      // "committed to branch …" and told the owner to open the file "in the project
      // folder" — where it does not exist, because the working tree is never touched.
      // Giving it the correct sentence to say is cheaper than hoping it infers one.
      const written = (cs.ops ?? [])
        .map((o: { path?: string }) => o.path)
        .filter((p: unknown): p is string => typeof p === "string");
      const first = written[0] ?? "<file>";
      return ok(
        `committed to branch ${exec.branch} (tests: ${
          exec.testPassed === null ? "not run" : exec.testPassed ? "passed" : "FAILED"
        }).\n` +
          `Files: ${written.join(", ") || "(none listed)"}\n` +
          `IMPORTANT — these files are ONLY on that branch. They are NOT in the working ` +
          `tree, NOT in the project folder as it currently looks, and NOT on the Desktop. ` +
          `Tell the owner exactly this, and give them the way out:\n` +
          `  review:  git diff main..${exec.branch}\n` +
          `  copy out: git show ${exec.branch}:${first} > <where they want it>\n` +
          `  discard: git branch -D ${exec.branch}`
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

/**
 * Contain a repo-relative path that may not exist yet.
 *
 * `resolveSafePath` is the read gate and insists the target is on disk; a file the agent is
 * being asked to CREATE has no disk presence, so it needs the same containment without the
 * existence test. Unlike `resolveOutputPath` this keeps subdirectories — a repo change
 * genuinely lands in `src/…`. Returns null when the path is not allowed.
 */
export function resolveNewRepoPath(p: string, repoRoot: string): string | null {
  if (typeof p !== "string" || p.trim() === "") return null;
  const raw = p.trim().replace(/\\/g, "/");
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("//")) return null;

  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "..")) return null;
  if (segments.some((s) => DENY_SEGMENTS.has(s))) return null;
  const leaf = segments[segments.length - 1]!;
  if (!isSafeName(leaf) || isSecretFile(leaf)) return null;

  const root = resolve(repoRoot);
  const candidate = resolve(root, segments.join(sep));
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

/**
 * The argv that runs `cmd` through a shell that actually exists here.
 *
 * `sh -c` was hardcoded, so on Windows every `run_command` died with
 * `Executable not found in $PATH: "sh"` — and only when the daemon was started from
 * PowerShell. Launched from Git Bash `sh` IS on PATH, which is why it worked in testing
 * and failed for the owner: the same code, the same machine, a different parent shell.
 * `cmd.exe` is always present on Windows, so prefer it there and keep `sh` elsewhere.
 */
export function shellFor(cmd: string): string[] {
  return process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", cmd] : ["sh", "-c", cmd];
}

/** The configured output directories, cleaned. Empty = `save_file` is unavailable. */
export function outputDirs(config: Config): string[] {
  return (config.agent?.fileOutput?.dirs ?? []).filter(
    (d) => typeof d === "string" && d.trim() !== ""
  );
}

/**
 * Write a file somewhere the owner can actually see it — the Desktop, a scratch folder.
 *
 * The one agent write with **no git safety net**: `edit_files` lands on an isolated branch
 * that `git branch -D` erases, but this is a real file on a real disk. So it is fenced on
 * four sides, and three of the four are not owner-configurable:
 *   • it can only write inside `agent.fileOutput.dirs` (empty ⇒ the tool refuses outright);
 *   • the path is contained — no `..`, no absolute path, no `.git`/`.executive`, no secrets;
 *   • executable file types are refused unless the owner turned that on;
 *   • an existing file is renamed-around unless the owner turned overwriting on.
 * It is a `write` tool, so it is confirmed every time, and NEVER_TRUSTABLE, so "trust this
 * forever" can never apply to it.
 */
const saveFile: AgentTool = {
  name: "save_file",
  description:
    "Save a file where the owner can open it (e.g. their Desktop) — use for a standalone " +
    "deliverable like an HTML page, a note or a CSV. NOT for changing a project's code: " +
    "that is edit_files. Fails if no output directory is configured.",
  kind: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Just the file name, e.g. 'calculator.html'. It is saved into the owner's " +
          "configured output folder — do NOT include that folder in the path, and never " +
          "use an absolute path.",
      },
      content: { type: "string", description: "The complete file contents" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const dirs = outputDirs(ctx.config);
    if (dirs.length === 0) {
      return fail(
        "no output directory is configured — the owner must add one under Settings → " +
          "File output (agent.fileOutput.dirs) before I can save files outside a repo"
      );
    }

    const rel = String(args.path ?? "").trim();
    const content = typeof args.content === "string" ? args.content : "";
    if (!rel) return fail("path is required");

    const target = resolveOutputPath(rel, dirs);
    if (!target) return fail(`path not allowed: ${rel}`);

    const ext = fileExt(basename(target));
    if (EXECUTABLE_EXT.has(ext) && ctx.config.agent?.fileOutput?.allowExecutable !== true) {
      return fail(
        `refusing to write a .${ext} file — Windows runs that type on a double-click. ` +
          "Ask for a non-executable format (.html/.txt/.md/.csv), or have the owner turn on " +
          "Settings → File output → allow executable files."
      );
    }

    const overwrite = ctx.config.agent?.fileOutput?.allowOverwrite === true;
    const existed = existsSync(target);
    const finalPath = overwrite ? target : nextFreePath(target);

    try {
      // Do NOT mkdir the output folder. It is configured by the owner and already exists,
      // and creating it is not this tool's job — while `mkdirSync(recursive:true)` threw
      // `EEXIST … mkdir 'C:\…\เดสก์ท็อป'` on the owner's real Desktop (a OneDrive-backed
      // folder, where the recursive path walk mis-handles the reparse point). The file
      // never got written and the model reported success anyway.
      const dir = dirname(finalPath);
      if (!existsSync(dir)) {
        return fail(`output folder does not exist: ${dir}`);
      }
      writeFileSync(finalPath, content, "utf-8");
    } catch (e) {
      return fail(`could not write ${finalPath}: ${(e as Error).message}`);
    }

    const note =
      existed && !overwrite
        ? ` (a file of that name already existed and was left alone — saved alongside it)`
        : existed
          ? ` (replaced the existing file)`
          : "";
    return ok(
      `saved ${content.length} characters to:\n${finalPath}${note}\n` +
        "Tell the owner this exact path."
    );
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const READ_TOOLS: AgentTool[] = [
  getState,
  getDigest,
  tailEvents,
  readFileTool,
  grepTool,
  gitLog,
  gitStatus,
  listRepos,
  listProposals,
  listNotifications,
];

export const WRITE_TOOLS: AgentTool[] = [
  emitEvent,
  editFiles,
  saveFile,
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
export function previewWrite(
  name: string,
  args: Record<string, unknown>,
  config?: Config
): string {
  switch (name) {
    case "emit_event":
      return `บันทึก ${String(args.type)} — ${JSON.stringify(args.data ?? {})}`;
    case "run_command": {
      const base = `รันคำสั่ง: ${String(args.cmd)}${args.repo ? ` (ใน ${String(args.repo)})` : ""}`;
      // Show the classifier's verdict up front so the owner is not surprised by a refusal.
      const v = classifyCommand(String(args.cmd ?? ""), config);
      if (v.decision === "deny") return `⛔ ${base} — จะถูกปฏิเสธ (${v.reason})`;
      if (v.decision === "allow") return `✓ known-safe · ${base}`;
      return base;
    }
    case "edit_files":
      return `แก้โค้ด: ${String(args.instruction)} — จะ commit ลง branch แยก ไม่แตะ branch ที่ทำงานอยู่`;
    case "save_file": {
      // The owner is approving a real file on a real disk — show the resolved path, and
      // say up front when it will be refused or when their existing file is at stake.
      const rel = String(args.path ?? "");
      const dirs = outputDirs(config ?? ({} as Config));
      if (dirs.length === 0) return `⛔ บันทึกไฟล์ ${rel} — ยังไม่ได้ตั้งโฟลเดอร์ปลายทาง`;
      const target = resolveOutputPath(rel, dirs);
      if (!target) return `⛔ บันทึกไฟล์ ${rel} — path ไม่ผ่านการตรวจ`;
      const ext = fileExt(basename(target));
      if (EXECUTABLE_EXT.has(ext) && config?.agent?.fileOutput?.allowExecutable !== true) {
        return `⛔ บันทึก ${target} — .${ext} เป็นไฟล์ที่ดับเบิลคลิกแล้วรัน (ปิดอยู่)`;
      }
      const size = typeof args.content === "string" ? args.content.length : 0;
      if (existsSync(target)) {
        return config?.agent?.fileOutput?.allowOverwrite === true
          ? `⚠️ เขียนทับไฟล์เดิม: ${target} (${size} ตัวอักษร)`
          : `บันทึก ${size} ตัวอักษร — มีไฟล์ชื่อนี้อยู่แล้ว จะเซฟเป็น ${nextFreePath(target)} แทน`;
      }
      return `บันทึกไฟล์ ${size} ตัวอักษร → ${target}`;
    }
    case "approve_proposal":
      return `อนุมัติข้อเสนอ ${String(args.id)}`;
    case "dismiss_proposal":
      return `ปัดข้อเสนอ ${String(args.id)} ทิ้ง`;
    default:
      return `${name} ${JSON.stringify(args)}`;
  }
}
