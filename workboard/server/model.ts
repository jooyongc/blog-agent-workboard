import type { Env } from "./env";
import { HttpError } from "./http";
import { budgetSettings } from "./budget";
export type ModelId = "claude-haiku-4-5" | "claude-sonnet-5-5";
export const MODEL_RATES = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
} as const;
export class IncompleteResponse extends HttpError {
  constructor(public reason:string) { super(502,"AI 답변이 완결되지 않았습니다. 출력 복구가 필요합니다."); }
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
  model: ModelId = "claude-haiku-4-5",
) {
  if (env.AI_ENABLED !== "true" || !env.ANTHROPIC_API_KEY)
    throw new HttpError(503, "AI 연결이 준비되지 않았습니다.");
  const id = crypto.randomUUID(),
    now = Date.now(),
    month = new Date(now + 9 * 3600000).toISOString().slice(0, 7),
    week = String(
      Math.floor((now + 9 * 3600000 - 4 * 86400000) / (7 * 86400000)),
    );
  const rates = MODEL_RATES[model];
  const bytes = new TextEncoder().encode(system + JSON.stringify(input)).length;
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      redirect: "manual",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
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
      throw new HttpError(
        502,
        "AI 요청을 처리하지 못했습니다. 자동 재시도하지 않았습니다.",
      );
    }
    const d = (await res.json()) as {
      stop_reason: string;
      content: { type: string; text?: string; content?: unknown }[];
      usage: {
        input_tokens: number;
        output_tokens: number;
        server_tool_use?: { web_search_requests: number };
      };
    };
    cost =
      (d.usage.input_tokens * rates.input +
        d.usage.output_tokens * rates.output) /
        1000000 +
      (d.usage.server_tool_use?.web_search_requests ?? 0) * 0.01;
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
      data: JSON.parse(text.slice(start, end + 1)),
      cost_usd: cost,
      run_id: id,
      evidence_urls: Array.from(urls),
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
