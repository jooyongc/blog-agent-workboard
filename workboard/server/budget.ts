import type { Env } from "./env";
import { HttpError } from "./http";
export type BudgetSettings = {monthly:number;weekly:number;article:number;revision:number;updated_at:string};
export function budgetPeriod(now=Date.now()) {
  return {month:new Date(now+9*3600000).toISOString().slice(0,7),week:String(Math.floor((now+9*3600000-4*86400000)/(7*86400000)))};
}
export async function budgetSettings(env:Env) {
  const settings=await env.WORKBOARD_DB.prepare("SELECT monthly,weekly,article,revision,updated_at FROM budget_settings WHERE id=1").first<BudgetSettings>();
  if(!settings) throw new HttpError(503,"예산 설정을 불러올 수 없습니다.");
  return settings;
}
export async function saveBudgetSettings(env:Env,input:unknown) {
  const value=input as Partial<BudgetSettings> | null;
  if(!value || ![value.monthly,value.weekly,value.article].every(v=>typeof v==="number" && Number.isFinite(v) && v>=0 && v<=10000 && Math.abs(v*100-Math.round(v*100))<1e-7))
    throw new HttpError(400,"예산은 0~10,000 USD 범위에서 소수점 둘째 자리까지 입력하세요.");
  if(value.weekly!>value.monthly! || value.article!>value.weekly!) throw new HttpError(400,"글당 한도 ≤ 주간 한도 ≤ 월간 한도로 설정하세요.");
  await env.WORKBOARD_DB.prepare("UPDATE budget_settings SET monthly=?,weekly=?,article=?,revision=revision+1,updated_at=? WHERE id=1 AND (monthly<>? OR weekly<>? OR article<>?)")
    .bind(value.monthly!,value.weekly!,value.article!,new Date().toISOString(),value.monthly!,value.weekly!,value.article!).run();
  return budgetSettings(env);
}
export async function budgetUsage(env:Env,now=Date.now()) {
  const period=budgetPeriod(now);
  const monthly=await env.WORKBOARD_DB.prepare("SELECT COALESCE(SUM(reserved),0) AS reserved,COALESCE(SUM(actual),0) AS actual FROM ai_runs WHERE month=?").bind(period.month).first<{reserved:number;actual:number}>();
  const weekly=await env.WORKBOARD_DB.prepare("SELECT COALESCE(SUM(reserved),0) AS reserved,COALESCE(SUM(actual),0) AS actual FROM ai_runs WHERE week=?").bind(period.week).first<{reserved:number;actual:number}>();
  return {month:period.month,monthly:monthly!,weekly:weekly!};
}
