import type { Env } from "./env";
import { HttpError } from "./http";
export type BudgetSettings = {
  site_id: string;
  monthly: number;
  weekly: number;
  article: number;
  revision: number;
  updated_at: string;
};
export function budgetPeriod(now = Date.now()) {
  return {
    month: new Date(now + 9 * 3600000).toISOString().slice(0, 7),
    week: String(
      Math.floor((now + 9 * 3600000 - 4 * 86400000) / (7 * 86400000)),
    ),
  };
}
export async function budgetSettings(env: Env, siteId: string) {
  const settings = await env.WORKBOARD_DB.prepare(
    "SELECT site_id,monthly,weekly,article,revision,updated_at FROM workspace_budget_settings WHERE site_id=?",
  )
    .bind(siteId)
    .first<BudgetSettings>();
  if (!settings)
    throw new HttpError(
      503,
      "이 워크스페이스의 예산 설정을 불러올 수 없습니다.",
    );
  return settings;
}
export async function saveBudgetSettings(
  env: Env,
  siteId: string,
  input: unknown,
) {
  const value = input as Partial<BudgetSettings> | null;
  if (
    !value ||
    ![value.monthly, value.weekly, value.article].every(
      (v) =>
        typeof v === "number" &&
        Number.isFinite(v) &&
        v >= 0 &&
        v <= 10000 &&
        Math.abs(v * 100 - Math.round(v * 100)) < 1e-7,
    )
  )
    throw new HttpError(
      400,
      "예산은 0~10,000 USD 범위에서 소수점 둘째 자리까지 입력하세요.",
    );
  if (value.weekly! > value.monthly! || value.article! > value.weekly!)
    throw new HttpError(400, "글당 한도 ≤ 주간 한도 ≤ 월간 한도로 설정하세요.");
  await env.WORKBOARD_DB.prepare(
    "UPDATE workspace_budget_settings SET monthly=?,weekly=?,article=?,revision=revision+1,updated_at=? WHERE site_id=? AND (monthly<>? OR weekly<>? OR article<>?)",
  )
    .bind(
      value.monthly!,
      value.weekly!,
      value.article!,
      new Date().toISOString(),
      siteId,
      value.monthly!,
      value.weekly!,
      value.article!,
    )
    .run();
  return budgetSettings(env, siteId);
}
export async function budgetUsage(env: Env, siteId: string, now = Date.now()) {
  const period = budgetPeriod(now);
  const monthly = await env.WORKBOARD_DB.prepare(
    "SELECT COALESCE(SUM(reserved),0) AS reserved,COALESCE(SUM(actual),0) AS actual FROM ai_runs WHERE month=? AND substr(article_key,1,instr(article_key,'/')-1)=?",
  )
    .bind(period.month, siteId)
    .first<{ reserved: number; actual: number }>();
  const weekly = await env.WORKBOARD_DB.prepare(
    "SELECT COALESCE(SUM(reserved),0) AS reserved,COALESCE(SUM(actual),0) AS actual FROM ai_runs WHERE week=? AND substr(article_key,1,instr(article_key,'/')-1)=?",
  )
    .bind(period.week, siteId)
    .first<{ reserved: number; actual: number }>();
  return { month: period.month, monthly: monthly!, weekly: weekly! };
}
export async function budgetExamples(env: Env, siteId: string) {
  const rows = await env.WORKBOARD_DB.prepare(
    "SELECT j.title,j.status,COUNT(r.id) AS calls,COALESCE(SUM(r.actual),0) AS actual,COALESCE(SUM(r.reserved),0) AS reserved FROM content_jobs j JOIN ai_runs r ON r.article_key=j.site_id||'/'||j.slug WHERE j.site_id=? AND r.month=? GROUP BY j.id ORDER BY j.created_at DESC LIMIT 5",
  )
    .bind(siteId, budgetPeriod().month)
    .all();
  return rows.results;
}
