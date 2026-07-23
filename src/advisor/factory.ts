// Factory — createAdvisor(config) → Advisor (selects backend, reusing config.worker).

import type { Config } from "../config.js";
import { llmMaxTokens, llmTimeoutMs } from "../config.js";
import type { Advisor } from "./types.js";
import { MockAdvisor } from "./mock.js";
import { AnthropicAdvisor } from "./anthropic.js";

export function createAdvisor(config: Config): Advisor {
  const w = config.worker!; // loadConfig() guarantees this is populated
  if (w.backend === "mock") return new MockAdvisor();
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicAdvisor({
    baseUrl: w.baseUrl!,
    model: w.model!,
    apiKey,
    // The Advisor needs MORE headroom than the 4096 default floor. Measured live
    // against the 9arm Qwen gateway: at 4096 every run ended `stop_reason:
    // max_tokens` (output_tokens exactly 4096) — sometimes zero text blocks, sometimes
    // a JSON array truncated mid-object. The model reasons before answering, and this
    // prompt asks it to justify each proposal with evidence, so it thinks longer.
    // At 8192 it finishes cleanly (end_turn, ~4.5k output).
    maxTokens: llmMaxTokens(config, 8192),
    timeoutMs: llmTimeoutMs(config),
  });
}
