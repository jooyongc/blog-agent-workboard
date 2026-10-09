import {applyModelSettings,modelCatalog,saveModels} from "./model-settings";
import type { DraftInput, Workspace } from "../shared/types";
import type { Context } from "./env";
import { authenticated, equalSecret, makeSession, sessionCookie } from "./auth";
import { json, body, sameOrigin, cookie, HttpError, message } from "./http";
import { workspace, listWorkspaces, putWorkspace, readiness } from "./registry";
import {
  getPosts,
  allPosts,
  saveDraft,
  renderMarkdown,
  validateArticle,
  validateDraft,
} from "./content";
import { generate } from "./ai";
import { propose, research } from "./strategy";
import { quality } from "./seo";
import {
  enqueue,
  jobs,
  tick,
  verifyGenerated,
  researchEvidence,
} from "./automation";
import { oauthStart, oauthCallback } from "./oauth";
import { mediaResponse, stockPhotos } from "./media";
import { advanceHarness, enqueueApproved } from "./harness";
import { measure } from "./measurement";
import { SUPERVISOR_MODEL, MAX_SUPERVISOR_ROUNDS } from "./supervisor";
import { fireflyReady } from "./firefly";
import {
  budgetSettings,
  saveBudgetSettings,
  budgetUsage,
  budgetExamples,
} from "./budget";
import { generatedImagesReady } from "./generated-media";
import { budgetReset, workerModel, reviewModel, editorModel } from "./model";
export async function onRequest({
  request,
  env,
  waitUntil,
}: Context): Promise<Response> {
  try {
    const url = new URL(request.url),
      route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, ""),
      method = request.method;
    if (method !== "GET") sameOrigin(request);
    if (route === "health" && method === "GET")
      return json({
        app: "blog-agent-workboard",
        status: "ok",
        runtime: "cloudflare-pages",
        database: !!env.WORKBOARD_DB,
      });
    if (route === "blogger/oauth/callback" && method === "GET")
      return oauthCallback(env, url);
    if (route.startsWith("media/") && method === "GET")
      return mediaResponse(env, route.slice(6));
    if (
      ["internal/scheduler", "internal/harness"].includes(route) &&
      method === "POST"
    ) {
      const token =
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      if (
        !env.SCHEDULER_TOKEN ||
        !(await equalSecret(token, env.SCHEDULER_TOKEN))
      )
        throw new HttpError(401, "스케줄러 인증이 필요합니다.");
      env = await applyModelSettings(env);
      if (route === "internal/harness") return json(await advanceHarness(env));
      const input = await body<{ dry_run?: boolean }>(request);
      return json(await tick(env, Date.now(), input.dry_run === true));
    }
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
    env = await applyModelSettings(env);
    if(route === "ai-models" && method === "GET")return json(await modelCatalog(env));
    if(route === "ai-models" && method === "PUT"){const result=await saveModels(env,await body(request));wakeHarness(env,waitUntil);return json(result);}
    if (route === "media-library/search" && method === "GET") {
      const w = await workspace(env, url.searchParams.get("site_id") || "");
      const query = url.searchParams.get("query") || w.strategy.pillars[0];
      if (query.length > 200) throw new HttpError(400, "검색어를 확인하세요.");
      return json({ photos: await stockPhotos(env, query, 2, w.site_id) });
    }
    if (route === "media-library" && method === "GET") {
      const site = url.searchParams.get("site_id") || "";
      await workspace(env, site);
      return json({
        assets: (
          await env.WORKBOARD_DB.prepare(
            "SELECT * FROM reusable_media WHERE site_id=? ORDER BY created_at DESC LIMIT 100",
          )
            .bind(site)
            .all()
        ).results,
      });
    }
    if (route === "media-library/upload" && method === "POST") {
      const form = await request.formData();
      const w = await workspace(env, String(form.get("site_id") || ""));
      const file = form.get("file");
      const title = String(form.get("title") || "").trim(),
        provider = String(form.get("provider") || ""),
        reference = String(form.get("license_reference") || "").trim();
      const allowed = [
        "image/jpeg",
        "image/png",
        "video/mp4",
        "video/quicktime",
      ];
      if (
        !(file instanceof File) ||
        !allowed.includes(file.type) ||
        file.size > 50 * 1024 * 1024 ||
        !title ||
        title.length > 300 ||
        !["Adobe Stock", "Adobe Firefly"].includes(provider) ||
        (provider === "Adobe Stock" && !reference)
      )
        throw new HttpError(
          400,
          "파일 형식·제목·Adobe 라이선스 근거를 확인하세요.",
        );
      const id = crypto.randomUUID(),
        extension = (
          {
            "image/jpeg": "jpg",
            "image/png": "png",
            "video/mp4": "mp4",
            "video/quicktime": "mov",
          } as Record<string, string>
        )[file.type];
      const base = String(env.NATIVE_BLOG_SUPABASE_URL) + "/storage/v1",
        path = "library/" + id + "." + extension;
      const response = await fetch(base + "/object/workboard-media/" + path, {
        method: "POST",
        headers: {
          apikey: String(env.NATIVE_BLOG_SUPABASE_KEY),
          Authorization: "Bearer " + String(env.NATIVE_BLOG_SUPABASE_KEY),
          "Content-Type": file.type,
        },
        body: await file.arrayBuffer(),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new HttpError(502, "미디어 원본 저장 실패");
      const source =
        provider === "Adobe Firefly"
          ? "https://www.adobe.com/products/firefly.html"
          : "https://stock.adobe.com/license-terms";
      const tags = String(form.get("tags") || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20);
      await env.WORKBOARD_DB.prepare(
        "INSERT INTO reusable_media(id,site_id,provider,kind,title,tags_json,url,source_url,license_reference,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          id,
          w.site_id,
          provider,
          file.type.startsWith("video/") ? "video" : "photo",
          title,
          JSON.stringify(tags),
          base + "/object/public/workboard-media/" + path,
          source,
          provider === "Adobe Firefly"
            ? "User-created Firefly asset"
            : reference,
          new Date().toISOString(),
        )
        .run();
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',error=NULL,updated_at=? WHERE site_id=? AND stage='photo_editor' AND (status IN ('failed','media_wait') OR (status='budget_wait' AND instr(error,'이미지 생성')=1)) AND EXISTS(SELECT 1 FROM content_jobs c WHERE c.id=agent_workflows.job_id AND c.status NOT IN ('cancelled','published','drafted'))",
      )
        .bind(new Date().toISOString(), w.site_id)
        .run();
      wakeHarness(env, waitUntil);
      return json({ id }, 201);
    }
    if (route === "auth/session" && method === "GET")
      return json({ authenticated: true });
    if (route === "auth/logout" && method === "POST")
      return json({ ok: true }, 200, {
        "Set-Cookie": sessionCookie(request, "", 0),
      });

    const catalog = await listWorkspaces(env);
    const active = () => {
      const id = cookie(request, "active_workspace_id");
      return catalog.some((w) => w.site_id === id)
        ? id
        : (catalog[0]?.site_id ?? "");
    };
    if (route === "workspaces" && method === "GET")
      return json({ workspaces: catalog, active_id: active() });
    if (route === "workspaces" && ["POST", "PUT"].includes(method)) {
      const w = await body<Workspace>(request);
      if (w.schedule?.enabled && !(await readiness(w, env)).ready)
        throw new HttpError(
          409,
          "발행 연결 변수를 설정한 뒤 자동 발행을 켜세요.",
        );
      return json(
        await putWorkspace(env, w, method === "POST"),
        method === "POST" ? 201 : 200,
      );
    }
    if (route === "workspaces/active" && method === "POST") {
      const w = await workspace(
        env,
        (await body<{ site_id: string }>(request)).site_id,
      );
      return json({ ok: true, site_id: w.site_id }, 200, {
        "Set-Cookie": `active_workspace_id=${w.site_id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${url.protocol === "https:" ? "; Secure" : ""}`,
      });
    }
    if (route === "workspaces/archive" && method === "POST") {
      const w = await workspace(
        env,
        (await body<{ site_id: string }>(request)).site_id,
      );
      if (catalog.length <= 1)
        throw new HttpError(409, "워크스페이스 한 개 이상을 유지하세요.");
      const pending = await env.WORKBOARD_DB.prepare(
        "SELECT id FROM content_jobs WHERE site_id=? AND status IN ('researching','generating','ready','publishing') LIMIT 1",
      )
        .bind(w.site_id)
        .first();
      if (pending)
        throw new HttpError(
          409,
          "진행 중인 작성·예약 작업을 먼저 완료하거나 취소하세요.",
        );
      await env.WORKBOARD_DB.prepare(
        "UPDATE workspace_records SET disabled=1 WHERE site_id=?",
      )
        .bind(w.site_id)
        .run();
      return json({ ok: true });
    }
    if (route === "blogger/oauth/start" && method === "POST") {
      const i = await body<{ site_id: string }>(request);
      return json(await oauthStart(env, i.site_id, url.origin));
    }
    if (route === "measurement" && method === "GET") {
      const w = await workspace(
        env,
        url.searchParams.get("site_id") || active(),
      );
      const r = await env.WORKBOARD_DB.prepare(
        "SELECT metrics_json FROM site_measurements WHERE site_id=? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(w.site_id)
        .first<{ metrics_json: string }>();
      return json(
        r ? JSON.parse(r.metrics_json) : { status: "baseline_needed" },
      );
    }
    if (route === "measurement" && method === "POST") {
      const w = await workspace(
        env,
        (await body<{ site_id: string }>(request)).site_id,
      );
      return json(await measure(env, w));
    }
    if (route === "overview" && method === "GET")
      return json({ sites: await allPosts(env) });
    if (route === "posts" && method === "GET") {
      const w = await workspace(
        env,
        url.searchParams.get("site_id") || active(),
      );
      return json({ site_id: w.site_id, ...(await getPosts(w, env)) });
    }
    if (route === "content/preview" && method === "POST") {
      const i = await body<{ markdown: string }>(request);
      if (typeof i.markdown !== "string" || i.markdown.length > 60000)
        throw new HttpError(400, "본문을 확인하세요.");
      return json({ html: renderMarkdown(i.markdown) });
    }
    if (route === "content/quality" && method === "POST") {
      const i = await body<DraftInput>(request),
        w = await workspace(env, i.site_id);
      if (w.languages.some((l) => !validateArticle(i.translations?.[l])))
        throw new HttpError(400, "언어별 글 내용을 확인하세요.");
      return json({
        quality: Object.fromEntries(
          w.languages.map((l) => [l, quality(i.translations[l], w, l)]),
        ),
      });
    }
    if (route === "content/generate" && method === "POST")
      return json(
        await generate(
          await body<Parameters<typeof generate>[0]>(request),
          env,
        ),
      );
    if (route === "content/draft" && method === "POST")
      return json(await saveDraft(await body<DraftInput>(request), env));
    if (route === "content/schedule" && method === "POST")
      return json(
        await enqueue(
          env,
          await body<DraftInput & { publish_at?: string }>(request),
        ),
        201,
      );
    if (route === "strategy/propose" && method === "POST")
      return json(
        await propose(env, await body<Parameters<typeof propose>[1]>(request)),
      );
    if (route === "strategy/research" && method === "POST") {
      const i = await body<{
        site_id: string;
        title: string;
        category: string;
      }>(request);
      const w = await workspace(env, i.site_id);
      if (
        typeof i.title !== "string" ||
        i.title.length > 300 ||
        !w.categories.includes(i.category)
      )
        throw new HttpError(400, "주제를 확인하세요.");
      return json(await research(env, i.site_id, i.title, i.category));
    }
    if (route === "topics/feedback" && method === "POST") {
      const i = await body<{
        site_id: string;
        title: string;
        rating: number;
        context?: unknown;
      }>(request);
      const w = await workspace(env, i.site_id);
      if (
        typeof i.title !== "string" ||
        !i.title.trim() ||
        i.title.length > 300 ||
        ![1, -1].includes(i.rating)
      )
        throw new HttpError(400, "주제 피드백을 확인하세요.");
      const context = JSON.stringify(i.context ?? {});
      if (context.length > 10000)
        throw new HttpError(400, "피드백 내용이 너무 깁니다.");
      await env.WORKBOARD_DB.prepare(
        "INSERT INTO topic_feedback(id,site_id,title,rating,context_json,created_at) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          w.site_id,
          i.title,
          i.rating,
          context,
          new Date().toISOString(),
        )
        .run();
      return json({ saved: true }, 201);
    }
    if (route === "topics" && method === "GET") {
      const w = await workspace(
        env,
        url.searchParams.get("site_id") || active(),
      );
      const r = await env.WORKBOARD_DB.prepare(
        "SELECT * FROM topic_ideas WHERE site_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(w.site_id)
        .all();
      return json({ topics: r.results });
    }
    if (route === "topics" && method === "POST") {
      const i = await body<{
          site_id: string;
          title: string;
          category: string;
          note?: string;
          brief?: unknown;
          status?: string;
        }>(request),
        w = await workspace(env, i.site_id);
      if (
        typeof i.title !== "string" ||
        i.title.trim().length < 3 ||
        i.title.length > 300 ||
        !w.categories.includes(i.category) ||
        typeof (i.note ?? "") !== "string" ||
        (i.note?.length ?? 0) > 2000
      )
        throw new HttpError(400, "주제와 카테고리를 확인하세요.");
      if (i.status === "approved") {
        const active = await env.WORKBOARD_DB.prepare(
          "SELECT id FROM topic_ideas WHERE site_id=? AND lower(title)=lower(?) AND status IN ('approved','in_progress') LIMIT 1",
        )
          .bind(w.site_id, i.title.trim())
          .first();
        if (active)
          throw new HttpError(
            409,
            "같은 제목의 주제가 이미 승인되어 에이전트가 진행 중입니다.",
          );
      }
      const id = crypto.randomUUID();
      await env.WORKBOARD_DB.prepare(
        "INSERT INTO topic_ideas(id,site_id,title,category,note,status,brief_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
        .bind(
          id,
          w.site_id,
          i.title.trim(),
          i.category,
          i.note ?? "",
          i.status === "approved" ? "approved" : "proposed",
          JSON.stringify(i.brief ?? {}),
          new Date().toISOString(),
        )
        .run();
      if (i.status === "approved") {
        await enqueueApproved(env);
        wakeHarness(env, waitUntil);
      }
      return json({ id }, 201);
    }
    if (route === "topics/status" && method === "POST") {
      const i = await body<{ id: string; site_id: string; status: string }>(
        request,
      );
      await workspace(env, i.site_id);
      if (!["approved", "proposed", "archived"].includes(i.status))
        throw new HttpError(400, "주제 상태를 확인하세요.");
      await env.WORKBOARD_DB.prepare(
        "UPDATE topic_ideas SET status=? WHERE id=? AND site_id=?",
      )
        .bind(i.status, i.id, i.site_id)
        .run();
      if (i.status === "approved") {
        await enqueueApproved(env);
        wakeHarness(env, waitUntil);
      }
      return json({ ok: true });
    }
    if (route === "automation" && method === "GET") {
      const id = url.searchParams.get("site_id") || active();
      const w = await workspace(env, id);
      const r = await env.WORKBOARD_DB.prepare(
        "SELECT * FROM scheduler_runs WHERE site_id=? ORDER BY created_at DESC LIMIT 30",
      )
        .bind(id)
        .all();
      return json({
        workspace: w,
        orchestration: {
          runtime: "Cloudflare Queues",
          supervisor_model: reviewModel(env),
          worker_model: workerModel(env),
          editor_model: editorModel(env),
          max_review_rounds: MAX_SUPERVISOR_ROUNDS,
          background: true,
        },
        connection: await readiness(w, env),
        media: {
          pexels: !!env.PEXELS_API_KEY,
          unsplash: !!env.UNSPLASH_ACCESS_KEY,
          adobe_stock: true,
          firefly: fireflyReady(env),
          gemini_images: generatedImagesReady(env),
        },
        media_assets: (
          await env.WORKBOARD_DB.prepare(
            "SELECT result_json FROM creative_requests WHERE site_id=? AND kind='image' AND status='complete' AND json_extract(result_json,'$.visual_review.approved')=1 AND json_extract(result_json,'$.visual_review.policy')='korea-topic-no-text-v2' ORDER BY created_at DESC LIMIT 30",
          )
            .bind(id)
            .all<{ result_json: string }>()
        ).results.map((row) => JSON.parse(row.result_json)),
        jobs: await jobs(env, id),
        runs: r.results,
        workflows: (
          await env.WORKBOARD_DB.prepare(
            "SELECT job_id,topic_id,stage,status,error,json_extract(payload_json,'$.media_recovery') AS media_recovery_json,json_extract(payload_json,'$.photo_retry_revision') AS photo_retry_revision,json_extract(payload_json,'$.recovery') AS recovery_json,json_extract(payload_json,'$.supervision') AS supervision_json,json_extract(payload_json,'$.supervisor_rounds') AS supervisor_rounds FROM agent_workflows WHERE site_id=? ORDER BY created_at DESC LIMIT 100",
          )
            .bind(id)
            .all()
        ).results,
        steps: (
          await env.WORKBOARD_DB.prepare(
            "SELECT s.* FROM agent_steps s JOIN agent_workflows f ON f.job_id=s.job_id WHERE f.site_id=? ORDER BY s.started_at DESC LIMIT 100",
          )
            .bind(id)
            .all()
        ).results,
      });
    }
    if (route === "automation/retry" && method === "POST") {
      const i = await body<{ site_id: string; job_id: string }>(request);
      await workspace(env, i.site_id);
      const f = await env.WORKBOARD_DB.prepare(
        "SELECT stage,status,payload_json FROM agent_workflows WHERE job_id=? AND site_id=?",
      )
        .bind(i.job_id, i.site_id)
        .first<{ stage: string; status: string; payload_json:string }>();
      if (!f || !["failed", "interrupted", "media_wait"].includes(f.status))
        throw new HttpError(409, "재개할 실패 단계가 없습니다.");
      if(f.status === "media_wait"){
        const payload=JSON.parse(f.payload_json);
        if(payload.photo_retry_revision)throw new HttpError(409,"새 후보 재시도는 이미 사용했습니다. 주제에 맞는 원본을 등록하세요.");
        payload.photo_retry_revision=4;
        await env.WORKBOARD_DB.prepare("UPDATE agent_workflows SET payload_json=? WHERE job_id=? AND site_id=? AND status='media_wait'").bind(JSON.stringify(payload),i.job_id,i.site_id).run();
      }
      if (f.stage === "publisher") {
        const uncertain = await env.WORKBOARD_DB.prepare(
          "SELECT job_id FROM publication_receipts WHERE job_id=? AND remote_json IS NULL LIMIT 1",
        )
          .bind(i.job_id)
          .first();
        if (uncertain)
          throw new HttpError(
            409,
            "원격 전송 여부가 불명확합니다. 중복 방지를 위해 결과 확인 후 재개하세요.",
          );
      }
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',error=NULL,updated_at=? WHERE job_id=? AND site_id=?",
      )
        .bind(new Date().toISOString(), i.job_id, i.site_id)
        .run();
      wakeHarness(env, waitUntil);
      return json({ accepted: true });
    }
    if (route === "automation/check" && method === "POST")
      return json(await tick(env, Date.now(), true));
    if (route === "jobs/update" && method === "POST") {
      const i = await body<{
          id: string;
          input: DraftInput;
          publish_at: string;
        }>(request),
        w = await workspace(env, i.input.site_id);
      validateDraft(i.input, w);
      const existing = await env.WORKBOARD_DB.prepare(
        "SELECT slug,request_json,quality_json FROM content_jobs WHERE id=? AND site_id=? AND status IN ('review','ready')",
      )
        .bind(i.id, w.site_id)
        .first<{
          slug: string;
          request_json: string;
          quality_json: string | null;
        }>();
      if (!existing || existing.slug !== i.input.slug)
        throw new HttpError(409, "예약 글 주소는 변경할 수 없습니다.");
      const scores = Object.fromEntries(
        w.languages.map((l) => [l, quality(i.input.translations[l], w, l)]),
      );
      const evidence = researchEvidence(i.input, w);
      let factual = true,
        verification: unknown;
      if (evidence) {
        const old = JSON.parse(existing.quality_json ?? "{}");
        const prior = JSON.parse(existing.request_json) as DraftInput;
        factual =
          old.factual === true &&
          JSON.stringify(prior.translations) ===
            JSON.stringify(i.input.translations);
        verification = old.verification;
        if (!factual) {
          const report = await verifyGenerated(env, w, i.input, evidence);
          factual = report.passed;
          verification = report;
        }
      }
      const pass =
        i.input.reviewed === true &&
        factual &&
        Object.values(scores).every((q) => q.passed);
      if (!Number.isFinite(Date.parse(i.publish_at)))
        throw new HttpError(400, "예약 시간을 확인하세요.");
      const result = await env.WORKBOARD_DB.prepare(
        "UPDATE content_jobs SET request_json=?,article_json=?,quality_json=?,status=?,publish_at=?,updated_at=? WHERE id=? AND site_id=? AND status IN ('review','ready')",
      )
        .bind(
          JSON.stringify(i.input),
          JSON.stringify(i.input.translations),
          JSON.stringify(
            evidence
              ? {
                  languages: scores,
                  factual,
                  ...(verification ? { verification } : {}),
                }
              : scores,
          ),
          pass ? "ready" : "review",
          i.publish_at,
          new Date().toISOString(),
          i.id,
          w.site_id,
        )
        .run();
      if (!result.meta.changes)
        throw new HttpError(409, "수정 가능한 검토 초안이 아닙니다.");
      return json({ quality: scores, status: pass ? "ready" : "review" });
    }
    if (route === "jobs/cancel" && method === "POST") {
      const i = await body<{ id: string; site_id: string }>(request);
      await workspace(env, i.site_id);
      await env.WORKBOARD_DB.prepare(
        "UPDATE content_jobs SET status='cancelled' WHERE id=? AND site_id=? AND status IN ('review','ready','queued')",
      )
        .bind(i.id, i.site_id)
        .run();
      return json({ ok: true });
    }
    if (route === "settings" && method === "GET")
      return json({
        runtime: "Cloudflare Pages + Cron Worker",
        ai_ready:
          env.AI_ENABLED === "true" &&
          !!(env.AI_PROVIDER === "gemini"
            ? env.GEMINI_API_KEY
            : env.ANTHROPIC_API_KEY),
        ai_provider: env.AI_PROVIDER === "gemini" ? "gemini" : "anthropic",
        ai_models: {
          worker: workerModel(env),
          editor: editorModel(env),
          supervisor: reviewModel(env),
        },
        database_ready: !!env.WORKBOARD_DB,
        workspaces: await Promise.all(catalog.map((w) => readiness(w, env))),
        scheduler: "blog-agent-workboard-scheduler",
        blogger_owner: "aside",
      });
    if (route === "reports" && method === "GET") {
      const w = await workspace(
        env,
        url.searchParams.get("site_id") || active(),
      );
      const runs = await env.WORKBOARD_DB.prepare(
        "SELECT * FROM ai_runs WHERE substr(article_key,1,instr(article_key,'/')-1)=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(w.site_id)
        .all();
      const usage = await budgetUsage(env, w.site_id);
      return json({
        site_id: w.site_id,
        workspace_name: w.name,
        runs: runs.results,
        budget: usage.monthly,
        month: usage.month,
        limits: await budgetSettings(env, w.site_id),
        weekly: usage.weekly,
        examples: await budgetExamples(env, w.site_id),
        resets: {
          weekly: budgetReset("weekly"),
          monthly: budgetReset("monthly"),
        },
      });
    }
    if (route === "budget" && method === "PUT") {
      const input = await body<{ site_id: string }>(request);
      if (typeof input?.site_id !== "string" || !input.site_id)
        throw new HttpError(400, "예산을 설정할 워크스페이스를 선택하세요.");
      const w = await workspace(env, input.site_id);
      const settings = await saveBudgetSettings(env, w.site_id, input);
      wakeHarness(env, waitUntil);
      return json(settings);
    }
    throw new HttpError(404, "요청한 기능을 찾지 못했습니다.");
  } catch (e) {
    return json({ error: message(e) }, e instanceof HttpError ? e.status : 500);
  }
}

function wakeHarness(env: Context["env"], waitUntil: Context["waitUntil"]) {
  if (!env.SCHEDULER_TOKEN || typeof waitUntil !== "function") return;
  waitUntil(
    fetch(
      "https://blog-agent-workboard-scheduler.localmaster.workers.dev/run",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + env.SCHEDULER_TOKEN },
      },
    ).then((r) => {
      if (!r.ok) throw Error("Harness dispatch failed");
    }),
  );
}
