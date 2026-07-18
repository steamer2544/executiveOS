// Factory — createSynthesizer(config) → Synthesizer (selects backend).
// Reuses the Phase 5 worker config (same gateway, same token).

import type { Config } from "../config.js";
import { llmMaxTokens, llmTimeoutMs } from "../config.js";
import type { Synthesizer } from "./types.js";
import { MockSynthesizer } from "./mock.js";
import { AnthropicSynthesizer } from "./anthropic.js";

export function createSynthesizer(config: Config): Synthesizer {
  const w = config.worker!; // loadConfig() guarantees this is populated
  if (w.backend === "mock") return new MockSynthesizer();
  // "anthropic"
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicSynthesizer({
    baseUrl: w.baseUrl!,
    model: w.model!,
    apiKey,
    maxTokens: llmMaxTokens(config),
    timeoutMs: llmTimeoutMs(config),
  });
}
