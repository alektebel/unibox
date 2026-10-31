import { config } from "./config.js";

interface ChatMsg {
  role: "system" | "user";
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface LlmOpts {
  json?: boolean;
  temperature?: number;
  model?: string;
  /** qwen3.x reasons before answering; off by default — triage doesn't need it and it's ~5x slower. */
  thinking?: boolean;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Strip leaked <think> blocks and ```json fences so callers can JSON.parse the result. */
function clean(content: string, json: boolean): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (json) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
    if (fenced) out = fenced[1].trim();
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start > 0 && end > start) out = out.slice(start, end + 1);
  }
  return out;
}

export async function llm(messages: ChatMsg[], opts: LlmOpts = {}): Promise<string> {
  if (!config.nanApiKey) {
    throw new Error("NAN_API_KEY not set");
  }
  // tests run without the model: every caller has a fallback for when it's unavailable
  if (process.env.UNIBOX_LLM_OFF === "1") throw new Error("model switched off (UNIBOX_LLM_OFF)");
  const thinking = opts.thinking ?? config.llmThinking;
  const body = JSON.stringify({
    model: opts.model ?? config.llmModel,
    messages,
    temperature: opts.temperature ?? 0.3,
    chat_template_kwargs: { enable_thinking: thinking },
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const res = await fetch(`${config.nanBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.nanApiKey}`,
        },
        body,
        signal: AbortSignal.timeout(config.llmTimeoutMs),
      });
      if (!res.ok) {
        lastErr = new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 500)}`);
        if (RETRYABLE.has(res.status)) continue;
        throw lastErr;
      }
      const data = (await res.json()) as {
        choices: { message: { content: string | null } }[];
      };
      return clean(data.choices[0]?.message?.content ?? "", Boolean(opts.json));
    } catch (e) {
      lastErr = e;
      // Timeouts and network errors are worth a retry; HTTP 4xx was thrown above on purpose.
      if (e instanceof Error && /^LLM 4\d\d/.test(e.message) && !/^LLM (408|429)/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

/** Appended to prompts whose output the user reads. */
export function langLine(): string {
  return config.lang === "es"
    ? " Write every human-readable value (title, summary, task, reason) in Spanish; keep JSON keys and enum values in English."
    : "";
}

export function hasLlm(): boolean {
  return Boolean(config.nanApiKey);
}

/** Round-trip a tiny JSON request to confirm the key, gateway and model work. */
export async function llmCheck(): Promise<{ ok: boolean; model: string; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const out = await llm([{ role: "user", content: 'Reply with JSON {"ok":true}' }], {
      json: true,
      temperature: 0,
    });
    const ok = JSON.parse(out).ok === true;
    return { ok, model: config.llmModel, ms: Date.now() - t0, ...(ok ? {} : { error: out.slice(0, 200) }) };
  } catch (e) {
    return { ok: false, model: config.llmModel, ms: Date.now() - t0, error: String(e) };
  }
}
