// Load and validate config.json from .executive/.

import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

export interface Config {
  /** Config schema version (always 1 for Phase 1). */
  version: 1;
  /** ISO timestamp set once at init time. */
  createdAt: string;
  /** IANA timezone identifier. */
  timezone: string;
  /** Watcher configuration (defaults applied when absent). */
  watch?: {
    git: {
      enabled?: boolean;
      repoPath?: string;
      pollMs?: number;
    };
    fs: {
      enabled?: boolean;
      paths?: string[];
      debounceMs?: number;
    };
  };
  /** State builder configuration (defaults applied when absent). */
  state?: {
    intervalMs?: number;
  };
  /** Worker (LLM) configuration (defaults applied when absent). */
  worker?: {
    backend?: "mock" | "anthropic"; // which Worker to build
    baseUrl?: string; // Anthropic-compatible gateway base (NO trailing /v1)
    model?: string; // model name, e.g. "qwen3.6-35b-a3b"
    apiKeyEnv?: string; // NAME of the env var holding the auth token
    maxTokens?: number; // cap on completion length
    timeoutMs?: number; // request timeout
    autoInvoke?: boolean; // if true, the watch daemon calls the Worker automatically
  };
  /** Executor configuration (defaults applied when absent). */
  executor?: {
    branchPrefix?: string; // prefix for the isolated branch; default "executive/change-"
    defaultTestCommand?: string | null; // used when a ChangeSet has test === null; default null
  };
  /** Synthesizer configuration (defaults applied when absent). */
  synth?: {
    maxFileBytes?: number; // skip any single file larger than this (token bound); default 100000
    maxFiles?: number;     // cap on number of files fed to the LLM; default 10
  };
  /** Continuous-autopilot configuration (defaults applied when absent). OFF by default. */
  autopilot?: {
    enabled?: boolean; // master switch: if true, the watch daemon runs the Autopilot each rebuild. Default false.
    apply?: boolean;   // if true (AND enabled), the daemon lets the Executor commit to an isolated branch. Default false.
    cooldownMs?: number; // minimum ms between two Autopilot runs. Default 300000 (5 min).
  };
  /** Git-hook integration (defaults applied when absent). */
  hooks?: {
    testCommand?: string | null; // the project's test command; `install-hooks` runs it post-commit and emits the result. Default null.
  };
  /** LLM signal inference (defaults applied when absent). OFF by default — departs from the deterministic core. */
  infer?: {
    enabled?: boolean;   // if true, the watch daemon periodically asks the LLM to GUESS block/deadline. Default false.
    cooldownMs?: number; // minimum ms between two inference calls in the daemon. Default 300000 (5 min).
  };
  /** Proactive Advisor / proposal queue (defaults applied when absent). OFF by default. */
  advisor?: {
    enabled?: boolean;   // if true, the watch daemon periodically asks the LLM to PROPOSE actions. Default false.
    cooldownMs?: number; // minimum ms between two advisor calls in the daemon. Default 600000 (10 min).
    maxOpen?: number;    // cap on pending proposals in the queue. Default 8.
  };
}

/** Default configuration values. */
export function defaultConfig(): Config {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    watch: {
      git: {
        enabled: true,
        repoPath: process.cwd(),
        pollMs: 5000,
      },
      fs: {
        enabled: true,
        paths: [process.cwd() + "/src"],
        debounceMs: 300,
      },
    },
    state: {
      intervalMs: 30000,
    },
    worker: {
      backend: "anthropic",
      baseUrl: "https://gateway.9arm.co",
      model: "qwen3.6-35b-a3b",
      apiKeyEnv: "EXECUTIVE_WORKER_KEY",
      maxTokens: 4096, // headroom for reasoning models that "think" before answering
      timeoutMs: 120000, // thinking latency is variable and occasionally >1 min
      autoInvoke: false,
    },
    executor: {
      branchPrefix: "executive/change-",
      defaultTestCommand: null,
    },
    synth: {
      maxFileBytes: 100000,
      maxFiles: 10,
    },
    autopilot: {
      enabled: false,
      apply: false,
      cooldownMs: 300000,
    },
    hooks: {
      testCommand: null,
    },
    infer: {
      enabled: false,
      cooldownMs: 300000,
    },
    advisor: {
      enabled: false,
      cooldownMs: 600000,
      maxOpen: 8,
    },
  };
}

/**
 * Read config.json. Merges missing watch fields with defaults so a
 * Phase 1 config (no `watch` key) still works.
 * Throws a clear error if the file is missing or if JSON is malformed.
 */
export function loadConfig(): Config {
  const cfgPath = configPath();

  let raw: string;
  try {
    raw = readFileSync(cfgPath, "utf-8");
  } catch {
    throw new Error("Config file not found. Run `executive init` first.");
  }

  if (!raw.trim()) {
    throw new Error("Config file is empty. Run `executive init` to create a valid config.");
  }

  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch {
    throw new Error("Config file contains malformed JSON: " + cfgPath);
  }

  // Merge missing watch fields with defaults.
  const defaults = defaultConfig();
  if (!parsed.watch) {
    parsed.watch = defaults.watch!;
  }
  if (!parsed.watch.git) {
    parsed.watch.git = defaults.watch!.git;
  }
  if (!parsed.watch.fs) {
    parsed.watch.fs = defaults.watch!.fs;
  }

  // Fill in missing individual fields with defaults.
  parsed.watch.git.enabled = parsed.watch.git.enabled ?? defaults.watch!.git.enabled!;
  parsed.watch.git.repoPath = parsed.watch.git.repoPath ?? defaults.watch!.git.repoPath!;
  parsed.watch.git.pollMs = parsed.watch.git.pollMs ?? defaults.watch!.git.pollMs!;
  parsed.watch.fs.enabled = parsed.watch.fs.enabled ?? defaults.watch!.fs.enabled!;
  parsed.watch.fs.paths = parsed.watch.fs.paths ?? defaults.watch!.fs.paths!;
  parsed.watch.fs.debounceMs = parsed.watch.fs.debounceMs ?? defaults.watch!.fs.debounceMs!;

  // Merge missing state fields with defaults.
  if (!parsed.state) {
    parsed.state = defaults.state!;
  }
  parsed.state.intervalMs = parsed.state.intervalMs ?? defaults.state!.intervalMs!;

  // Merge missing worker fields with defaults.
  if (!parsed.worker) {
    parsed.worker = defaults.worker!;
  }
  parsed.worker.backend = parsed.worker.backend ?? defaults.worker!.backend!;
  parsed.worker.baseUrl = parsed.worker.baseUrl ?? defaults.worker!.baseUrl!;
  parsed.worker.model = parsed.worker.model ?? defaults.worker!.model!;
  parsed.worker.apiKeyEnv = parsed.worker.apiKeyEnv ?? defaults.worker!.apiKeyEnv!;
  parsed.worker.maxTokens = parsed.worker.maxTokens ?? defaults.worker!.maxTokens!;
  parsed.worker.timeoutMs = parsed.worker.timeoutMs ?? defaults.worker!.timeoutMs!;
  parsed.worker.autoInvoke = parsed.worker.autoInvoke ?? defaults.worker!.autoInvoke!;

  // Merge missing executor fields with defaults.
  if (!parsed.executor) {
    parsed.executor = defaults.executor!;
  }
  parsed.executor.branchPrefix = parsed.executor.branchPrefix ?? defaults.executor!.branchPrefix!;
  parsed.executor.defaultTestCommand =
    parsed.executor.defaultTestCommand ?? defaults.executor!.defaultTestCommand!;

  // Merge missing synth fields with defaults.
  if (!parsed.synth) {
    parsed.synth = defaults.synth!;
  }
  parsed.synth.maxFileBytes = parsed.synth.maxFileBytes ?? defaults.synth!.maxFileBytes!;
  parsed.synth.maxFiles = parsed.synth.maxFiles ?? defaults.synth!.maxFiles!;

  // Merge missing autopilot fields with defaults.
  if (!parsed.autopilot) {
    parsed.autopilot = defaults.autopilot!;
  }
  parsed.autopilot.enabled = parsed.autopilot.enabled ?? defaults.autopilot!.enabled!;
  parsed.autopilot.apply = parsed.autopilot.apply ?? defaults.autopilot!.apply!;
  parsed.autopilot.cooldownMs = parsed.autopilot.cooldownMs ?? defaults.autopilot!.cooldownMs!;

  // Merge missing hooks fields with defaults.
  if (!parsed.hooks) {
    parsed.hooks = defaults.hooks!;
  }
  parsed.hooks.testCommand = parsed.hooks.testCommand ?? defaults.hooks!.testCommand!;

  // Merge missing infer fields with defaults.
  if (!parsed.infer) {
    parsed.infer = defaults.infer!;
  }
  parsed.infer.enabled = parsed.infer.enabled ?? defaults.infer!.enabled!;
  parsed.infer.cooldownMs = parsed.infer.cooldownMs ?? defaults.infer!.cooldownMs!;

  // Merge missing advisor fields with defaults.
  if (!parsed.advisor) {
    parsed.advisor = defaults.advisor!;
  }
  parsed.advisor.enabled = parsed.advisor.enabled ?? defaults.advisor!.enabled!;
  parsed.advisor.cooldownMs = parsed.advisor.cooldownMs ?? defaults.advisor!.cooldownMs!;
  parsed.advisor.maxOpen = parsed.advisor.maxOpen ?? defaults.advisor!.maxOpen!;

  return parsed;
}

/**
 * Effective LLM output cap. Reasoning models (e.g. the default Qwen) spend tokens
 * "thinking" BEFORE the answer, and that counts toward max_tokens — too small a cap
 * truncates mid-thought and returns empty content. Enforce a generous floor so real
 * responses complete. The gateway is flat-rate, so headroom costs nothing.
 */
export function llmMaxTokens(config: Config, floor = 4096): number {
  return Math.max(config.worker?.maxTokens ?? 1024, floor);
}

/** Effective request timeout. Reasoning models "think" for a highly variable time
 *  (often seconds, occasionally >1 min), so floor the timeout generously to avoid
 *  aborting a slow-but-valid answer mid-flight. */
export function llmTimeoutMs(config: Config, floor = 120000): number {
  return Math.max(config.worker?.timeoutMs ?? 30000, floor);
}
