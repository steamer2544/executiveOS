// Probe: does the 9arm gateway support Anthropic-shape tool calling?
const baseUrl = "https://gateway.9arm.co";
const model = "qwen3.6-35b-a3b";
const key = process.env.EXECUTIVE_WORKER_KEY ?? "";

if (!key) {
  console.error("no EXECUTIVE_WORKER_KEY in env (cwd must hold .env)");
  process.exit(1);
}

const body = {
  model,
  max_tokens: 8192,
  temperature: 0,
  system: "You are a helpful assistant with tools. Use a tool when it is the right way to answer.",
  tools: [
    {
      name: "get_current_state",
      description:
        "Get the owner's current work state: project, task, branch, current file, whether tests pass.",
      input_schema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of fields to return.",
          },
        },
        required: [],
      },
    },
    {
      name: "read_file",
      description: "Read a file from the repo.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative path" } },
        required: ["path"],
      },
    },
  ],
  messages: [{ role: "user", content: "ตอนนี้ผมทำงานอะไรอยู่ แล้วเทสต์ผ่านไหม" }],
};

const t0 = Date.now();
const res = await fetch(baseUrl + "/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    Authorization: "Bearer " + key,
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180000),
});

const ms = Date.now() - t0;
console.log("HTTP", res.status, "in", ms, "ms");
const text = await res.text();
if (!res.ok) {
  console.log("BODY:", text.slice(0, 1200));
  process.exit(1);
}
const json = JSON.parse(text);
console.log("stop_reason:", json.stop_reason);
console.log("usage:", JSON.stringify(json.usage));
console.log("content block types:", (json.content ?? []).map((b: any) => b.type));
console.log("FULL content:", JSON.stringify(json.content, null, 2).slice(0, 2500));
