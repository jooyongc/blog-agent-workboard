import type { Env } from "./env";
import { HttpError } from "./http";
import { requestGemini, parseGemini } from "./gemini";
import { budgetSettings } from "./budget";
export type ModelId =
  | "claude-haiku-4-5"
  | "claude-sonnet-5-5"
  | "gemini-3.8-flash"
  | "gemini-3.1-pro-preview";
export const MODEL_RATES = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
} as const;
export function workerModel(env: Env): ModelId {
  return env.AI_PROVIDER === "gemini" ? "gemini-3.8-flash" : "claude-haiku-4-5";
}
export function reviewModel(env: Env): ModelId {
  return env.AI_PROVIDER === "gemini"
    ? "gemini-3.1-pro-preview"
    : "claude-sonnet-5-5";
}
function modelRates(model: ModelId, tokens: number) {
  if (model === "gemini-3.1-pro-preview" && tokens > 200000)
    return { input: 4, output: 18 };
  if (model === "gemini-3.8-flash" && Date.now() >= Date.UTC(2027, 0, 1))
    return { input: 1.5, output: 7.5 };
  return MODEL_RATES[model];
}
export class ProviderWait extends HttpError {
  constructor(
    public code: number,
    public retrySeconds: number,
  ) {
    super(
      503,
      `AI 제공자가 일시적으로 요청을 제한했습니다 (HTTP ${code}). 잠시 후 자동 재개합니다.`,
    );
  }
}
export class IncompleteResponse extends HttpError {
  constructor(public reason: string) {
    super(502, "AI 답변이 완결되지 않았습니다. 출력 복구가 필요합니다.");
  }
}
export class BudgetWait extends HttpError {
  constructor(
    public scope: "weekly" | "monthly" | "article",
    public retryAt: string,
    message: string,
    public revision = 0,
  ) {
    super(429, message);
  }
}
export function budgetReset(
  scope: "weekly" | "monthly" | "article",
  now = Date.now(),
) {
  const local = new Date(now + 9 * 3600000);
  return scope === "weekly"
    ? new Date(
        (Math.floor((now + 9 * 3600000 - 4 * 86400000) / (7 * 86400000)) + 1) *
          7 *
          86400000 +
          4 * 86400000 -
          9 * 3600000,
      ).toISOString()
    : new Date(
        Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) -
          9 * 3600000,
      ).toISOString();
}
export async function modelJson(
  env: Env,
  key: string,
  system: string,
  input: unknown,
  maxTokens = 3500,
  search?: string[],
  model: ModelId = workerModel(env),
) {
  const gemini = model.startsWith("gemini-");
  const apiKey = gemini ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
  if (env.AI_ENABLED !== "true" || !apiKey)
    throw new HttpError(503, "AI 연결이 준비되지 않았습니다.");
  const id = crypto.randomUUID(),
    now = Date.now(),
    month = new Date(now + 9 * 3600000).toISOString().slice(0, 7),
    week = String(
      Math.floor((now + 9 * 3600000 - 4 * 86400000) / (7 * 86400000)),
    );
  const bytes = new TextEncoder().encode(system + JSON.stringify(input)).length;
  const rates = modelRates(model, bytes);
  const reservation =
    (bytes * rates.input) / 1000000 +
    (maxTokens * rates.output) / 1000000 +
    (search?.length ? 0.1 : 0);
  try {
    await env.WORKBOARD_DB.prepare(
      "INSERT INTO ai_runs(id,article_key,month,week,reserved,status,created_at,model) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        key,
        month,
        week,
        reservation,
        "running",
        new Date(now).toISOString(),
        model,
      )
      .run();
  } catch (error) {
    const detail = String(error);
    if (detail.includes("budget")) {
      const settings = await budgetSettings(env, key.split("/")[0]);
      const scope = detail.includes("monthly_budget")
        ? "monthly"
        : detail.includes("weekly_budget")
          ? "weekly"
          : "article";
      const label =
        scope === "monthly" ? "월간" : scope === "weekly" ? "주간" : "이 글의";
      throw new BudgetWait(
        scope,
        budgetReset(scope, now),
        `${label} AI 예산 $${settings[scope].toFixed(2)} 한도에 도달했습니다.`,
        settings.revision,
      );
    }
    throw new HttpError(503, "AI 예산 예약을 저장하지 못했습니다.");
  }
  let cost = 0,
    settled = false;
  try {
    const res = gemini
      ? await requestGemini(apiKey, model, system, input, maxTokens, search)
      : await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          redirect: "manual",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: JSON.stringify(input) }],
            ...(search?.length
              ? {
                  tools: [
                    {
                      type: "web_search_20250305",
                      name: "web_search",
                      max_uses: 3,
                      allowed_domains: search,
                    },
                  ],
                }
              : {}),
          }),
        });
    if (!res.ok) {
      settled = true;
      if ([429, 500, 502, 503, 529].includes(res.status))
        throw new ProviderWait(
          res.status,
          Math.max(
            30,
            Math.min(300, Number(res.headers.get("Retry-After")) || 60),
          ),
        );
      const detail = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const hint =
        typeof detail?.error?.message === "string"
          ? detail.error.message
              .replaceAll(apiKey, "[credential]")
              .replace(/sk-[a-zA-Z0-9_-]+/g, "[credential]")
              .slice(0, 240)
          : "연결·모델 설정을 확인하세요.";
      throw new HttpError(
        502,
        "AI 요청이 거절되었습니다 (HTTP " + res.status + "): " + hint,
      );
    }
    const raw = (await res.json()) as any;
    const g = gemini ? await parseGemini(raw, search) : null;
    const d = gemini
      ? {
          stop_reason:
            g!.finish_reason === "STOP" ? "end_turn" : g!.finish_reason,
          content: [{ type: "text", text: g!.text }],
          usage: {
            input_tokens: g!.input_tokens,
            output_tokens: g!.output_tokens,
            server_tool_use: { web_search_requests: 0 },
          },
        }
      : (raw as {
          stop_reason: string;
          content: { type: string; text?: string; content?: unknown }[];
          usage: {
            input_tokens: number;
            output_tokens: number;
            server_tool_use?: { web_search_requests: number };
          };
        });
    const actualRates = modelRates(model, d.usage.input_tokens);
    cost =
      ((d.usage.input_tokens - (g?.cached_tokens || 0)) * actualRates.input +
        ((g?.cached_tokens || 0) * actualRates.input) / 10 +
        d.usage.output_tokens * actualRates.output) /
        1000000 +
      (d.usage.server_tool_use?.web_search_requests ?? 0) * 0.01 +
      (g?.searches || 0) * 0.014;
    settled = true;
    await env.WORKBOARD_DB.prepare(
      "UPDATE ai_runs SET actual=?,reserved=?,status='complete' WHERE id=?",
    )
      .bind(cost, cost, id)
      .run();
    if (d.stop_reason !== "end_turn")
      throw new IncompleteResponse(d.stop_reason);
    const text = d.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const start = text.indexOf("{"),
      end = text.lastIndexOf("}");
    const urls = new Set<string>();
    function collect(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      const item = value as Record<string, unknown>;
      if (typeof item.url === "string") urls.add(item.url);
      Object.values(item).forEach(collect);
    }
    collect(d.content);
    return {
      data: g?.data || JSON.parse(text.slice(start, end + 1)),
      cost_usd: cost,
      run_id: id,
      evidence_urls: g?.evidence_urls || Array.from(urls),
    };
  } catch (e) {
    await env.WORKBOARD_DB.prepare(
      "UPDATE ai_runs SET actual=?,reserved=CASE WHEN ? THEN ? ELSE reserved END,status='failed' WHERE id=?",
    )
      .bind(settled ? cost : null, settled ? 1 : 0, cost, id)
      .run();
    throw e instanceof HttpError
      ? e
      : new HttpError(502, "AI 응답 형식을 확인하지 못했습니다.");
  }
}
