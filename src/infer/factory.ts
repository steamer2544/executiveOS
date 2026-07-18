// Factory — createInferer(config) → Inferer (selects backend, reusing config.worker).

import type { Config } from "../config.js";
import { llmMaxTokens, llmTimeoutMs } from "../config.js";
import type { Inferer } from "./types.js";
import { MockInferer } from "./mock.js";
import { AnthropicInferer } from "./anthropic.js";

export function createInferer(config: Config): Inferer {
  const w = config.worker!; // loadConfig() guarantees this is populated
  if (w.backend === "mock") return new MockInferer();
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicInferer({
    baseUrl: w.baseUrl!,
    model: w.model!,
    apiKey,
    maxTokens: llmMaxTokens(config), // reasoning-model headroom (thinking + answer)
    timeoutMs: llmTimeoutMs(config),
  });
}
