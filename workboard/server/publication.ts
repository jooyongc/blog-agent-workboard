import type { Env } from "./env";
import type { Workspace, DraftInput } from "../shared/types";
import { connection, draftPayload, renderMarkdown } from "./content";
import { publicHttps, variable, articleUrl } from "./registry";
import { schema, schemaHtml } from "./seo";
import { HttpError, remote } from "./http";
import { savedRefresh } from "./oauth";
type Receipt = { phase: string; remote_json: string | null };
async function receipt(env: Env, job: string, lang: string, phase: string) {
  return env.WORKBOARD_DB.prepare(
    "SELECT phase,remote_json FROM publication_receipts WHERE job_id=? AND lang=? AND phase=?",
  )
    .bind(job, lang, phase)
    .first<Receipt>();
}
async function begin(env: Env, job: string, lang: string, phase: string) {
  const r = await receipt(env, job, lang, phase);
  if (r?.remote_json) return JSON.parse(r.remote_json);
  if (r)
    throw new HttpError(
      409,
      "이전 전송 결과가 불명확합니다. 중복 발행을 방지하려면 원격 결과를 확인하세요.",
    );
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO publication_receipts(job_id,lang,phase,updated_at) VALUES(?,?,?,?)",
  )
    .bind(job, lang, phase, new Date().toISOString())
    .run();
  return null;
}
async function finish(
  env: Env,
  job: string,
  lang: string,
  phase: string,
  value: unknown,
) {
  await env.WORKBOARD_DB.prepare(
    "UPDATE publication_receipts SET remote_json=?,updated_at=? WHERE job_id=? AND lang=? AND phase=?",
  )
    .bind(JSON.stringify(value), new Date().toISOString(), job, lang, phase)
    .run();
  return value;
}
export async function bloggerToken(w: Workspace, env: Env) {
  const c = w.connection;
  const refresh =
    variable(env, c.refresh_token_env) || (await savedRefresh(env, w.site_id));
  if (
    variable(env, c.client_id_env) &&
    variable(env, c.client_secret_env) &&
    refresh
  ) {
    const res = await remote("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: variable(env, c.client_id_env),
        client_secret: variable(env, c.client_secret_env),
        refresh_token: refresh,
      }).toString(),
    });
    if (!res.ok) throw new HttpError(503, "Blogger OAuth 재인증이 필요합니다.");
    const d = (await res.json()) as { access_token: string };
    return d.access_token;
  }
  const token = variable(env, c.key_env);
  if (!token) throw new HttpError(503, "Blogger OAuth 연결 변수가 필요합니다.");
  return token;
}
function html(
  w: Workspace,
  input: DraftInput,
  lang: string,
  url: string,
  date: string,
) {
  const a = input.translations[lang];
  return (
    renderMarkdown(a.content_md) +
    schemaHtml(schema(w, a, lang, url, date, input.featured_image_url))
  );
}
export async function publishJob(
  env: Env,
  w: Workspace,
  jobId: string,
  input: DraftInput,
  mode: "draft" | "publish",
) {
  const date = new Date().toISOString();
  if (w.integration === "blogger") {
    const token = await bloggerToken(w, env),
      base = `https://www.googleapis.com/blogger/v3/blogs/${w.connection.blog_id}/posts`,
      headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      };
    const drafts: Record<string, { id: string; url: string }> = {};
    for (const lang of w.languages) {
      const prior = await begin(env, jobId, lang, "create");
      if (prior) {
        drafts[lang] = prior;
        continue;
      }
      const a = input.translations[lang];
      const r = await remote(base + "?isDraft=true", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "blogger#post",
          title: a.title,
          content: renderMarkdown(a.content_md),
          labels: [
            lang === "ja" ? "日本語" : "English",
            input.category,
            ...a.tags,
          ],
        }),
      });
      if (!r.ok)
        throw new HttpError(502, "Blogger 초안 전송 결과를 확인하세요.");
      const row = (await r.json()) as { id: string; url: string };
      if (!row.id || !row.url)
        throw new HttpError(502, "Blogger 실제 글 주소를 확인하지 못했습니다.");
      drafts[lang] = row;
      await finish(env, jobId, lang, "create", row);
    }
    for (const lang of w.languages) {
      if (await receipt(env, jobId, lang, "package")) continue;
      const row = drafts[lang];
      const other = w.languages
        .filter((l) => l !== lang)
        .map(
          (l) =>
            `<a href="${drafts[l].url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" hreflang="${l}">${l === "ja" ? "日本語" : "English"}</a>`,
        )
        .join(" · ");
      const content = `<div lang="${lang}"><nav aria-label="Language">${other}</nav>${html(w, input, lang, row.url, date)}</div>`;
      const r = await remote(base + "/" + row.id, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          id: row.id,
          title: input.translations[lang].title,
          content,
          labels: [
            lang === "ja" ? "日本語" : "English",
            input.category,
            ...input.translations[lang].tags,
          ],
        }),
      });
      if (!r.ok)
        throw new HttpError(502, "Blogger 구조화 데이터 저장을 확인하세요.");
      const verify = await remote(base + "/" + row.id, { headers });
      const saved = (await verify.json()) as {
        content: string;
        labels: string[];
      };
      if (
        !verify.ok ||
        !saved.content.includes("application/ld+json") ||
        !saved.labels.includes(lang === "ja" ? "日本語" : "English")
      )
        throw new HttpError(502, "Blogger 저장 재검증에 실패했습니다.");
      await finishPackage(env, jobId, lang);
    }
    if (mode === "publish")
      for (const lang of w.languages) {
        const prior = await begin(env, jobId, lang, "publish");
        if (prior) continue;
        const r = await remote(base + "/" + drafts[lang].id + "/publish", {
          method: "POST",
          headers,
        });
        if (!r.ok) throw new HttpError(502, "Blogger 게시 결과를 확인하세요.");
        const row = (await r.json()) as {
          id: string;
          url: string;
          status: string;
        };
        if (!row.id || !row.url)
          throw new HttpError(502, "Blogger 발행 주소가 없습니다.");
        await finish(env, jobId, lang, "publish", row);
        drafts[lang] = row;
      }
    return {
      mode,
      posts: drafts,
      hreflang_note:
        "본문 언어 링크는 실제 반환 URL로 저장했습니다. Blogger 테마의 head hreflang은 플랫폼 설정에서 별도 확인하세요.",
    };
  }
  const lang = w.languages[0];
  const prior = await begin(env, jobId, lang, "create");
  let created: Record<string, unknown>;
  if (prior) created = prior;
  else if (w.integration === "supabase") {
    const c = connection(w, env),
      q = new URLSearchParams({
        select: "id,slug,status",
        slug: "eq." + input.slug,
      });
    const check = await remote(`${c.url}/rest/v1/${c.table}?${q}`, {
      headers: c.headers,
    });
    if (!check.ok || ((await check.json()) as unknown[]).length)
      throw new HttpError(
        409,
        "원격에 같은 slug가 있거나 조회가 실패했습니다. 기존 글은 자동 수정하지 않습니다.",
      );
    const r = await remote(`${c.url}/rest/v1/${c.table}`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify(draftPayload(w, input)),
    });
    if (!r.ok) throw new HttpError(502, "사이트 초안 생성 결과를 확인하세요.");
    const rows = (await r.json()) as Record<string, unknown>[];
    created = rows[0];
    if (!created?.id)
      throw new HttpError(502, "사이트 초안 ID를 확인하지 못했습니다.");
    await finish(env, jobId, lang, "create", created);
  } else {
    const r = await remote(
      publicHttps(variable(env, w.connection.url_env)).href,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + variable(env, w.connection.key_env),
          "Content-Type": "application/json",
          "Idempotency-Key": jobId,
        },
        body: JSON.stringify({
          ...input,
          status: mode === "publish" ? "published" : "draft",
          schema: Object.fromEntries(
            w.languages.map((l) => [
              l,
              schema(
                w,
                input.translations[l],
                l,
                articleUrl(w, input.slug),
                date,
                input.featured_image_url,
              ),
            ]),
          ),
        }),
      },
    );
    if (!r.ok) throw new HttpError(502, "사이트 API 전송 결과를 확인하세요.");
    created = (await r.json()) as Record<string, unknown>;
    if (
      typeof created.id !== "string" ||
      !created.id ||
      created.status !== (mode === "publish" ? "published" : "draft") ||
      (mode === "publish" &&
        (typeof created.url !== "string" ||
          !created.url.startsWith(w.site_url.replace(/\/$/, "") + "/")))
    )
      throw new HttpError(
        502,
        "사이트 API가 글 ID·상태·공개 주소를 확인하지 못했습니다.",
      );
    await finish(env, jobId, lang, "create", created);
    return { mode, posts: { [lang]: created } };
  }
  if (mode === "publish" && w.integration === "supabase") {
    const completed = await begin(env, jobId, lang, "publish");
    if (!completed) {
      const c = connection(w, env),
        url = articleUrl(w, input.slug);
      const payload = {
        status: "published",
        content: html(w, input, lang, url, date),
        ...(w.connection.template === "koreabylocal"
          ? { published_at: date }
          : {}),
      };
      const r = await remote(
        `${c.url}/rest/v1/${c.table}?id=eq.${encodeURIComponent(String(created.id))}&slug=eq.${input.slug}&status=eq.draft`,
        {
          method: "PATCH",
          headers: { ...c.headers, Prefer: "return=representation" },
          body: JSON.stringify(payload),
        },
      );
      if (!r.ok) throw new HttpError(502, "사이트 게시 결과를 확인하세요.");
      const rows = (await r.json()) as Record<string, unknown>[];
      if (rows.length !== 1 || rows[0].status !== "published")
        throw new HttpError(
          409,
          "게시 상태가 예상과 다릅니다. 원격 결과를 확인하세요.",
        );
      await finish(env, jobId, lang, "publish", rows[0]);
      created = rows[0];
    }
  }
  return { mode, posts: { [lang]: created } };
}
async function finishPackage(env: Env, id: string, lang: string) {
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO publication_receipts(job_id,lang,phase,remote_json,updated_at) VALUES(?,?,'package','{}',?)",
  )
    .bind(id, lang, new Date().toISOString())
    .run();
}
