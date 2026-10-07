import { assertReviewedPhotos } from "./generated-media";
import { approvedMedia } from "./media";
import type { Env } from "./env";
import type { Workspace, DraftInput } from "../shared/types";
import { connection, draftPayload, renderMarkdown } from "./content";
import { publicHttps, variable, articleUrl } from "./registry";
import { schema, schemaHtml } from "./seo";
import { HttpError, remote } from "./http";
import { savedRefresh, googleCredentials } from "./oauth";
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
    const { client, secret } = googleCredentials(env, w);
    const res = await remote("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client,
        client_secret: secret,
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
  if (w.schedule.owner === "aside")
    throw new HttpError(
      409,
      "Korea Buy List는 Aside에서 발행합니다. Cloudflare 전송은 중지되었습니다.",
    );
  if (
    env.MEDIA_POLICY === "adobe-generated" &&
    w.languages.some((lang) => !approvedMedia(input.translations[lang]))
  )
    throw new HttpError(
      409,
      "MEDIA_REVIEW: 한국 배경에 맞는 Adobe Stock·직접 생성 이미지 2장 이상으로 교체해야 합니다.",
    );
  if (env.MEDIA_POLICY === "adobe-generated")
    await assertReviewedPhotos(
      env,
      w.languages.flatMap((lang) => input.translations[lang].images || []),
    );
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
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify({
                article: input.translations[lang],
                featured_image: input.featured_image_url,
                drafts,
                site_url: w.site_url,
              }),
            ),
          ),
        ),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const packaged = await receipt(env, jobId, lang, "package");
      if (
        packaged?.remote_json &&
        JSON.parse(packaged.remote_json).hash === hash
      )
        continue;
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
      const verify = await remote(base + "/" + row.id + "?view=ADMIN", {
        headers,
      });
      const saved = (await verify.json()) as {
        content: string;
        labels: string[];
        status?: string;
        title?: string;
      };
      if (
        !verify.ok ||
        typeof saved.content !== "string" ||
        !saved.content.includes("application/ld+json") ||
        !Array.isArray(saved.labels) ||
        (mode === "draft" && saved.status !== "DRAFT") ||
        saved.title !== input.translations[lang].title ||
        !saved.labels.includes(lang === "ja" ? "日本語" : "English")
      )
        throw new HttpError(502, "Blogger 저장 재검증에 실패했습니다.");
      await finishPackage(env, jobId, lang, hash);
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
  if (w.integration === "supabase")
    return publishNative(env, w, jobId, input, mode, date);
  const lang = w.languages[0];
  const prior = await begin(env, jobId, lang, "create");
  if (prior) return { mode, posts: { [lang]: prior } };
  const response = await remote(
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
  if (!response.ok)
    throw new HttpError(502, "사이트 API 전송 결과를 확인하세요.");
  const created = (await response.json()) as Record<string, unknown>;
  if (
    typeof created.id !== "string" ||
    !created.id ||
    created.status !== (mode === "publish" ? "published" : "draft") ||
    (mode === "publish" &&
      (typeof created.url !== "string" ||
        !created.url.startsWith(
          (w.site_url.endsWith("/") ? w.site_url.slice(0, -1) : w.site_url) +
            "/",
        )))
  )
    throw new HttpError(
      502,
      "사이트 API가 글 ID·상태·공개 주소를 확인하지 못했습니다.",
    );
  await finish(env, jobId, lang, "create", created);
  return { mode, posts: { [lang]: created } };
}
async function publishNative(
  env: Env,
  w: Workspace,
  jobId: string,
  input: DraftInput,
  mode: "draft" | "publish",
  date: string,
) {
  const c = connection(w, env),
    lang = w.languages[0],
    marker = "<!-- Workboard job: " + jobId + " -->";
  const completed =
    mode === "publish" ? await receipt(env, jobId, lang, "publish") : null;
  if (completed?.remote_json)
    return { mode, posts: { [lang]: JSON.parse(completed.remote_json) } };
  const timestamps = w.connection.template === "koreabylocal";
  async function digest(value: string) {
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
  }
  const inputHash = await digest(JSON.stringify(input));
  type Row = {
    id: string | number;
    slug: string;
    status: string;
    content: string;
    [key: string]: unknown;
  };
  async function read(slug: string) {
    const q = new URLSearchParams({
      select: "id,slug,status,content" + (timestamps ? ",updated_at" : ""),
      slug: "eq." + slug,
    });
    const response = await remote(c.url + "/rest/v1/" + c.table + "?" + q, {
      headers: c.headers,
    });
    if (!response.ok)
      throw new HttpError(
        502,
        "사이트 글 조회가 실패했습니다 (HTTP " + response.status + ").",
      );
    return ((await response.json()) as Row[])[0];
  }
  const base = await read(input.slug);
  const baseReceipt = await receipt(env, jobId, lang, "create");
  const recorded = baseReceipt?.remote_json
    ? JSON.parse(baseReceipt.remote_json)
    : null;
  const owned =
    base &&
    base.status === "draft" &&
    (base.content.includes(marker) ||
      (recorded?.id === base.id && !recorded.observed));
  const revision = !!base && !owned;
  const target = revision
    ? input.slug.slice(0, 84).replace(/-$/, "") +
      "-review-" +
      jobId
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 8)
        .toLowerCase()
    : input.slug;
  const phase = revision ? "revision_create" : "create";
  const source = revision
    ? { id: base.id, slug: base.slug, status: base.status }
    : null;
  const existing = revision ? await read(target) : base;
  const prior = await receipt(env, jobId, lang, phase);
  const priorRow = prior?.remote_json ? JSON.parse(prior.remote_json) : null;
  let expected = html(w, input, lang, articleUrl(w, target), date) + marker;
  const packaged = await receipt(env, jobId, lang, "package");
  const packageValue = packaged?.remote_json
    ? JSON.parse(packaged.remote_json)
    : null;
  if (
    existing &&
    packageValue?.input_hash === inputHash &&
    packageValue.content_hash === (await digest(existing.content))
  )
    expected = existing.content;
  let row: Row;
  if (existing) {
    if (
      existing.status !== "draft" ||
      !(
        existing.content.includes(marker) ||
        (priorRow?.id === existing.id && !priorRow.observed)
      )
    )
      throw new HttpError(
        409,
        "같은 보완본 주소가 이미 사용 중입니다. 기존 글을 수정하지 않았습니다.",
      );
    row = existing;
    if (!prior) await begin(env, jobId, lang, phase);
    await finish(env, jobId, lang, phase, {
      id: row.id,
      slug: row.slug,
      status: row.status,
      revision_of: source,
    });
    if (row.content !== expected) {
      const patch = await remote(
        c.url +
          "/rest/v1/" +
          c.table +
          "?" +
          new URLSearchParams({
            id: "eq." + String(row.id),
            status: "eq.draft",
            ...(timestamps && row.updated_at
              ? { updated_at: "eq." + String(row.updated_at) }
              : { content: "eq." + row.content }),
          }),
        {
          method: "PATCH",
          headers: { ...c.headers, Prefer: "return=representation" },
          body: JSON.stringify({
            ...draftPayload(w, { ...input, slug: target }),
            content: expected,
          }),
        },
      );
      if (!patch.ok)
        throw new HttpError(502, "비공개 보완본 갱신 결과를 확인하세요.");
      const rows = (await patch.json()) as Row[];
      if (rows.length !== 1)
        throw new HttpError(
          409,
          "다른 편집으로 초안이 바뀌어 덮어쓰지 않았습니다.",
        );
      row = rows[0];
    }
  } else {
    await begin(env, jobId, lang, phase);
    const created = await remote(c.url + "/rest/v1/" + c.table, {
      method: "POST",
      headers: { ...c.headers, Prefer: "return=representation" },
      body: JSON.stringify({
        ...draftPayload(w, { ...input, slug: target }),
        content: expected,
      }),
    });
    if (!created.ok)
      throw new HttpError(502, "사이트 초안 생성 결과를 확인하세요.");
    row = ((await created.json()) as Row[])[0];
    if (!row?.id || row.status !== "draft" || row.slug !== target)
      throw new HttpError(502, "사이트 초안 ID·상태를 확인하지 못했습니다.");
    await finish(env, jobId, lang, phase, {
      id: row.id,
      slug: row.slug,
      status: row.status,
      revision_of: source,
    });
  }
  const verified = await read(target);
  if (
    !verified ||
    verified.id !== row.id ||
    verified.status !== "draft" ||
    verified.content !== expected
  )
    throw new HttpError(
      502,
      "저장된 비공개 초안의 본문·상태를 확인하지 못했습니다.",
    );
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO publication_receipts(job_id,lang,phase,remote_json,updated_at) VALUES(?,?,'package',?,?) ON CONFLICT(job_id,lang,phase) DO UPDATE SET remote_json=excluded.remote_json,updated_at=excluded.updated_at",
  )
    .bind(
      jobId,
      lang,
      JSON.stringify({
        input_hash: inputHash,
        content_hash: await digest(expected),
      }),
      date,
    )
    .run();
  if (revision && baseReceipt && !baseReceipt.remote_json)
    await finish(env, jobId, lang, "create", { ...source, observed: true });
  if (mode === "publish") {
    const already = await begin(env, jobId, lang, "publish");
    if (already) return { mode, posts: { [lang]: already } };
    const published = await remote(
      c.url +
        "/rest/v1/" +
        c.table +
        "?" +
        new URLSearchParams({
          id: "eq." + String(row.id),
          status: "eq.draft",
          ...(timestamps && verified.updated_at
            ? { updated_at: "eq." + String(verified.updated_at) }
            : { content: "eq." + expected }),
        }),
      {
        method: "PATCH",
        headers: { ...c.headers, Prefer: "return=representation" },
        body: JSON.stringify({
          status: "published",
          ...(w.connection.template === "koreabylocal"
            ? { published_at: date }
            : {}),
        }),
      },
    );
    if (!published.ok)
      throw new HttpError(502, "사이트 게시 결과를 확인하세요.");
    const rows = (await published.json()) as Row[];
    if (rows.length !== 1 || rows[0].status !== "published")
      throw new HttpError(409, "게시 상태가 예상과 다릅니다.");
    row = rows[0];
    await finish(env, jobId, lang, "publish", row);
  }
  return {
    mode,
    posts: {
      [lang]: {
        id: row.id,
        slug: target,
        status: row.status,
        revision_of: source,
      },
    },
  };
}

async function finishPackage(env: Env, id: string, lang: string, hash: string) {
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO publication_receipts(job_id,lang,phase,remote_json,updated_at) VALUES(?,?,'package',?,?) ON CONFLICT(job_id,lang,phase) DO UPDATE SET remote_json=excluded.remote_json,updated_at=excluded.updated_at",
  )
    .bind(id, lang, JSON.stringify({ hash }), new Date().toISOString())
    .run();
}
