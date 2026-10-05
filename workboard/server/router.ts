import { CATALOG, getWorkspace } from "../shared/catalog";
import type { DraftInput } from "../shared/types";
import type { Context } from "./env";
import { authenticated, equalSecret, makeSession, sessionCookie } from "./auth";
import {
  json,
  body,
  sameOrigin,
  cookie,
  HttpError,
  message,
  remote,
} from "./http";
import { getPosts, allPosts, saveDraft, astyHeaders } from "./content";
import { generate } from "./ai";
export async function onRequest({ request, env }: Context): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const method = request.method;
    if (method !== "GET") sameOrigin(request);
    if (route === "health" && method === "GET")
      return json({
        app: "blog-agent-workboard",
        status: "ok",
        runtime: "cloudflare-pages",
        database: !!env.WORKBOARD_DB,
      });
    if (route === "auth/login" && method === "POST") {
      if (
        !env.DASHBOARD_PASSWORD ||
        !env.DASHBOARD_SESSION_SECRET ||
        !env.WORKBOARD_DB
      )
        throw new HttpError(503, "로그인 연결을 준비 중입니다.");
      const input = await body<{ password: string }>(request);
      if (typeof input.password !== "string" || input.password.length > 500)
        throw new HttpError(400, "비밀번호를 입력해 주세요.");
      const ip = request.headers.get("cf-connecting-ip") ?? "local";
      const bucket =
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(ip + env.DASHBOARD_SESSION_SECRET),
            ),
          ),
        )
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("") +
        ":" +
        Math.floor(Date.now() / 900000);
      const row = await env.WORKBOARD_DB.prepare(
        "SELECT attempts FROM login_attempts WHERE bucket=?",
      )
        .bind(bucket)
        .first<{ attempts: number }>();
      if ((row?.attempts ?? 0) >= 10)
        throw new HttpError(
          429,
          "로그인을 여러 번 시도했습니다. 잠시 후 다시 진행해 주세요.",
        );
      await env.WORKBOARD_DB.prepare(
        "INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1",
      )
        .bind(bucket, Date.now() + 900000)
        .run();
      if (!(await equalSecret(input.password, env.DASHBOARD_PASSWORD)))
        throw new HttpError(401, "비밀번호를 확인해 주세요.");
      await env.WORKBOARD_DB.prepare(
        "DELETE FROM login_attempts WHERE bucket=? OR expires_at<?",
      )
        .bind(bucket, Date.now())
        .run();
      return json({ ok: true }, 200, {
        "Set-Cookie": sessionCookie(
          request,
          await makeSession(env.DASHBOARD_SESSION_SECRET),
        ),
      });
    }
    if (!(await authenticated(request, env)))
      throw new HttpError(401, "로그인이 필요합니다.");
    if (route === "auth/session" && method === "GET")
      return json({ authenticated: true });
    if (route === "auth/logout" && method === "POST")
      return json({ ok: true }, 200, {
        "Set-Cookie": sessionCookie(request, "", 0),
      });
    if (route === "workspaces" && method === "GET") {
      const activeId = cookie(request, "active_workspace_id");
      return json({
        workspaces: CATALOG,
        active_id: CATALOG.some((w) => w.site_id === activeId)
          ? activeId
          : CATALOG[0].site_id,
      });
    }
    if (route === "workspaces/active" && method === "POST") {
      const input = await body<{ site_id: string }>(request);
      const w = getWorkspace(input.site_id);
      return json({ ok: true, site_id: w.site_id }, 200, {
        "Set-Cookie": `active_workspace_id=${w.site_id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${url.protocol === "https:" ? "; Secure" : ""}`,
      });
    }
    if (route === "posts" && method === "GET") {
      const w = getWorkspace(
        url.searchParams.get("site_id") ||
          cookie(request, "active_workspace_id") ||
          "asty-cabin",
      );
      return json({ site_id: w.site_id, ...(await getPosts(w, env)) });
    }
    if (route === "overview" && method === "GET")
      return json({ sites: await allPosts(env) });
    if (route === "content/preview" && method === "POST") {
      const input = await body<{ markdown: string }>(request);
      if (typeof input.markdown !== "string" || input.markdown.length > 60000)
        throw new HttpError(400, "미리보기 내용을 확인해 주세요.");
      const { renderMarkdown } = await import("./content");
      return json({ html: renderMarkdown(input.markdown) });
    }
    if (route === "content/draft" && method === "POST")
      return json(await saveDraft(await body<DraftInput>(request), env));
    if (route === "content/generate" && method === "POST")
      return json(
        await generate(
          await body<Parameters<typeof generate>[0]>(request),
          env,
        ),
      );
    if (route === "settings" && method === "GET")
      return json({
        runtime: "Cloudflare Pages",
        ai_ready:
          env.AI_ENABLED === "true" &&
          !!env.ANTHROPIC_API_KEY &&
          !!env.WORKBOARD_DB,
        native_ready: !!env.NATIVE_BLOG_SUPABASE_KEY,
        asty_ready: !!env.ASTY_AGENT_API_KEY,
        github_ready: !!env.GITHUB_TOKEN,
        blogger_owner: "aside-browser",
        database_ready: !!env.WORKBOARD_DB,
      });
    if (route === "reports" && method === "GET") {
      const month = new Date(Date.now() + 9 * 3600000)
        .toISOString()
        .slice(0, 7);
      const [runs, ideas] = await Promise.all([
        env.WORKBOARD_DB.prepare(
          "SELECT id,article_key,reserved,actual,status,created_at FROM ai_runs ORDER BY created_at DESC LIMIT 100",
        ).all(),
        env.WORKBOARD_DB.prepare(
          "SELECT id,site_id,title,category,note,status,created_at FROM topic_ideas ORDER BY created_at DESC LIMIT 100",
        ).all(),
      ]);
      const budget = await env.WORKBOARD_DB.prepare(
        "SELECT COALESCE(SUM(reserved),0) AS reserved,COALESCE(SUM(actual),0) AS actual FROM ai_runs WHERE month=?",
      )
        .bind(month)
        .first();
      return json({ runs: runs.results, ideas: ideas.results, budget, month });
    }
    if (route === "topics" && method === "GET") {
      const site = getWorkspace(
        url.searchParams.get("site_id") ?? CATALOG[0].site_id,
      );
      const result = await env.WORKBOARD_DB.prepare(
        "SELECT * FROM topic_ideas WHERE site_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(site.site_id)
        .all();
      return json({ topics: result.results });
    }
    if (route === "topics" && method === "POST") {
      const input = await body<{
        site_id: string;
        title: string;
        category: string;
        note?: string;
      }>(request);
      const w = getWorkspace(input.site_id);
      if (
        typeof input.title !== "string" ||
        input.title.trim().length < 3 ||
        input.title.length > 300 ||
        !w.categories.includes(input.category) ||
        (input.note?.length ?? 0) > 2000
      )
        throw new HttpError(400, "주제 이름과 카테고리를 확인해 주세요.");
      const id = crypto.randomUUID();
      await env.WORKBOARD_DB.prepare(
        "INSERT INTO topic_ideas(id,site_id,title,category,note,created_at) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          id,
          w.site_id,
          input.title.trim(),
          input.category,
          input.note ?? "",
          new Date().toISOString(),
        )
        .run();
      return json({ id }, 201);
    }
    if (route === "pipeline" && method === "GET") {
      if (!env.GITHUB_TOKEN) return json({ runs: [], configured: false });
      const repo = env.GITHUB_REPO ?? "jooyongc/blog-agent-workboard";
      const res = await remote(
        `https://api.github.com/repos/${repo}/actions/workflows/weekly.yml/runs?per_page=5`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "blog-agent-workboard",
          },
        },
      );
      if (!res.ok)
        return json({
          runs: [],
          configured: true,
          error: "GitHub 실행 기록 연결을 확인해 주세요.",
        });
      const j = (await res.json()) as { workflow_runs: unknown[] };
      return json({ runs: j.workflow_runs, configured: true });
    }
    if (route === "pipeline" && method === "POST") {
      const input = await body<{
        site_id: string;
        limit: number;
        dry_run: boolean;
      }>(request);
      const w = getWorkspace(input.site_id);
      if (w.integration !== "asty")
        throw new HttpError(
          409,
          "이 사이트는 글 작성 화면의 전용 흐름을 사용합니다.",
        );
      if (!env.GITHUB_TOKEN)
        throw new HttpError(503, "GitHub 실행 연결을 확인해 주세요.");
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 5 ||
        typeof input.dry_run !== "boolean"
      )
        throw new HttpError(400, "실행 설정을 확인해 주세요.");
      const res = await remote(
        `https://api.github.com/repos/${env.GITHUB_REPO ?? "jooyongc/blog-agent-workboard"}/actions/workflows/weekly.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "blog-agent-workboard",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              site_id: w.site_id,
              limit: String(input.limit),
              dry_run: String(input.dry_run),
            },
          }),
        },
      );
      if (!res.ok)
        throw new HttpError(502, "GitHub 실행 요청을 처리하지 못했습니다.");
      return json({ ok: true });
    }
    if (route === "legacy/queue" && method === "GET") {
      const res = await remote(
        `${env.ASTY_SITE_URL ?? CATALOG[0].site_url}/api/admin/queue/export?site_id=asty-cabin`,
        { headers: astyHeaders(env) },
      );
      if (!res.ok)
        throw new HttpError(502, "기존 승인 대기열 연결을 확인해 주세요.");
      return json(await res.json());
    }
    throw new HttpError(404, "요청한 기능을 찾지 못했습니다.");
  } catch (error) {
    return json(
      { error: message(error) },
      error instanceof HttpError
        ? error.status
        : error instanceof Error && error.message === "Unknown workspace"
          ? 400
          : 500,
    );
  }
}
