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
    maxTokens: llmMaxTokens(config), // reasoning-model headroom
    timeoutMs: llmTimeoutMs(config),
  });
}
