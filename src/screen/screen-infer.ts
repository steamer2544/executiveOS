// Screen inference — Layer 2 (local OCR) + Layer 3 (vision LLM).
// Produces SUGGESTIONS only; never emits events, mutates state, or calls git/executor.

import type { Config } from "../config.js";
import type { Suggestion } from "../report/types.js";
import { captureScreen } from "./screenshot.js";
import { ocrImage, resolveOcrLanguages } from "./ocr.js";
import { foregroundWindow } from "./capture.js";
import { visionComplete, extractOpenAiText } from "./vision.js";
import { llmMaxTokens, llmTimeoutMs } from "../config.js";
import { readFileSync, unlinkSync } from "node:fs";

/** Result of a screen-inference run. */
export interface ScreenInferResult {
  ran: boolean;
  layer: "none" | "ocr" | "vision";
  suggestions: Suggestion[];
  message: string;
}

/** Injectable dependencies for testing. */
export interface ScreenInferDeps {
  capture?: (maxBytes: number) => import("./screenshot.js").Screenshot | null;
  ocr?: (
    path: string,
    language?: string | null,
    opts?: import("./ocr.js").OcrOptions,
  ) => string;
  vision?: (
    opts: import("./vision.js").VisionOptions,
    prompt: string,
    imageDataUrl: string,
  ) => Promise<string>;
  /** Ask the project's existing text LLM (mock|anthropic, reusing config.worker) to turn
   *  OCR'd screen text into suggestions. Tests inject a mock so no network/PowerShell runs. */
  textInfer?: (config: Config, text: string) => Promise<Suggestion[]>;
  /** Read the active window (title + app). Used ONLY to pick the OCR language list. */
  window?: () => import("./capture.js").ForegroundWindow | null;
}

/**
 * Run screen inference (Layer 2 OCR → Layer 3 vision) and return suggestions.
 * Never throws out of this function — errors are caught and surfaced as empty suggestions.
 */
export async function runScreenInference(
  config: Config,
  deps?: ScreenInferDeps,
): Promise<ScreenInferResult> {
  const ocrEnabled = !!config.screen?.ocr?.enabled;
  const visionEnabled = !!config.screen?.vision?.enabled;

  // Step 1 — nothing enabled → short-circuit.
  if (!ocrEnabled && !visionEnabled) {
    return { ran: false, layer: "none", suggestions: [], message: "screen sensing disabled" };
  }

  // Resolve injectable deps with real defaults.
  const capture = deps?.capture ?? captureScreen;
  const ocr = deps?.ocr ?? ocrImage;
  const vision = deps?.vision ?? visionComplete;
  const textInfer = deps?.textInfer ?? defaultTextInfer;
  const getWindow = deps?.window ?? foregroundWindow;

  // Track screenshot path for cleanup.
  let shotPath: string | null = null;
  const maxImageBytes = config.screen?.vision?.maxImageBytes ?? 2000000;

  try {
    // ── Layer 2: OCR ────────────────────────────────────────────────
    if (ocrEnabled) {
      const shot = capture(maxImageBytes);
      if (shot) {
        shotPath = shot.path;
      }

      if (shot) {
        // Engine selection lives in config (default "winrt"); the OCR module resolves the rest.
        // Only Tesseract takes a language list, and only it hallucinates Thai on an English
        // screen — so the guess is scoped to that engine, and the window is read lazily (it is
        // a spawnSync) only when the configured value is "auto".
        const engine = config.screen?.ocr?.engine === "tesseract" ? "tesseract" : "winrt";
        const languages =
          engine === "tesseract"
            ? resolveOcrLanguages(config.screen?.ocr?.languages, () => getWindow()?.title ?? null)
            : config.screen?.ocr?.languages;
        const text = ocr(shot.path, null, {
          engine: config.screen?.ocr?.engine,
          languages,
          tesseractPath: config.screen?.ocr?.tesseractPath,
        });
        const minChars = config.screen?.ocr?.minChars ?? 40;
        if (text.trim().length >= minChars) {
          // A hard failure (TLS/401/403/timeout) must NOT masquerade as "no signal" — that
          // ambiguity once cost hours of debugging a corporate TLS proxy. Report it distinctly.
          let suggestions: Suggestion[];
          try {
            suggestions = await textInfer(config, text);
          } catch (e) {
            return {
              ran: true,
              layer: "ocr",
              suggestions: [],
              message: "ocr: llm unavailable — " + errText(e),
            };
          }
          return {
            ran: true,
            layer: "ocr",
            suggestions,
            message: suggestions.length > 0 ? "ocr suggestions" : "ocr: no signal",
          };
        }
        // Thin text — fall through to vision escalation.
      }
      // Shot was null — fall through to vision escalation.
    }

    // ── Layer 3: Vision / Escalation ────────────────────────────────
    const escalateFromOcr = config.screen?.vision?.escalateFromOcr ?? true;
    const ocrRanButThin = ocrEnabled && shotPath !== null;
    const ocrRanButNoShot = ocrEnabled && shotPath === null;
    const ocrNeverRan = !ocrEnabled;

    let shouldVision = false;
    if (visionEnabled) {
      if (ocrNeverRan) {
        // Vision-only mode.
        shouldVision = true;
      } else if (ocrRanButThin && escalateFromOcr) {
        // Thin OCR + escalation on.
        shouldVision = true;
      } else if (ocrRanButNoShot && escalateFromOcr) {
        // No shot captured + escalation on.
        shouldVision = true;
      }
    }

    if (!shouldVision) {
      return {
        ran: true,
        layer: ocrEnabled ? "ocr" : "none",
        suggestions: [],
        message: "no signal",
      };
    }

    // Capture screenshot if we don't have one yet.
    if (!shotPath) {
      const shot = capture(maxImageBytes);
      if (shot) {
        shotPath = shot.path;
      }
    }

    if (!shotPath) {
      return {
        ran: true,
        layer: "vision",
        suggestions: [],
        message: "screenshot capture unavailable",
      };
    }

    // Check file size before reading.
    const fileSize = Bun.file(shotPath).size;
    if (fileSize > maxImageBytes) {
      process.stderr.write(
        "screen-infer: screenshot too large (" + fileSize + " bytes, cap " + maxImageBytes + ")\n",
      );
      return {
        ran: true,
        layer: "vision",
        suggestions: [],
        message: "screenshot too large for vision cap",
      };
    }

    // Build data URL.
    const raw = readFileSync(shotPath);
    const dataUrl = "data:image/jpeg;base64," + raw.toString("base64");

    // Resolve vision options.
    const baseUrl = config.screen?.vision?.baseUrl ?? config.worker?.baseUrl ?? "";
    const model = config.screen?.vision?.model ?? "qwen-vl-max";
    const apiKeyEnv = config.screen?.vision?.apiKeyEnv ?? config.worker?.apiKeyEnv;
    const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? "") : "";
    const vMaxTokens = llmMaxTokens(config);
    const vTimeoutMs = llmTimeoutMs(config);

    // Build prompt.
    const PROMPT =
      "You are an assistant analyzing a screenshot of the user's screen. " +
      "Infer whether the user is likely BLOCKED (waiting on something), " +
      "whether there is an implied DEADLINE, and what the current TASK is. " +
      "Respond with ONLY a JSON object — no markdown fences, no explanation. " +
      'Use this exact shape:\n' +
      '{"block":{"likely":true,"reason":"short reason"},"deadline":{"likely":true,"date":"YYYY-MM-DD","note":"note"},"task":{"likely":true,"task":"task name","note":"note"}}\n' +
      "Set likely:false when you have no signal. These are suggestions for a human to confirm.";

    // visionComplete throws on HTTP/network failure (unlike the OCR text path, which used to
    // swallow everything). Catch it here so this function honours its "never throws" contract —
    // an uncaught rejection would also leave screen-inferred.json stale at the daemon call site.
    let rawText: string;
    try {
      rawText = await vision(
        { baseUrl, model, apiKey, maxTokens: vMaxTokens, timeoutMs: vTimeoutMs },
        PROMPT,
        dataUrl,
      );
    } catch (e) {
      return {
        ran: true,
        layer: "vision",
        suggestions: [],
        message: "vision: unavailable — " + errText(e),
      };
    }

    // Tolerant JSON extraction: strip ```json fences, find first {…last}.
    let parsed: { block?: { likely?: boolean; reason?: string }; deadline?: { likely?: boolean; date?: string; note?: string }; task?: { likely?: boolean; task?: string; note?: string } };
    try {
      let s = rawText.trim();
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence && fence[1]) s = fence[1].trim();
      if (!s.startsWith("{")) {
        const a = s.indexOf("{");
        const b = s.lastIndexOf("}");
        if (a >= 0 && b > a) s = s.slice(a, b + 1);
      }
      parsed = JSON.parse(s) as typeof parsed;
    } catch {
      return {
        ran: true,
        layer: "vision",
        suggestions: [],
        message: "vision: could not parse suggestions",
      };
    }

    // Map parsed object → Suggestion[].
    const suggestions: Suggestion[] = [];
    if (parsed?.block?.likely) {
      const reason = parsed.block.reason || "unspecified";
      suggestions.push({
        kind: "block",
        text: "Possible block (from screen) — " + reason,
        emit: { type: "system.blocked", data: { reason } },
      });
    }
    if (parsed?.deadline?.likely && parsed.deadline.date) {
      const note = parsed.deadline.note || "confirm?";
      suggestions.push({
        kind: "deadline",
        text: "Possible deadline (from screen, " + parsed.deadline.date + ") — " + note,
        emit: { type: "system.task", data: { deadline: parsed.deadline.date } },
      });
    }
    if (parsed?.task?.likely && parsed.task.task) {
      const note = parsed.task.note ? " — " + parsed.task.note : "";
      suggestions.push({
        kind: "task",
        text: "Possible task (from screen) — " + parsed.task.task + note,
        emit: { type: "system.task", data: { task: parsed.task.task } },
      });
    }

    return {
      ran: true,
      layer: "vision",
      suggestions,
      message: suggestions.length > 0 ? "vision suggestions" : "vision: no signal",
    };
  } finally {
    // Always clean up the temp screenshot.
    if (shotPath) {
      try {
        unlinkSync(shotPath);
      } catch {
        // Best-effort cleanup — ignore errors.
      }
    }
  }
}

/** Short, log-safe description of a thrown value. */
function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? m.slice(0, 200) + "…" : m;
}

/**
 * Default text inference: uses config.worker backend to turn OCR'd text into suggestions.
 * Mock backend → deterministic empty; Anthropic → POST to gateway.
 *
 * THROWS on a hard failure (no baseUrl, network/TLS error, non-2xx, unusable response) so the
 * caller can report "llm unavailable" instead of an indistinguishable "no signal". Returns []
 * only when the model genuinely found nothing.
 */
async function defaultTextInfer(config: Config, text: string): Promise<Suggestion[]> {
  {
    const backend = config.worker?.backend ?? "mock";

    if (backend === "mock") {
      // Deterministic offline default — no suggestions.
      return [];
    }

    // Anthropic backend — POST to the same gateway as the Worker.
    const baseUrl = (config.worker?.baseUrl ?? "").replace(/\/+$/, "");
    const model = config.worker?.model ?? "qwen3.6-35b-a3b";
    const apiKeyEnv = config.worker?.apiKeyEnv;
    const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? "") : "";
    const maxTokens = llmMaxTokens(config);
    const timeoutMs = llmTimeoutMs(config);

    if (!baseUrl) {
      throw new Error("worker.baseUrl is not configured");
    }

    const PROMPT =
      "You are an assistant analyzing OCR text from the user's screen. " +
      "Infer whether the user is likely BLOCKED (waiting on something), " +
      "whether there is an implied DEADLINE, and what the current TASK is. " +
      "Respond with ONLY a JSON object — no markdown fences, no explanation. " +
      'Use this exact shape:\n' +
      '{"block":{"likely":true,"reason":"short reason"},"deadline":{"likely":true,"date":"YYYY-MM-DD","note":"note"},"task":{"likely":true,"task":"task name","note":"note"}}\n' +
      "Set likely:false when you have no signal. These are suggestions for a human to confirm.";

    const url = baseUrl + "/v1/messages";
    const body = {
      model,
      max_tokens: maxTokens,
      temperature: 0,
      system: "You are a helpful assistant that analyzes screen text to infer user state.",
      messages: [{ role: "user", content: PROMPT + "\n\n---\n\nOCR text:\n" + text }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = "Bearer " + apiKey;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error("HTTP " + res.status + ": " + body.slice(0, 200));
      }

      const json = (await res.json()) as unknown;
      const rawText = extractAnthropicContent(json);
      if (!rawText) {
        // Typically max_tokens exhausted by the model's think phase (see GOTCHA.md §1).
        throw new Error("empty response from model");
      }

      // Tolerant JSON extraction.
      let s = rawText.trim();
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence && fence[1]) s = fence[1].trim();
      if (!s.startsWith("{")) {
        const a = s.indexOf("{");
        const b = s.lastIndexOf("}");
        if (a >= 0 && b > a) s = s.slice(a, b + 1);
      }

      let parsed: {
        block?: { likely?: boolean; reason?: string };
        deadline?: { likely?: boolean; date?: string; note?: string };
        task?: { likely?: boolean; task?: string; note?: string };
      };
      try {
        parsed = JSON.parse(s) as typeof parsed;
      } catch {
        throw new Error("could not parse model response as JSON");
      }

      // Map → Suggestion[].
      const suggestions: Suggestion[] = [];
      if (parsed?.block?.likely) {
        const reason = parsed.block.reason || "unspecified";
        suggestions.push({
          kind: "block",
          text: "Possible block (from screen) — " + reason,
          emit: { type: "system.blocked", data: { reason } },
        });
      }
      if (parsed?.deadline?.likely && parsed.deadline.date) {
        const note = parsed.deadline.note || "confirm?";
        suggestions.push({
          kind: "deadline",
          text: "Possible deadline (from screen, " + parsed.deadline.date + ") — " + note,
          emit: { type: "system.task", data: { deadline: parsed.deadline.date } },
        });
      }
      if (parsed?.task?.likely && parsed.task.task) {
        const note = parsed.task.note ? " — " + parsed.task.note : "";
        suggestions.push({
          kind: "task",
          text: "Possible task (from screen) — " + parsed.task.task + note,
          emit: { type: "system.task", data: { task: parsed.task.task } },
        });
      }
      return suggestions;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract text content from an Anthropic Messages API response.
 * Defensive: handles content[] array and string fallback.
 */
function extractAnthropicContent(json: unknown): string | null {
  if (json == null || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const content = obj.content as unknown[] | undefined;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item != null && typeof item === "object" && "type" in item && (item as Record<string, unknown>).type === "text") {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n") || null;
}
