import type { Workspace } from "../shared/types";
import type { Env } from "./env";
import { HttpError } from "./http";
export async function listWorkspaces(env: Env) {
  const r = await env.WORKBOARD_DB.prepare(
    "SELECT config_json FROM workspace_records WHERE disabled=0 ORDER BY rowid",
  ).all<{ config_json: string }>();
  return r.results.map((r) =>
    resolveUrl(env, JSON.parse(r.config_json) as Workspace),
  );
}
export async function workspace(env: Env, id: string) {
  if (id === "asty-cabin")
    throw new HttpError(404, "연결을 종료한 사이트입니다.");
  const r = await env.WORKBOARD_DB.prepare(
    "SELECT config_json FROM workspace_records WHERE site_id=? AND disabled=0",
  )
    .bind(id)
    .first<{ config_json: string }>();
  if (!r) throw new HttpError(404, "워크스페이스를 찾지 못했습니다.");
  return resolveUrl(env, JSON.parse(r.config_json) as Workspace);
}
export function publicHttps(value: unknown) {
  if (typeof value !== "string" || value.length > 2000)
    throw new HttpError(400, "HTTPS 주소를 확인해 주세요.");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(400, "주소 형식을 확인해 주세요.");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !u.hostname.includes(".") ||
    /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|\d[\d.]*|\[)/i.test(
      u.hostname,
    )
  )
    throw new HttpError(400, "공개 HTTPS 주소를 사용해 주세요.");
  return u;
}
export function validateWorkspace(input: Workspace) {
  if (
    !input ||
    !/^([a-z0-9]+-)*[a-z0-9]+$/.test(input.site_id) ||
    input.site_id.length > 64 ||
    input.site_id === "asty-cabin"
  )
    throw new HttpError(400, "워크스페이스 ID를 확인해 주세요.");
  publicHttps(input.site_url);
  publicHttps(input.admin_url);
  if (
    input.article_path &&
    !/^\/[a-z0-9/_-]*\{slug\}[a-z0-9/_-]*$/i.test(input.article_path)
  )
    throw new HttpError(400, "글 주소 경로에 {slug}를 포함해 주세요.");
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 100 ||
    typeof input.description !== "string" ||
    input.description.length > 1000 ||
    !["blogger", "supabase", "webhook"].includes(input.integration) ||
    !Array.isArray(input.languages) ||
    !input.languages.length ||
    input.languages.length > 3 ||
    new Set(input.languages).size !== input.languages.length ||
    input.languages.some((l) => !["en", "ja", "zh-hans"].includes(l)) ||
    !Array.isArray(input.categories) ||
    !input.categories.length ||
    input.categories.length > 20 ||
    input.categories.some(
      (c) => typeof c !== "string" || !c.trim() || c.length > 50,
    )
  )
    throw new HttpError(400, "이름·연결 방식·언어·카테고리를 확인해 주세요.");
  const c = input.connection;
  if (!c || !c.url_env || !c.key_env)
    throw new HttpError(400, "연결 변수 이름이 필요합니다.");
  for (const key of [
    "url_env",
    "key_env",
    "client_id_env",
    "client_secret_env",
    "refresh_token_env",
  ] as const)
    if (c[key] && !/^[A-Z][A-Z0-9_]{2,79}$/.test(c[key]!))
      throw new HttpError(400, "CF 변수 이름은 대문자·숫자·밑줄을 사용하세요.");
  for (const key of ["schema", "table"] as const)
    if (c[key] && !/^[a-z][a-z0-9_]{0,62}$/.test(c[key]!))
      throw new HttpError(400, "DB 스키마·테이블 이름을 확인해 주세요.");
  if (input.integration === "supabase" && input.languages.length !== 1)
    throw new HttpError(
      400,
      "Supabase 어댑터는 단일 언어 사이트용입니다. 다국어는 게시 API 연결을 사용하세요.",
    );
  if (input.integration === "supabase" && (!c.schema || !c.table))
    throw new HttpError(400, "DB 스키마와 테이블이 필요합니다.");
  if (input.integration === "blogger" && !/^\d+$/.test(c.blog_id ?? ""))
    throw new HttpError(400, "Blogger blogId가 필요합니다.");
  const s = input.strategy;
  if (
    !s ||
    (s.media_mode !== undefined &&
      !["stock", "hybrid"].includes(s.media_mode)) ||
    (s.generate_video !== undefined && typeof s.generate_video !== "boolean") ||
    typeof s.voice !== "string" ||
    s.voice.length > 5000 ||
    typeof s.audience !== "string" ||
    s.audience.length > 2000 ||
    !Array.isArray(s.pillars) ||
    !s.pillars.length ||
    s.pillars.length > 20 ||
    !Array.isArray(s.entities) ||
    s.entities.length > 30 ||
    !Array.isArray(s.source_domains) ||
    s.source_domains.length > 20 ||
    s.source_domains.some(
      (d) => typeof d !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d),
    ) ||
    !Array.isArray(s.templates) ||
    s.templates.length > 30 ||
    s.templates.some(
      (t) =>
        !input.categories.includes(t.category) ||
        typeof t.title !== "string" ||
        t.title.length > 300 ||
        typeof t.keyword !== "string" ||
        t.keyword.length > 200 ||
        typeof t.format !== "string" ||
        t.format.length > 50 ||
        [t.emoji, t.hint, t.group, t.direction].some(
          (v) => v !== undefined && (typeof v !== "string" || v.length > 3000),
        ) ||
        (t.aeo !== undefined && typeof t.aeo !== "boolean") ||
        (t.tags !== undefined &&
          (!Array.isArray(t.tags) ||
            t.tags.length > 10 ||
            t.tags.some((v) => typeof v !== "string" || v.length > 100))) ||
        (t.seasonal_months !== undefined &&
          (!Array.isArray(t.seasonal_months) ||
            t.seasonal_months.some(
              (v) => !Number.isInteger(v) || v < 1 || v > 12,
            ))),
    ) ||
    !Number.isInteger(s.min_score) ||
    s.min_score < 50 ||
    s.min_score > 100 ||
    !Number.isInteger(s.required_images) ||
    s.required_images < 0 ||
    s.required_images > 4
  )
    throw new HttpError(400, "SEO·AEO·GEO 전략 설정을 확인해 주세요.");
  if (s.gsc_url) publicHttps(s.gsc_url);
  const a = input.schedule;
  if (
    !a ||
    typeof a.enabled !== "boolean" ||
    typeof a.auto_generate !== "boolean" ||
    !Number.isInteger(a.interval_days) ||
    a.interval_days < 1 ||
    a.interval_days > 90 ||
    !Number.isInteger(a.hour_kst) ||
    a.hour_kst < 0 ||
    a.hour_kst > 23 ||
    !Number.isInteger(a.minute) ||
    ![0, 15, 30, 45].includes(a.minute) ||
    !["draft", "publish"].includes(a.mode) ||
    (a.next_run && !Number.isFinite(Date.parse(a.next_run)))
  )
    throw new HttpError(400, "발행 주기와 시간을 확인해 주세요.");
  return input;
}
export async function putWorkspace(env: Env, input: Workspace, create = false) {
  const w = validateWorkspace(input);
  const prior = await env.WORKBOARD_DB.prepare(
    "SELECT config_json FROM workspace_records WHERE site_id=?",
  )
    .bind(w.site_id)
    .first();
  if (create && prior)
    throw new HttpError(409, "같은 ID의 워크스페이스가 있습니다.");
  if (!create && !prior)
    throw new HttpError(404, "워크스페이스를 찾지 못했습니다.");
  const old = (prior as { config_json: string } | null)?.config_json
    ? (JSON.parse((prior as { config_json: string }).config_json) as Workspace)
    : null;
  if (
    w.schedule.enabled &&
    (!w.schedule.next_run ||
      !old?.schedule.enabled ||
      old.schedule.hour_kst !== w.schedule.hour_kst ||
      old.schedule.minute !== w.schedule.minute ||
      old.schedule.interval_days !== w.schedule.interval_days)
  )
    w.schedule.next_run = nextSlot(w.schedule.hour_kst, w.schedule.minute);
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO workspace_records(site_id,config_json,updated_at) VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at",
  )
    .bind(w.site_id, JSON.stringify(w), new Date().toISOString())
    .run();
  return w;
}
export function nextSlot(hour: number, minute: number, now = Date.now()) {
  const d = new Date(now + 9 * 3600000);
  d.setUTCHours(hour, minute, 0, 0);
  let time = d.getTime() - 9 * 3600000;
  if (time <= now) time += 86400000;
  return new Date(time).toISOString();
}
export function variable(env: Env, key: string | undefined) {
  return key && typeof env[key] === "string" ? (env[key] as string) : "";
}
export function articleUrl(w: Workspace, slug: string) {
  if (typeof slug !== "string" || !slug.trim() || slug.length > 200)
    throw new HttpError(400, "글 주소를 확인해 주세요.");
  return (
    w.site_url.replace(/\/$/, "") +
    (w.article_path ?? "/blog/{slug}").replace(
      "{slug}",
      encodeURIComponent(slug),
    )
  );
}
export async function readiness(w: Workspace, env: Env) {
  const c = w.connection;
  const stored =
    w.integration === "blogger"
      ? !!(await env.WORKBOARD_DB.prepare(
          "SELECT site_id FROM connection_tokens WHERE site_id=?",
        )
          .bind(w.site_id)
          .first())
      : false;
  return {
    site_id: w.site_id,
    url_env: c.url_env,
    key_env: c.key_env,
    ready:
      w.integration === "blogger"
        ? !!(
            variable(env, c.key_env) ||
            (variable(env, c.client_id_env) &&
              variable(env, c.client_secret_env) &&
              (variable(env, c.refresh_token_env) || stored))
          )
        : !!(variable(env, c.url_env) && variable(env, c.key_env)),
    schedule_enabled: w.schedule.enabled,
  };
}

function resolveUrl(env: Env, w: Workspace) {
  const url = variable(env, w.site_url_env);
  if (url) {
    const before = new URL(w.site_url);
    const after = publicHttps(url);
    if (new URL(w.admin_url).origin === before.origin)
      w.admin_url = after.origin + new URL(w.admin_url).pathname;
    w.site_url = after.origin + after.pathname.replace(/\/$/, "");
  }
  return w;
}
