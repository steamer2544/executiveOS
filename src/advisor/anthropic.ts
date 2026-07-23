// AnthropicAdvisor — HTTP, Anthropic Messages API (the 9arm gateway shape).
// Asks the LLM to act as a proactive chief of staff and propose a few small,
// reversible actions (work + life) as strict JSON.

import type { Advisor, ProposalDraft } from "./types.js";
import type { Context } from "../state/types.js";

export interface AnthropicAdvisorOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

const SYSTEM_PROMPT =
  "You are a proactive chief of staff. Your job is to reduce the owner's decision fatigue by proposing a\n" +
  "few small, concrete, REVERSIBLE next actions — across BOTH their work and ALL of life (health, admin,\n" +
  "learning, rest, personal upkeep, relationships, money, life-goals). Base them on the recent activity\n" +
  "you are given. Frame them as suggestions for the owner to consider.\n" +
  "Rules:\n" +
  "- Propose at most 3. Each must be small and reversible; the owner will approve or reject each one.\n" +
  "- You MAY propose across all domains including relationships, money, and life-goals.\n" +
  "- GROUNDING (most important): every proposal MUST rest on something specific in the data you were\n" +
  '  given, quoted in the "evidence" field — a file name, a window title, a note the owner captured, a\n' +
  "  number from patterns, a branch, a commit subject. Evidence must be checkable against the input.\n" +
  "- When you quote a duration, use patternsExplained (which states the units). Never convert raw\n" +
  "  millisecond fields yourself, and never state a duration the input does not support.\n" +
  "- Do NOT propose generic self-care or productivity advice that would be true for anyone on any day\n" +
  '  ("drink water", "take a break", "tidy your desk", "review your goals"). If you cannot point to the\n' +
  "  observation that makes a proposal apply to THIS owner RIGHT NOW, do not propose it. A rest\n" +
  "  suggestion is allowed only when you cite the measured session length in patterns.sessionMs.\n" +
  "- Do NOT propose busywork that costs more to review than to do (adding a log line then reverting it,\n" +
  "  renaming one variable, adding a comment). Propose something that changes the owner's day.\n" +
  "- Prefer fewer, better proposals. Returning ONE well-grounded proposal beats three weak ones, and\n" +
  "  returning an empty array [] is correct when nothing in the data warrants a proposal.\n" +
  '- Set "executable": true ONLY for a concrete coding task on the owner\'s codebase that you can describe\n' +
  "  as file changes. When executable is true, also provide \"repo\" (the project/repo name) and optionally\n" +
  '  \"files\". Otherwise set "executable": false.\n' +
  "- Set executable:false for everything else — especially anything about relationships, ethics/morality,\n" +
  "  large spending, or major life-goals. Those are for the owner to act on, never the system.\n" +
  "- Avoid repeating any title in the provided already-open list.\n" +
  "- Keep titles under 8 words; detail to 1-2 sentences; action a single concrete next step.\n" +
  'Respond with ONLY a JSON array, no prose:\n' +
  '[{"category":string,"title":string,"detail":string,"action":string,"evidence":string,' +
  '"executable":bool,"repo"?:string,"files"?:string[]}]';

/** The last N distinct window titles, oldest→newest — what the owner has actually been looking at. */
export function windowHistory(context: Context, limit = 20): Array<{ app: string; title: string }> {
  const out: Array<{ app: string; title: string }> = [];
  for (const e of context.recentEvents) {
    if (e.type !== "screen.window") continue;
    const app = typeof e.data.app === "string" ? e.data.app : null;
    const title = typeof e.data.title === "string" ? e.data.title : null;
    if (!app || !title) continue;
    const prev = out[out.length - 1];
    if (prev && prev.app === app && prev.title === title) continue; // collapse repeats
    out.push({ app, title });
  }
  return out.slice(-limit);
}

/** Render a duration the way a person would say it. */
function humanMs(ms: number | null): string | null {
  if (ms === null) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return mins + " minutes";
  const hours = ms / 3_600_000;
  return hours.toFixed(1) + " hours";
}

/**
 * The same metrics with units spelled out.
 * Live runs showed the model reading `sessionMs: 2173707` and reporting it as
 * "~36 hours" (it is 36 *minutes*) — twice, so it is systematic, not a fluke.
 * Raw milliseconds are an invitation to that mistake; give it the words too.
 */
export function explainPatterns(p: Context["state"]["patterns"]): Record<string, unknown> {
  return {
    sessionLength: humanMs(p?.sessionMs ?? null),
    timeSinceLastCommit: humanMs(p?.msSinceLastCommit ?? null),
    editsSinceLastCommit: p?.editsSinceLastCommit ?? 0,
    savesOfCurrentFileInLast30Min: p?.sameFileSaves30m ?? 0,
    repoSwitchesInLastHour: p?.repoSwitches1h ?? 0,
  };
}

export function buildUserMessage(context: Context, openTitles: string[]): string {
  return JSON.stringify(
    {
      summary: context.summary,
      state: context.state,
      // Behavioural metrics (Phase 33) — the model needs *how* the owner has been
      // working to say anything that isn't horoscope-grade.
      patterns: context.state.patterns,
      patternsExplained: explainPatterns(context.state.patterns),
      windowHistory: windowHistory(context),
      recentEvents: context.recentEvents,
      alreadyOpen: openTitles,
    },
    null,
    2
  );
}

export function buildRequestBody(context: Context, openTitles: string[], model: string, maxTokens: number): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0.4,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(context, openTitles) }],
  };
}

export function extractText(json: unknown): string {
  const obj = json as Record<string, unknown>;
  const content = obj.content;
  // A reasoning model can spend the whole budget thinking and return no answer at
  // all. Saying only "no text in response" hides the actual cause and sends the
  // next reader hunting for a network fault — name it (cf. GOTCHA.md, Phase 29.2).
  const truncated = obj.stop_reason === "max_tokens";
  const budgetMsg =
    "advisor: response hit max_tokens before answering — raise config.worker.maxTokens";
  if (!Array.isArray(content)) throw new Error(truncated ? budgetMsg : "advisor: no text in response");
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" && block !== null && "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push(String((block as Record<string, string>).text));
    }
  }
  if (parts.length === 0) throw new Error(truncated ? budgetMsg : "advisor: no text in response");
  return parts.join("\n");
}

/**
 * Recover the complete objects from a JSON array that was cut off mid-element.
 * A reasoning model that runs out of budget mid-answer still produced real proposals
 * before the cut; throwing all of them away because the last one is half-written
 * loses good work. Scans for the last top-level element boundary and closes the array
 * there. Returns null when nothing complete can be salvaged.
 */
export function salvageTruncatedArray(s: string): string | null {
  if (!s.startsWith("[")) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let lastComplete = -1; // index just past the last complete top-level element
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (escaped) { escaped = false; continue; }
    if (inStr) {
      if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1) lastComplete = i + 1; // closed a top-level element
    }
  }
  if (lastComplete < 0) return null;
  return s.slice(0, lastComplete) + "]";
}

/** Minimum characters of evidence before it counts as grounding rather than a shrug. */
const MIN_EVIDENCE_CHARS = 8;

/** Evidence strings that are technically present but say nothing. */
const EMPTY_EVIDENCE = new Set(["n/a", "none", "na", "-", "unknown", "general", "no evidence"]);

/** True when a draft cites a specific, checkable observation. */
export function hasGrounding(evidence: string | undefined): boolean {
  if (typeof evidence !== "string") return false;
  const e = evidence.trim();
  if (e.length < MIN_EVIDENCE_CHARS) return false;
  return !EMPTY_EVIDENCE.has(e.toLowerCase());
}

/**
 * Parse a JSON array of drafts (tolerant: strips fences, finds the first [...]).
 * Ungrounded drafts are DROPPED — a proposal that cannot point at what prompted it is
 * exactly the generic advice this Advisor is meant to stop producing.
 */
export function parseDrafts(text: string): ProposalDraft[] {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  if (!s.startsWith("[")) {
    const a = s.indexOf("[");
    const b = s.lastIndexOf("]");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(s);
  } catch (err) {
    // Likely truncated mid-element — keep whatever proposals completed.
    const salvaged = salvageTruncatedArray(s);
    if (salvaged === null) throw err;
    arr = JSON.parse(salvaged);
  }
  if (!Array.isArray(arr)) return [];
  const out: ProposalDraft[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    const evidence = typeof o.evidence === "string" ? o.evidence.trim() : undefined;
    if (!hasGrounding(evidence)) continue;
    out.push({
      category: typeof o.category === "string" ? o.category : "general",
      title,
      detail: typeof o.detail === "string" ? o.detail : "",
      action: typeof o.action === "string" ? o.action : "",
      evidence,
      executable: typeof o.executable === "boolean" ? o.executable : false,
      repo: typeof o.repo === "string" ? o.repo : undefined,
      files: Array.isArray(o.files) ? (o.files as string[]).filter((f) => typeof f === "string") : undefined,
    });
  }
  return out;
}

export class AnthropicAdvisor implements Advisor {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicAdvisorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
    this.name = "anthropic:" + opts.model;
  }

  async propose(context: Context, openTitles: string[]): Promise<ProposalDraft[]> {
    const url = this.baseUrl + "/v1/messages";
    const body = buildRequestBody(context, openTitles, this.model, this.maxTokens);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
      if (this.apiKey) headers["Authorization"] = "Bearer " + this.apiKey;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        const t = await res.text();
        throw new Error("advisor HTTP " + res.status + ": " + t.slice(0, 300));
      }
      return parseDrafts(extractText(await res.json()));
    } finally {
      clearTimeout(timer);
    }
  }
}
