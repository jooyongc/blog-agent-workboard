import { marked, Renderer } from "marked";
import {
  listWorkspaces,
  workspace,
  publicHttps,
  variable,
  articleUrl,
} from "./registry";
import type { Workspace, Post, DraftInput, Article } from "../shared/types";
import type { Env } from "./env";
import { HttpError, remote, validSlug } from "./http";
function esc(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function safeUrl(url: string) {
  return (
    /^(https?:\/\/|mailto:|\/[^/]|#)/i.test(url) && !/[\u0000-\u0020]/.test(url)
  );
}
export function renderMarkdown(md: string) {
  const renderer = new Renderer();
  renderer.html = ({ text }) => esc(text);
  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    return safeUrl(href)
      ? `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} rel="noopener noreferrer">${label}</a>`
      : label;
  };
  renderer.image = ({ href, text }) =>
    /^https:\/\//i.test(href) && safeUrl(href)
      ? `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy"/>`
      : esc(text);
  return marked.parse(md, { async: false, renderer }) as string;
}

export function connection(w: Workspace, env: Env) {
  if (w.integration !== "supabase")
    throw new HttpError(400, "DB 연결 방식이 아닙니다.");
  const c = w.connection;
  const url = publicHttps(variable(env, c.url_env));
  const key = variable(env, c.key_env);
  if (!key) throw new HttpError(503, `${c.key_env} 연결 변수를 설정해 주세요.`);
  return {
    url: url.origin,
    table: c.table!,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Accept-Profile": c.schema!,
      "Content-Profile": c.schema!,
      "Content-Type": "application/json",
    },
  };
}
export async function getPosts(w: Workspace, env: Env) {
  if (w.integration === "blogger") {
    const res = await remote(
      `${w.site_url}/feeds/posts/summary?alt=json&max-results=150`,
    );
    if (!res.ok)
      throw new HttpError(502, "Blogger 공개 글 목록 연결을 확인하세요.");
    const j = (await res.json()) as {
      feed?: {
        entry?: Array<{
          id: { $t: string };
          title: { $t: string };
          published: { $t: string };
          updated: { $t: string };
          category?: { term: string }[];
          link?: { rel: string; href: string }[];
        }>;
      };
    };
    return {
      posts: (j.feed?.entry ?? []).map((e) => ({
        id: e.id.$t,
        slug: e.id.$t,
        title: e.title.$t,
        categoryId: e.category?.map((c) => c.term).join(", ") ?? "",
        canonicalLang: e.category?.some((c) => c.term === "日本語")
          ? "ja"
          : "en",
        status: "published" as const,
        createdAt: e.published.$t,
        updatedAt: e.updated.$t,
        publishAt: e.published.$t,
        publishedAt: e.published.$t,
        url: e.link?.find((l) => l.rel === "alternate")?.href,
      })),
      warning: "공개 글 조회입니다. 예약 작업은 발행 흐름에서 확인하세요.",
    };
  }
  if (w.integration === "webhook") {
    const u = publicHttps(variable(env, w.connection.url_env));
    const res = await remote(u.href, {
      headers: {
        Authorization: "Bearer " + variable(env, w.connection.key_env),
      },
    });
    if (!res.ok)
      throw new HttpError(502, "사이트 API 글 목록을 확인하지 못했습니다.");
    const j = (await res.json()) as { posts: Post[] };
    return { posts: j.posts ?? [] };
  }
  const c = connection(w, env),
    q = new URLSearchParams({
      select: "id,slug,title,category,status,created_at",
      order: "created_at.desc",
      limit: "1000",
    });
  const res = await remote(`${c.url}/rest/v1/${c.table}?${q}`, {
    headers: c.headers,
  });
  if (!res.ok) throw new HttpError(502, `${w.name} 연결을 확인하세요.`);
  const rows = (await res.json()) as Record<string, string>[];
  return {
    posts: rows.map((r) => ({
      id: String(r.id),
      slug: r.slug,
      title: r.title,
      categoryId: r.category,
      canonicalLang: w.languages[0],
      status: ["published", "draft", "scheduled", "archived"].includes(r.status)
        ? (r.status as Post["status"])
        : "draft",
      createdAt: r.created_at,
      updatedAt: r.created_at,
      publishedAt: r.status === "published" ? r.created_at : null,
      publishAt: null,
      url: r.status === "published" ? articleUrl(w, r.slug) : undefined,
    })),
  };
}
export function validateArticle(a: unknown): a is Article {
  if (!a || typeof a !== "object") return false;
  const v = a as Article;
  return (
    typeof v.title === "string" &&
    v.title.trim().length > 0 &&
    v.title.length <= 200 &&
    typeof v.content_md === "string" &&
    v.content_md.trim().length >= 40 &&
    v.content_md.length <= 60000 &&
    typeof v.meta_description === "string" &&
    v.meta_description.length <= 300 &&
    Array.isArray(v.tags) &&
    v.tags.length <= 10 &&
    v.tags.every((t) => typeof t === "string" && t.length <= 40)
  );
}
export function validateDraft(input: DraftInput, w: Workspace) {
  if (
    !validSlug(input.slug) ||
    !w.categories.includes(input.category) ||
    typeof input.request_id !== "string" ||
    !input.request_id ||
    input.request_id.length > 100 ||
    input.reviewed !== true
  )
    throw new HttpError(400, "글 정보와 검토 확인이 필요합니다.");
  for (const lang of w.languages)
    if (!validateArticle(input.translations?.[lang]))
      throw new HttpError(400, `${lang.toUpperCase()} 글을 확인하세요.`);
  if (input.featured_image_url) publicHttps(input.featured_image_url);
  return w;
}
export function draftPayload(w: Workspace, input: DraftInput) {
  const t = input.translations[w.languages[0]],
    html = renderMarkdown(t.content_md);
  if (w.connection.template === "koreabylocal")
    return {
      slug: input.slug,
      title: t.title,
      content: html,
      category: input.category,
      excerpt: t.meta_description,
      seo_title: t.title.slice(0, 60),
      seo_description: t.meta_description.slice(0, 160),
      status: "draft",
      published_at: null,
      author: w.name,
      thumbnail_url: input.featured_image_url || null,
      hero_image_url: input.featured_image_url || null,
    };
  if (w.connection.template === "koreadecode")
    return {
      slug: input.slug,
      title: t.title,
      content: html,
      category: input.category,
      status: "draft",
      image: input.featured_image_url || "",
      writer_name: w.name + " Editor",
    };
  return {
    slug: input.slug,
    title: t.title,
    content: html,
    category: input.category,
    status: "draft",
  };
}
export async function saveDraft(input: DraftInput, env: Env) {
  const w = validateDraft(input, await workspace(env, input.site_id));
  if (w.integration === "blogger")
    return {
      mode: "export",
      bundle: {
        site_id: w.site_id,
        slug: input.slug,
        category: input.category,
        featured_image: input.featured_image_url
          ? { url: input.featured_image_url }
          : undefined,
        translations: Object.fromEntries(
          w.languages.map((l) => [
            l,
            {
              ...input.translations[l],
              authoring_mode: "independent",
              content_html: renderMarkdown(input.translations[l].content_md),
            },
          ]),
        ),
        note: "Cloudflare 발행 큐에 등록하면 정기 발행할 수 있습니다.",
      },
    };
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({
            site_id: input.site_id,
            slug: input.slug,
            category: input.category,
            translations: input.translations,
            featured_image_url: input.featured_image_url ?? "",
          }),
        ),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const prior = await env.WORKBOARD_DB.prepare(
    "SELECT * FROM draft_receipts WHERE request_id=?",
  )
    .bind(input.request_id)
    .first<{
      site_id: string;
      payload_hash: string;
      status: string;
      result_json: string;
    }>();
  if (prior) {
    if (prior.site_id !== w.site_id || prior.payload_hash !== hash)
      throw new HttpError(409, "같은 요청의 내용이 변경되었습니다.");
    if (prior.status === "saved") return JSON.parse(prior.result_json);
    throw new HttpError(409, "이전 전송 결과를 확인하세요.");
  }
  let c: ReturnType<typeof connection> | undefined;
  if (w.integration === "supabase") {
    c = connection(w, env);
    const q = new URLSearchParams({
      slug: "eq." + input.slug,
      select: "id",
      limit: "1",
    });
    const check = await remote(`${c.url}/rest/v1/${c.table}?${q}`, {
      headers: c.headers,
    });
    if (!check.ok) throw new HttpError(502, "기존 글 조회가 실패했습니다.");
    if (((await check.json()) as unknown[]).length)
      throw new HttpError(409, "같은 주소의 글이 있습니다.");
  }
  try {
    await env.WORKBOARD_DB.prepare(
      "INSERT INTO draft_receipts(request_id,site_id,payload_hash,status,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(
        input.request_id,
        w.site_id,
        hash,
        "sending",
        new Date().toISOString(),
      )
      .run();
  } catch {
    throw new HttpError(409, "같은 초안 전송이 진행 중입니다.");
  }
  const url = c
    ? `${c.url}/rest/v1/${c.table}`
    : publicHttps(variable(env, w.connection.url_env)).href;
  const res = await remote(url, {
    method: "POST",
    headers: c
      ? { ...c.headers, Prefer: "return=representation" }
      : {
          "Content-Type": "application/json",
          Authorization: "Bearer " + variable(env, w.connection.key_env),
          "Idempotency-Key": input.request_id,
        },
    body: JSON.stringify(
      c ? draftPayload(w, input) : { ...input, status: "draft" },
    ),
  });
  if (!res.ok) throw new HttpError(502, "저장 여부를 관리자에서 확인하세요.");
  const rows = (await res.json()) as { id: string | number }[] | { id: string };
  const result = {
    mode: "saved",
    id: Array.isArray(rows) ? rows[0]?.id : rows.id,
    slug: input.slug,
    admin_url: w.admin_url,
    message: `${w.name}에 초안을 저장했습니다.`,
  };
  await env.WORKBOARD_DB.prepare(
    "UPDATE draft_receipts SET status='saved',result_json=? WHERE request_id=?",
  )
    .bind(JSON.stringify(result), input.request_id)
    .run();
  return result;
}
export async function allPosts(env: Env) {
  return Promise.all(
    (await listWorkspaces(env)).map(async (w) => {
      try {
        return { site_id: w.site_id, ...(await getPosts(w, env)) };
      } catch (e) {
        return {
          site_id: w.site_id,
          posts: [] as Post[],
          error:
            e instanceof HttpError ? e.message : "연결을 확인하지 못했습니다.",
        };
      }
    }),
  );
}
