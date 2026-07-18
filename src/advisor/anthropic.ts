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
  "few small, concrete, REVERSIBLE next actions — across BOTH their work and their life (health, admin,\n" +
  "learning, rest, personal upkeep). Base them on the recent activity you are given.\n" +
  "Rules:\n" +
  "- Propose at most 3. Each must be small and reversible; the owner will approve or reject each one.\n" +
  "- Do NOT propose anything involving relationships, morality, large spending, or major life-goal changes.\n" +
  "- Avoid repeating any title in the provided already-open list.\n" +
  "- Keep titles under 8 words; detail to 1-2 sentences; action a single concrete next step.\n" +
  'Respond with ONLY a JSON array, no prose:\n' +
  '[{"category":string,"title":string,"detail":string,"action":string}]';

export function buildUserMessage(context: Context, openTitles: string[]): string {
  return JSON.stringify(
    { summary: context.summary, state: context.state, recentEvents: context.recentEvents, alreadyOpen: openTitles },
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
  if (!Array.isArray(content)) throw new Error("advisor: no text in response");
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
  if (parts.length === 0) throw new Error("advisor: no text in response");
  return parts.join("\n");
}

/** Parse a JSON array of drafts (tolerant: strips fences, finds the first [...]). */
export function parseDrafts(text: string): ProposalDraft[] {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  if (!s.startsWith("[")) {
    const a = s.indexOf("[");
    const b = s.lastIndexOf("]");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
  }
  const arr = JSON.parse(s) as unknown;
  if (!Array.isArray(arr)) return [];
  const out: ProposalDraft[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    out.push({
      category: typeof o.category === "string" ? o.category : "general",
      title,
      detail: typeof o.detail === "string" ? o.detail : "",
      action: typeof o.action === "string" ? o.action : "",
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
