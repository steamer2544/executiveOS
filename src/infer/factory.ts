// Factory — createInferer(config) → Inferer (selects backend, reusing config.worker).

import type { Config } from "../config.js";
import type { Inferer } from "./types.js";
import { MockInferer } from "./mock.js";
import { AnthropicInferer } from "./anthropic.js";

export function createInferer(config: Config): Inferer {
  const w = config.worker!; // loadConfig() guarantees this is populated
  if (w.backend === "mock") return new MockInferer();
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  // Reasoning models (e.g. the default Qwen) spend tokens "thinking" before the
  // JSON answer; too small a cap truncates mid-thought → empty content. Give a
  // generous floor so the guess reliably completes (the gateway is flat-rate).
  const inferMaxTokens = Math.max(w.maxTokens ?? 1024, 3072);
  // Thinking is slow; give the request room (floor 60s) so it isn't aborted mid-guess.
  const inferTimeoutMs = Math.max(w.timeoutMs ?? 30000, 60000);
  return new AnthropicInferer({
    baseUrl: w.baseUrl!,
    model: w.model!,
    apiKey,
    maxTokens: inferMaxTokens,
    timeoutMs: inferTimeoutMs,
  });
}
