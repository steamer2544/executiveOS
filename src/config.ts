// Load and validate config.json from .executive/.

import { readFileSync, writeFileSync } from "node:fs";
import { renameOverwrite } from "./fs-atomic.js";
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
    /** Multi-repo mode. When present and non-empty, these REPLACE the single git/fs watchers above. */
    repos?: Array<{
      path: string;             // repo root (required)
      name?: string;            // display/repo name; default = basename(path)
      pollMs?: number;          // git poll cadence; default 5000
      watchFiles?: boolean;     // also run an FsWatcher on this repo; default true
      filePaths?: string[];     // fs watch roots; default [path + "/src"]
      fileDebounceMs?: number;  // default 300
    }>;
  };
  /** State builder configuration (defaults applied when absent). */
  state?: {
    intervalMs?: number;
    /** Opt-in deadline decay (default off / null). When a positive number N, a deadline
     *  more than N whole days past due auto-retires in the State Builder. Off = a deadline
     *  is retired only by the owner (Phase 32's "close it out" nag stays). Dashboard toggle
     *  writes DEADLINE_DECAY_DEFAULT_DAYS when switched on. */
    deadlineDecayDays?: number | null;
  };
  /** Event storage backend (defaults applied when absent). */
  storage?: {
    /** "jsonl" (default) = five .jsonl files; "sqlite" = .executive/events.db. */
    backend?: "jsonl" | "sqlite";
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
    enabled?: boolean;        // if true, the watch daemon periodically asks the LLM to PROPOSE actions. Default false.
    cooldownMs?: number;      // minimum ms between two advisor calls in the daemon. Default 600000 (10 min).
    maxOpen?: number;         // cap on pending proposals in the queue. Default 8.
    applyOnApprove?: boolean; // if true, approving an EXECUTABLE proposal commits to an isolated branch
                              // immediately (still never merges). Default false → approve leaves a
                              // reviewed dry-run changeset for the owner to `execute --apply`.
  };
  /** Conversational agent (Phase 35) — the chat panel with tools. OFF by default.
   *  Reuses `worker` for backend/model/key; adds no gateway and no token of its own. */
  agent?: {
    enabled?: boolean;          // if true, the dashboard chat panel and /api/chat work. Default false.
    toolProtocol?: AgentToolProtocol; // how tool calls are expressed. Default "auto".
    maxToolRounds?: number;     // hard cap on tool round-trips per message. Default 8.
    historyTurns?: number;      // user turns kept in the model's context. Default 20.
    speak?: boolean;            // read replies aloud in the browser. Default false.
    /** Write tools the owner has said "trust this one from now on" to. Empty = ask every time.
     *  Trust removes the PROMPT, never a guardrail: path safety, changeset validation and the
     *  isolated-branch rule still apply to a trusted tool. */
    trustedTools?: string[];
    commandTimeoutMs?: number;  // wall-clock cap on run_command. Default 60000.
    /** Extra known-safe command prefixes for run_command (Phase 38). ADDITIVE — merged with the
     *  in-code defaults; it only widens the advisory "✓ known-safe" badge, never the denylist,
     *  and never auto-runs anything (the owner still confirms every command). Default []. */
    commandAllowlist?: string[];
    /** Directories under which the agent may DISCOVER a repo by name, without it being
     *  registered in watch.repos. Each root is scanned (up to 2 levels deep) for a folder
     *  that matches the requested name and contains a .git. Empty = discovery off; the agent
     *  only sees configured repos + cwd. The name is still path-safety-validated. */
    repoSearchRoots?: string[];
    /** Proactive nudges (Phase 36) — the runtime speaks FIRST instead of waiting to be asked.
     *  RULES pick the moment (budget + quiet hours below); the LLM only writes the sentence.
     *  OFF by default. */
    proactive?: {
      enabled?: boolean;  // Default false.
      maxPerDay?: number; // hard cap on nudges per local calendar day. Default 6.
      minGapMs?: number;  // minimum spacing between two nudges. Default 1800000 (30 min).
      quietFrom?: string; // start of the do-not-disturb window "HH:MM". Default "22:00".
      quietTo?: string;   // end of it. Wraps midnight. from === to disables quiet hours. Default "08:00".
    };
  };
  /** Discord channel (Phase 36) — how a nudge reaches the owner with the dashboard closed,
   *  and how their reply gets back into the SAME conversation. OFF by default.
   *  The bot token lives ONLY in .env; this block holds the env var NAME, never the token. */
  discord?: {
    enabled?: boolean;       // Default false.
    tokenEnv?: string;       // env var NAME holding the bot token. Default "EXECUTIVE_DISCORD_TOKEN".
    ownerId?: string | null; // the ONLY Discord user id the bot obeys. null → the channel refuses
                             // to start. This is an authentication boundary: the agent it feeds has
                             // write tools on this machine, and anyone can DM a bot.
  };
  /** Voice/text capture (defaults applied when absent). The dashboard listens to YOU (your own
   *  dictated notes) and, during work hours, can start listening automatically. OFF by default. */
  capture?: {
    enabled?: boolean; // if true, the dashboard auto-starts listening during work hours (once mic is granted). Default false.
    from?: string;     // work-hours start "HH:MM". Default "09:00".
    to?: string;       // work-hours end "HH:MM". Default "18:00".
  };
  /** Transcription backend for the dashboard mic (multilingual/code-switching). OFF by default
   *  (mode "webspeech" = the browser recognizer). See TranscribeMode. */
  transcribe?: {
    mode?: TranscribeMode;    // which backend the dashboard mic uses. Default "webspeech".
    enabled?: boolean;        // LEGACY (Phase 24). When `mode` is absent: enabled → "whisper-api", else "webspeech".
    baseUrl?: string;         // whisper-api host (no trailing /v1). Default "" (must be set to use whisper-api).
    model?: string;           // whisper-api model, e.g. "whisper-large-v3-turbo". Default "whisper-1".
    apiKeyEnv?: string;       // env var NAME holding the key (read server-side only). Default "EXECUTIVE_TRANSCRIBE_KEY".
    language?: string | null; // hint ("th") or null to auto-detect (best for mixed). Default null.
    wasmModel?: string;       // browser-wasm model id (HF/Xenova). Default "Xenova/whisper-base".
  };
  /** Screen-sensing. Each layer is independently toggle-able; all OFF by default. */
  screen?: {
    window?: {
      enabled?: boolean; // Layer 1: emit the active window title/process on change. Default false.
      pollMs?: number;   // poll cadence. Default 3000.
    };
    /** Layer 2: local screenshot → on-device OCR → text LLM suggestions. Image never leaves the machine. */
    ocr?: {
      enabled?: boolean;   // Default false.
      cooldownMs?: number; // min ms between OCR captures in the daemon. Default 300000 (5 min).
      minChars?: number;   // OCR text shorter than this is "too thin" → eligible to escalate. Default 40.
      /**
       * Which OCR engine reads the screenshot. Default "winrt".
       *  - "winrt"     — Windows.Media.Ocr. Built in, no install, but has NO Thai pack and never
       *                  will (Windows ships 36 OCR languages; th-TH is not one) — Thai is dropped.
       *  - "tesseract" — local tesseract.exe + tha.traineddata. Reads Thai (and Thai/English mixed).
       */
      engine?: OcrEngine;
      languages?: string;          // tesseract only, e.g. "tha+eng". Default "tha+eng".
      tesseractPath?: string | null; // null → auto-detect the exe. Default null.
    };
    /** Layer 3: screenshot → multimodal vision LLM (qwen-vl-max) on the owner's gateway. Opt-in escalation. */
    vision?: {
      enabled?: boolean;         // Default false.
      cooldownMs?: number;       // Default 600000 (10 min).
      escalateFromOcr?: boolean; // a thin OCR result triggers a vision call. Default true.
      baseUrl?: string;          // OpenAI-compatible base (no trailing /v1). Default = config.worker.baseUrl.
      model?: string;            // Default "qwen-vl-max".
      apiKeyEnv?: string;        // env var NAME holding the key. Default = config.worker.apiKeyEnv.
      maxImageBytes?: number;    // cap before sending; downscale to fit. Default 2000000.
    };
  };
}

/** The OCR engines screen-sense Layer 2 can read a screenshot with. */
export type OcrEngine = "winrt" | "tesseract";

/** The three transcription backends the dashboard mic can use. */
export type TranscribeMode = "webspeech" | "whisper-api" | "browser-wasm";

/** How the agent expresses tool calls. "auto" = try native, fall back to json. */
export type AgentToolProtocol = "auto" | "native" | "json";

/** One-click presets for the `whisper-api` mode's fields (baseUrl/model), surfaced in the settings UI.
 *  Both are OpenAI-compatible /v1/audio/transcriptions endpoints. */
export const TRANSCRIBE_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  // Groq cloud — free tier ~2000 req/day; set the key in .env under the configured apiKeyEnv.
  groq: { baseUrl: "https://api.groq.com/openai", model: "whisper-large-v3-turbo" },
  // A self-hosted faster-whisper / whisper.cpp server on your machine (private, no cloud).
  local: { baseUrl: "http://127.0.0.1:8000", model: "Systran/faster-whisper-large-v3" },
};

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
      deadlineDecayDays: null,
    },
    storage: {
      backend: "jsonl",
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
      applyOnApprove: false,
    },
    agent: {
      enabled: false,
      toolProtocol: "auto",
      maxToolRounds: 8,
      historyTurns: 20,
      speak: false,
      trustedTools: [],
      commandTimeoutMs: 60000,
      commandAllowlist: [],
      repoSearchRoots: [],
      proactive: {
        enabled: false,
        maxPerDay: 6,
        minGapMs: 1800000,
        quietFrom: "22:00",
        quietTo: "08:00",
      },
    },
    discord: {
      enabled: false,
      tokenEnv: "EXECUTIVE_DISCORD_TOKEN",
      ownerId: null,
    },
    capture: {
      enabled: false,
      from: "09:00",
      to: "18:00",
    },
    transcribe: {
      mode: "webspeech",
      enabled: false,
      baseUrl: "",
      model: "whisper-1",
      apiKeyEnv: "EXECUTIVE_TRANSCRIBE_KEY",
      language: null,
      wasmModel: "Xenova/whisper-base",
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

  // Normalize multi-repo watch entries when repos is present and non-empty.
  if (parsed.watch.repos && parsed.watch.repos.length > 0) {
    // Local helper matching src/watchers/git.ts's repoName.
    function basenameOf(p: string): string {
      const cleaned = p.replace(/[\\/]+$/, "");
      return cleaned.split(/[\\/]/).pop() ?? "";
    }

    const seen = new Map<string, number>(); // name → count of occurrences
    for (let i = 0; i < parsed.watch.repos.length; i++) {
      const r = parsed.watch.repos[i]!;
      r.name = r.name ?? basenameOf(r.path);
      r.pollMs = r.pollMs ?? 5000;
      r.watchFiles = r.watchFiles ?? true;
      r.filePaths = r.filePaths ?? [r.path + "/src"];
      r.fileDebounceMs = r.fileDebounceMs ?? 300;

      // Name-collision resolution (keyed by the ORIGINAL name, so a 3-way
      // collision suffixes " (2)", " (3)", ... instead of repeating " (2)").
      const originalName = r.name;
      const count = seen.get(originalName) ?? 0;
      if (count > 0) {
        // This is a collision — suffix it.
        const newName = originalName + " (" + (count + 1) + ")";
        process.stderr.write("config: multi-repo name collision: \"" + originalName + "\" → \"" + newName + "\"\n");
        r.name = newName;
      }
      seen.set(originalName, count + 1);
    }
  }

  // Merge missing state fields with defaults.
  if (!parsed.state) {
    parsed.state = defaults.state!;
  }
  parsed.state.intervalMs = parsed.state.intervalMs ?? defaults.state!.intervalMs!;
  parsed.state.deadlineDecayDays = parsed.state.deadlineDecayDays ?? null;

  // Merge missing storage fields with defaults.
  if (!parsed.storage) {
    parsed.storage = defaults.storage!;
  }
  parsed.storage.backend = parsed.storage.backend ?? defaults.storage!.backend!;

  // Validate storage.backend defensively — never throw, just warn and fall back.
  if (parsed.storage.backend !== "jsonl" && parsed.storage.backend !== "sqlite") {
    process.stderr.write(
      "config: invalid storage.backend \"" + parsed.storage.backend + "\", falling back to \"jsonl\"\n"
    );
    parsed.storage.backend = "jsonl";
  }

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
  parsed.advisor.applyOnApprove = parsed.advisor.applyOnApprove ?? defaults.advisor!.applyOnApprove!;

  // Merge missing agent fields with defaults (absent block = the agent is off).
  if (!parsed.agent) {
    parsed.agent = defaults.agent!;
  }
  parsed.agent.enabled = parsed.agent.enabled ?? defaults.agent!.enabled!;
  parsed.agent.toolProtocol = parsed.agent.toolProtocol ?? defaults.agent!.toolProtocol!;
  parsed.agent.maxToolRounds = parsed.agent.maxToolRounds ?? defaults.agent!.maxToolRounds!;
  parsed.agent.historyTurns = parsed.agent.historyTurns ?? defaults.agent!.historyTurns!;
  parsed.agent.speak = parsed.agent.speak ?? defaults.agent!.speak!;
  parsed.agent.trustedTools = parsed.agent.trustedTools ?? [];
  parsed.agent.commandTimeoutMs =
    parsed.agent.commandTimeoutMs ?? defaults.agent!.commandTimeoutMs!;
  parsed.agent.commandAllowlist = parsed.agent.commandAllowlist ?? [];
  parsed.agent.repoSearchRoots = parsed.agent.repoSearchRoots ?? [];
  if (!parsed.agent.proactive) {
    parsed.agent.proactive = defaults.agent!.proactive!;
  }
  const pDefaults = defaults.agent!.proactive!;
  parsed.agent.proactive.enabled = parsed.agent.proactive.enabled ?? pDefaults.enabled!;
  parsed.agent.proactive.maxPerDay = parsed.agent.proactive.maxPerDay ?? pDefaults.maxPerDay!;
  parsed.agent.proactive.minGapMs = parsed.agent.proactive.minGapMs ?? pDefaults.minGapMs!;
  parsed.agent.proactive.quietFrom = parsed.agent.proactive.quietFrom ?? pDefaults.quietFrom!;
  parsed.agent.proactive.quietTo = parsed.agent.proactive.quietTo ?? pDefaults.quietTo!;

  // Merge missing discord fields with defaults (absent block = the channel is off).
  if (!parsed.discord) {
    parsed.discord = defaults.discord!;
  }
  parsed.discord.enabled = parsed.discord.enabled ?? defaults.discord!.enabled!;
  parsed.discord.tokenEnv = parsed.discord.tokenEnv ?? defaults.discord!.tokenEnv!;
  parsed.discord.ownerId = parsed.discord.ownerId ?? defaults.discord!.ownerId!;

  // Merge missing capture fields with defaults.
  if (!parsed.capture) {
    parsed.capture = defaults.capture!;
  }
  parsed.capture.enabled = parsed.capture.enabled ?? defaults.capture!.enabled!;
  parsed.capture.from = parsed.capture.from ?? defaults.capture!.from!;
  parsed.capture.to = parsed.capture.to ?? defaults.capture!.to!;

  // Merge missing transcribe fields with defaults.
  if (!parsed.transcribe) {
    parsed.transcribe = defaults.transcribe!;
  }
  parsed.transcribe.enabled = parsed.transcribe.enabled ?? defaults.transcribe!.enabled!;
  // Backward-compat: a Phase-24 config had only `enabled` (no `mode`). Derive the mode from it so
  // an old config keeps working; an explicit `mode` always wins.
  parsed.transcribe.mode =
    parsed.transcribe.mode ?? (parsed.transcribe.enabled ? "whisper-api" : "webspeech");
  parsed.transcribe.baseUrl = parsed.transcribe.baseUrl ?? defaults.transcribe!.baseUrl!;
  parsed.transcribe.model = parsed.transcribe.model ?? defaults.transcribe!.model!;
  parsed.transcribe.apiKeyEnv = parsed.transcribe.apiKeyEnv ?? defaults.transcribe!.apiKeyEnv!;
  parsed.transcribe.language = parsed.transcribe.language ?? defaults.transcribe!.language ?? null;
  parsed.transcribe.wasmModel = parsed.transcribe.wasmModel ?? defaults.transcribe!.wasmModel!;

  // Merge missing screen fields with defaults (only if screen block is present).
  if (parsed.screen) {
    if (parsed.screen.window) {
      parsed.screen.window.enabled = parsed.screen.window.enabled ?? false;
      parsed.screen.window.pollMs = parsed.screen.window.pollMs ?? 3000;
    }
    if (parsed.screen.ocr) {
      parsed.screen.ocr.enabled = parsed.screen.ocr.enabled ?? false;
      parsed.screen.ocr.cooldownMs = parsed.screen.ocr.cooldownMs ?? 300000;
      parsed.screen.ocr.minChars = parsed.screen.ocr.minChars ?? 40;
      // An unknown engine string must never throw and must never silently enable Tesseract —
      // anything that isn't the exact literal falls back to today's behaviour.
      parsed.screen.ocr.engine = parsed.screen.ocr.engine === "tesseract" ? "tesseract" : "winrt";
      parsed.screen.ocr.languages = parsed.screen.ocr.languages ?? "tha+eng";
      parsed.screen.ocr.tesseractPath = parsed.screen.ocr.tesseractPath ?? null;
    }
    if (parsed.screen.vision) {
      parsed.screen.vision.enabled = parsed.screen.vision.enabled ?? false;
      parsed.screen.vision.cooldownMs = parsed.screen.vision.cooldownMs ?? 600000;
      parsed.screen.vision.escalateFromOcr = parsed.screen.vision.escalateFromOcr ?? true;
      parsed.screen.vision.model = parsed.screen.vision.model ?? "qwen-vl-max";
      parsed.screen.vision.maxImageBytes = parsed.screen.vision.maxImageBytes ?? 2000000;
      // baseUrl/apiKeyEnv intentionally NOT defaulted from config.worker here — read lazily at
      // use time (src/screen/vision.ts) so changing `worker` later still applies to vision calls.
    }
  }

  return parsed;
}

/**
 * Persist an owner edit to the `transcribe` config block from the dashboard settings UI.
 * ONLY the transcribe block is writable this way — every other field is left untouched — and each
 * field is whitelisted + type-checked so a malformed request can never corrupt config.json. Writes
 * atomically (temp + rename). Returns the resulting transcribe block. Never writes the raw API key
 * (the key stays in .env; this only sets the env-var NAME via `apiKeyEnv`).
 */
export function updateTranscribeConfig(patch: Record<string, unknown>): Config["transcribe"] {
  const config = loadConfig();
  const t = config.transcribe!;

  if (patch.mode !== undefined) {
    if (patch.mode !== "webspeech" && patch.mode !== "whisper-api" && patch.mode !== "browser-wasm") {
      throw new Error("invalid transcribe.mode: " + String(patch.mode));
    }
    t.mode = patch.mode;
    t.enabled = patch.mode !== "webspeech"; // keep the legacy flag consistent
  }
  if (typeof patch.baseUrl === "string") t.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === "string") t.model = patch.model.trim();
  if (typeof patch.apiKeyEnv === "string") t.apiKeyEnv = patch.apiKeyEnv.trim();
  if (typeof patch.wasmModel === "string") t.wasmModel = patch.wasmModel.trim();
  if (patch.language === null || typeof patch.language === "string") {
    const lang = typeof patch.language === "string" ? patch.language.trim() : null;
    t.language = lang === "" ? null : lang;
  }

  const raw = JSON.stringify(config, null, 2) + "\n";
  const tmp = configPath() + ".tmp";
  writeFileSync(tmp, raw);
  renameOverwrite(tmp, configPath());
  return t;
}

/** Days-past-due the dashboard toggle writes when deadline decay is switched on. The
 *  builder honours any positive `config.state.deadlineDecayDays`, so a hand-edited
 *  config.json can pick a different N; the toggle just picks a sensible default. */
export const DEADLINE_DECAY_DEFAULT_DAYS = 7;

/** What the dashboard may switch on and off, and what it reads back. */
export interface AutonomyState {
  advisorEnabled: boolean;
  inferEnabled: boolean;
  autopilotEnabled: boolean;
  agentEnabled: boolean;
  /** Opt-in deadline decay (a State-derivation behaviour, not an LLM/repo action). */
  deadlineDecayEnabled: boolean;
  /** Read-only here. See updateAutonomyConfig for why this is not a dashboard toggle. */
  autopilotApply: boolean;
}

/** Read the current autonomy gates (absent block = off, matching loadConfig's defaults). */
export function readAutonomyConfig(config?: Config): AutonomyState {
  const c = config ?? loadConfig();
  return {
    advisorEnabled: c.advisor?.enabled === true,
    inferEnabled: c.infer?.enabled === true,
    autopilotEnabled: c.autopilot?.enabled === true,
    agentEnabled: c.agent?.enabled === true,
    deadlineDecayEnabled: typeof c.state?.deadlineDecayDays === "number" && c.state.deadlineDecayDays > 0,
    autopilotApply: c.autopilot?.apply === true,
  };
}

/**
 * Persist an owner toggle of the autonomy gates from the dashboard.
 *
 * **`autopilot.apply` is deliberately NOT writable here.** Every other autonomy in this system
 * still requires a human click *per action* — approve a proposal, confirm a suggestion. `apply`
 * is the single switch that lets the runtime write commits with no per-action click, and the
 * dashboard is an unauthenticated page on 127.0.0.1. Arming it stays a deliberate edit of
 * `config.json`; the dashboard only *reports* its state so the owner can see the combined effect
 * of flipping `autopilot.enabled`.
 *
 * Booleans only, whitelisted field by field, written atomically (temp + rename).
 */
export function updateAutonomyConfig(patch: Record<string, unknown>): AutonomyState {
  const config = loadConfig();

  if (typeof patch.advisorEnabled === "boolean") {
    if (!config.advisor) config.advisor = {};
    config.advisor.enabled = patch.advisorEnabled;
  }
  if (typeof patch.inferEnabled === "boolean") {
    if (!config.infer) config.infer = {};
    config.infer.enabled = patch.inferEnabled;
  }
  if (typeof patch.autopilotEnabled === "boolean") {
    if (!config.autopilot) config.autopilot = {};
    config.autopilot.enabled = patch.autopilotEnabled;
  }
  if (typeof patch.agentEnabled === "boolean") {
    if (!config.agent) config.agent = {};
    config.agent.enabled = patch.agentEnabled;
  }
  if (typeof patch.agentSpeak === "boolean") {
    if (!config.agent) config.agent = {};
    config.agent.speak = patch.agentSpeak;
  }
  if (typeof patch.deadlineDecayEnabled === "boolean") {
    if (!config.state) config.state = {};
    config.state.deadlineDecayDays = patch.deadlineDecayEnabled ? DEADLINE_DECAY_DEFAULT_DAYS : null;
  }
  // patch.autopilotApply is ignored on purpose — see the doc comment above.

  const raw = JSON.stringify(config, null, 2) + "\n";
  const tmp = configPath() + ".tmp";
  writeFileSync(tmp, raw);
  renameOverwrite(tmp, configPath());
  return readAutonomyConfig(config);
}

/**
 * Write tools that may NEVER be granted standing trust (Phase 38). They run `sh -c <anything>`
 * or drive Synth→Executor onto the repo, so each execution must always face a per-action human
 * click. Enforced in two places for defence in depth: `trustTool` refuses to persist these, and
 * the loop's `isTrusted` ignores them even if a hand-edited `config.json` lists them — so a
 * `trustedTools:["run_command"]` in config is inert, not a re-armed footgun.
 */
export const NEVER_TRUSTABLE: ReadonlySet<string> = new Set(["run_command", "edit_files"]);

/**
 * Record that the owner trusts a write tool from now on ("ไว้ใจแล้ว" on the confirm chip).
 *
 * This removes the *prompt*, not a guardrail — a trusted `read_file` path is still confined to
 * the configured repos. A tool in NEVER_TRUSTABLE (run_command / edit_files) is refused: the call
 * is a no-op and config is not written. Idempotent; returns the (possibly unchanged) config.
 */
export function trustTool(name: string): Config {
  const config = loadConfig();
  if (!config.agent) config.agent = {};
  const current = config.agent.trustedTools ?? [];
  if (NEVER_TRUSTABLE.has(name)) {
    // Too dangerous to ever trust — leave trustedTools as-is and do not persist.
    config.agent.trustedTools = current;
    return config;
  }
  if (!current.includes(name)) {
    config.agent.trustedTools = [...current, name];
    const tmp = configPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    renameOverwrite(tmp, configPath());
  } else {
    config.agent.trustedTools = current;
  }
  return config;
}

/**
 * Persist an owner edit to the `screen` config block (Window / OCR / Vision toggles) from the
 * dashboard settings UI. ONLY the screen block is writable this way, whitelisted + type-checked
 * field by field, written atomically (temp + rename). Never writes a raw API key — only the
 * `apiKeyEnv` NAME. Patch shape: `{ window?: {...}, ocr?: {...}, vision?: {...} }`.
 */
export function updateScreenConfig(patch: Record<string, unknown>): Config["screen"] {
  const config = loadConfig();
  if (!config.screen) config.screen = {};
  const s = config.screen;

  const windowPatch = patch.window as Record<string, unknown> | undefined;
  if (windowPatch && typeof windowPatch === "object") {
    if (!s.window) s.window = {};
    if (typeof windowPatch.enabled === "boolean") s.window.enabled = windowPatch.enabled;
    if (typeof windowPatch.pollMs === "number") s.window.pollMs = windowPatch.pollMs;
  }

  const ocrPatch = patch.ocr as Record<string, unknown> | undefined;
  if (ocrPatch && typeof ocrPatch === "object") {
    if (!s.ocr) s.ocr = {};
    if (typeof ocrPatch.enabled === "boolean") s.ocr.enabled = ocrPatch.enabled;
    if (typeof ocrPatch.cooldownMs === "number") s.ocr.cooldownMs = ocrPatch.cooldownMs;
    if (typeof ocrPatch.minChars === "number") s.ocr.minChars = ocrPatch.minChars;
    // Only the two literal engine names are accepted; anything else is ignored, not coerced.
    if (ocrPatch.engine === "winrt" || ocrPatch.engine === "tesseract") s.ocr.engine = ocrPatch.engine;
    if (typeof ocrPatch.languages === "string") s.ocr.languages = ocrPatch.languages;
    if (typeof ocrPatch.tesseractPath === "string" || ocrPatch.tesseractPath === null) {
      s.ocr.tesseractPath = ocrPatch.tesseractPath as string | null;
    }
  }

  const visionPatch = patch.vision as Record<string, unknown> | undefined;
  if (visionPatch && typeof visionPatch === "object") {
    if (!s.vision) s.vision = {};
    if (typeof visionPatch.enabled === "boolean") s.vision.enabled = visionPatch.enabled;
    if (typeof visionPatch.cooldownMs === "number") s.vision.cooldownMs = visionPatch.cooldownMs;
    if (typeof visionPatch.escalateFromOcr === "boolean") s.vision.escalateFromOcr = visionPatch.escalateFromOcr;
    if (typeof visionPatch.baseUrl === "string") s.vision.baseUrl = visionPatch.baseUrl.trim();
    if (typeof visionPatch.model === "string") s.vision.model = visionPatch.model.trim();
    if (typeof visionPatch.apiKeyEnv === "string") s.vision.apiKeyEnv = visionPatch.apiKeyEnv.trim();
    if (typeof visionPatch.maxImageBytes === "number") s.vision.maxImageBytes = visionPatch.maxImageBytes;
  }

  const raw = JSON.stringify(config, null, 2) + "\n";
  const tmp = configPath() + ".tmp";
  writeFileSync(tmp, raw);
  renameOverwrite(tmp, configPath());
  return s;
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
