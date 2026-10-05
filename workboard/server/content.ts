import { marked, Renderer } from "marked";
import { CATALOG, getWorkspace } from "../shared/catalog";
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
    throw new HttpError(400, "이 사이트는 별도 게시 연결을 사용합니다.");
  const url =
    env.NATIVE_BLOG_SUPABASE_URL ?? "https://agkkvtfwqmzgbrqhvohs.supabase.co";
  if (new URL(url).origin !== "https://agkkvtfwqmzgbrqhvohs.supabase.co")
    throw new HttpError(503, "사이트 연결 설정을 확인해 주세요.");
  if (!env.NATIVE_BLOG_SUPABASE_KEY)
    throw new HttpError(503, "사이트 연결이 아직 준비되지 않았습니다.");
  const schema = w.site_id === "koreabylocal" ? "koreabylocal" : "public";
  return {
    url: new URL(url).origin,
    table: w.site_id === "koreabylocal" ? "blog_posts" : "posts",
    headers: {
      apikey: env.NATIVE_BLOG_SUPABASE_KEY,
      Authorization: `Bearer ${env.NATIVE_BLOG_SUPABASE_KEY}`,
      "Accept-Profile": schema,
      "Content-Profile": schema,
      "Content-Type": "application/json",
    },
  };
}
export function astyHeaders(env: Env) {
  if (!env.ASTY_AGENT_API_KEY)
    throw new HttpError(503, "ASTY 연결을 확인해 주세요.");
  return {
    Authorization: `Bearer ${env.ASTY_AGENT_API_KEY}`,
    "Content-Type": "application/json",
  };
}
export async function getPosts(w: Workspace, env: Env) {
  if (w.integration === "blogger") {
    const res = await remote(
      `${w.site_url}/feeds/posts/summary?alt=json&max-results=150`,
    );
    if (!res.ok)
      throw new HttpError(502, "Blogger 글 목록을 가져오지 못했습니다.");
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
    const posts: Post[] = (j.feed?.entry ?? []).map((e) => ({
      id: e.id.$t,
      slug:
        e.link
          ?.find((l) => l.rel === "alternate")
          ?.href.split("/")
          .pop()
          ?.replace(/\.html$/, "") ?? e.id.$t,
      title: e.title.$t,
      categoryId:
        e.category
          ?.map((c) => c.term)
          .filter((t) => !["English", "日本語"].includes(t))
          .join(", ") ?? "",
      canonicalLang: e.category?.some((c) => c.term === "日本語") ? "ja" : "en",
      status: "published",
      createdAt: e.published.$t,
      updatedAt: e.updated.$t,
      publishAt: e.published.$t,
      publishedAt: e.published.$t,
      url: e.link?.find((l) => l.rel === "alternate")?.href,
    }));
    return {
      posts,
      warning:
        "공개 글을 조회합니다. 임시보관과 예약 글은 Blogger 관리자에서 확인하세요.",
    };
  }
  if (w.integration === "asty") {
    const res = await remote(
      `${env.ASTY_SITE_URL ?? w.site_url}/api/admin/posts/export?limit=1000`,
      { headers: astyHeaders(env) },
    );
    if (!res.ok) throw new HttpError(502, "ASTY 글 목록 연결을 확인해 주세요.");
    const j = (await res.json()) as { posts: Post[] };
    return {
      posts: (j.posts ?? []).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
    };
  }
  const c = connection(w, env);
  const select =
    w.site_id === "koreabylocal"
      ? "id,slug,title,category,status,author,published_at,created_at,updated_at"
      : "id,slug,title,category,status,writer_name,created_at";
  const q = new URLSearchParams({
    select,
    order: "created_at.desc",
    limit: "1000",
  });
  const res = await remote(`${c.url}/rest/v1/${c.table}?${q}`, {
    headers: c.headers,
  });
  if (!res.ok)
    throw new HttpError(502, `${w.name} 글 목록 연결을 확인해 주세요.`);
  const rows = (await res.json()) as Record<string, string | null>[];
  const posts: Post[] = rows.map((r) => ({
    id: String(r.id),
    slug: r.slug ?? String(r.id),
    title: r.title ?? "",
    categoryId: r.category ?? "",
    canonicalLang: "en",
    status: ["draft", "published", "scheduled", "archived"].includes(
      r.status ?? "",
    )
      ? (r.status as Post["status"])
      : "draft",
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? r.created_at ?? "",
    publishAt: r.published_at ?? null,
    publishedAt:
      r.status === "published" ? (r.published_at ?? r.created_at) : null,
    url: r.status === "published" ? `${w.site_url}/blog/${r.slug}` : undefined,
  }));
  return { posts };
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
export function validateDraft(input: DraftInput) {
  const w = getWorkspace(input.site_id);
  if (
    !validSlug(input.slug) ||
    !w.categories.includes(input.category) ||
    !input.request_id ||
    input.request_id.length > 100 ||
    input.reviewed !== true
  )
    throw new HttpError(400, "글 정보와 검토 확인을 완료해 주세요.");
  for (const lang of w.languages)
    if (!validateArticle(input.translations?.[lang]))
      throw new HttpError(
        400,
        `${lang.toUpperCase()} 제목과 본문을 확인해 주세요.`,
      );
  if (
    input.featured_image_url &&
    (!/^https:\/\//.test(input.featured_image_url) ||
      !safeUrl(input.featured_image_url))
  )
    throw new HttpError(400, "이미지는 HTTPS 주소를 사용해 주세요.");
  return w;
}
export function draftPayload(w: Workspace, input: DraftInput) {
  const t = input.translations.en;
  const html = renderMarkdown(t.content_md);
  if (w.site_id === "koreabylocal")
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
      author: "Korea by Local",
      thumbnail_url: input.featured_image_url || null,
      hero_image_url: input.featured_image_url || null,
    };
  if (w.site_id === "koreadecode")
    return {
      slug: input.slug,
      title: t.title,
      content: html,
      category: input.category,
      status: "draft",
      image: input.featured_image_url || "",
      writer_name: "Korea Decode Editor",
    };
  throw new HttpError(400, "이 사이트는 전달 파일을 사용합니다.");
}
export async function saveDraft(input: DraftInput, env: Env) {
  const w = validateDraft(input);
  if (w.integration !== "supabase") {
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
          w.languages.map((lang) => {
            const a = input.translations[lang];
            return [
              lang,
              {
                ...a,
                authoring_mode: "independent",
                content_html: renderMarkdown(a.content_md),
              },
            ];
          }),
        ),
        note:
          w.integration === "blogger"
            ? "기존 aside 루틴의 이미지·FAQ·제휴 고지 검토 후 게시하세요."
            : "기존 ASTY 브릿지에서 검토·번역 상태와 이미지를 확인한 뒤 예약 발행하세요.",
      },
    };
  }
  if (!env.WORKBOARD_DB)
    throw new HttpError(503, "초안 저장 연결을 확인해 주세요.");
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
      result_json: string | null;
    }>();
  if (prior) {
    if (prior.site_id !== w.site_id || prior.payload_hash !== hash)
      throw new HttpError(
        409,
        "전송 후 내용이 변경되었습니다. 새 초안으로 저장해 주세요.",
      );
    if (prior.status === "saved" && prior.result_json)
      return JSON.parse(prior.result_json);
    throw new HttpError(
      409,
      "이전 저장 결과를 관리자에서 확인한 뒤 다시 진행해 주세요.",
    );
  }
  const c = connection(w, env);
  const q = new URLSearchParams({
    slug: `eq.${input.slug}`,
    select: "id,slug,status",
    limit: "1",
  });
  const check = await remote(`${c.url}/rest/v1/${c.table}?${q}`, {
    headers: c.headers,
  });
  if (!check.ok) throw new HttpError(502, "기존 글 확인에 실패했습니다.");
  if (((await check.json()) as unknown[]).length)
    throw new HttpError(
      409,
      "같은 주소의 글이 이미 있습니다. 글 주소를 바꿔 주세요.",
    );
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
    throw new HttpError(409, "같은 초안의 저장이 진행 중입니다.");
  }
  const res = await remote(`${c.url}/rest/v1/${c.table}`, {
    method: "POST",
    headers: { ...c.headers, Prefer: "return=representation" },
    body: JSON.stringify(draftPayload(w, input)),
  });
  if (!res.ok)
    throw new HttpError(
      502,
      "초안을 저장하지 못했습니다. 관리자에서 저장 여부를 먼저 확인해 주세요.",
    );
  const rows = (await res.json()) as { id: string | number; slug: string }[];
  const result = {
    mode: "saved",
    id: rows[0]?.id,
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
    CATALOG.map(async (w) => {
      try {
        return { site_id: w.site_id, ...(await getPosts(w, env)) };
      } catch (e) {
        console.error(
          "content_read_failed",
          w.site_id,
          e instanceof Error ? e.message : "unknown",
        );
        return {
          site_id: w.site_id,
          posts: [] as Post[],
          error:
            e instanceof HttpError
              ? e.message
              : "글 목록을 확인하지 못했습니다.",
        };
      }
    }),
  );
}
