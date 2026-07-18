// Factory — createWorker(config) → Worker (selects backend).
// Reads the auth token from the named env var.

import type { Config } from "../config.js";
import type { Worker } from "./types.js";
import { MockWorker } from "./mock.js";
import { AnthropicWorker } from "./anthropic.js";
import { loadWorkerIdentity } from "./identity.js";

export function createWorker(config: Config): Worker {
  const w = config.worker!; // loadConfig() guarantees this is populated
  if (w.backend === "mock") return new MockWorker();
  // "anthropic"
  const apiKey = w.apiKeyEnv ? (process.env[w.apiKeyEnv] ?? "") : "";
  return new AnthropicWorker({
    baseUrl: w.baseUrl!,
    model: w.model!,
    apiKey,
    maxTokens: w.maxTokens!,
    timeoutMs: w.timeoutMs!,
    identity: loadWorkerIdentity(),
  });
}
