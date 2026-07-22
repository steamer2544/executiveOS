// Vision LLM client — sends one image + prompt to an OpenAI-compatible /v1/chat/completions
// endpoint. Returns the model's raw text answer. Never parses suggestions (that happens in
// screen-infer.ts).

/** Options for a vision LLM call. */
export interface VisionOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Build the JSON body for an OpenAI-compatible /v1/chat/completions request.
 * Exported for unit testing without network.
 */
export function buildVisionRequestBody(
  model: string,
  maxTokens: number,
  prompt: string,
  imageDataUrl: string,
): object {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };
}

/**
 * Extract the text answer from an OpenAI-compatible chat/completions response
 * (choices[0].message.content, a string). Throws a clear error on a malformed/missing shape.
 */
export function extractOpenAiText(json: unknown): string {
  if (
    json == null ||
    !Array.isArray((json as Record<string, unknown>).choices)
  ) {
    throw new Error("vision: no text in response");
  }
  const choices = (json as Record<string, unknown>).choices as unknown[];
  if (choices.length === 0) {
    throw new Error("vision: no text in response");
  }
  const first = choices[0] as Record<string, unknown>;
  const msg = first.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg.content !== "string" || msg.content.trim() === "") {
    throw new Error("vision: no text in response");
  }
  return msg.content;
}

/**
 * Send one image + a prompt, return the model's raw text answer.
 * Throws on transport/HTTP error.
 */
export async function visionComplete(
  opts: VisionOptions,
  prompt: string,
  imageDataUrl: string,
): Promise<string> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const url = baseUrl + "/v1/chat/completions";
  const body = buildVisionRequestBody(opts.model, opts.maxTokens, prompt, imageDataUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) {
      headers["Authorization"] = "Bearer " + opts.apiKey;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error("vision HTTP " + res.status + ": " + t.slice(0, 300));
    }

    const json = (await res.json()) as unknown;
    return extractOpenAiText(json);
  } finally {
    clearTimeout(timer);
  }
}
