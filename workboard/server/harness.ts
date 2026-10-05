import type { Env } from "./env";
import type { DraftInput } from "../shared/types";
import { workspace, readiness } from "./registry";
import { research } from "./strategy";
import { generate } from "./ai";
import { illustrate } from "./media";
import { verifyGenerated } from "./automation";
import { quality } from "./seo";
import { validateDraft } from "./content";
import { publishJob } from "./publication";
import { HttpError } from "./http";
import { creativeAsset, fireflyReady, PendingMedia } from "./firefly";
const stages = [
  "researcher",
  "writer",
  "photo_editor",
  "verifier",
  "publisher",
];
/**
 * A failed verification gets one bounded rewrite, and a second one only when
 * the first rewrite demonstrably reduced the number of failing claims. Anything
 * else stops in review so paid calls never loop.
 */
export function canRepairAgain(
  attempts: number,
  previousFailing: number | undefined,
  currentFailing: number,
) {
  if (attempts < 1) return true;
  if (attempts === 1)
    return (
      typeof previousFailing === "number" &&
      currentFailing > 0 &&
      currentFailing < previousFailing
    );
  return false;
}
export async function enqueueApproved(env: Env) {
  const topics = await env.WORKBOARD_DB.prepare(
    "SELECT t.id,t.site_id,t.title,t.category FROM topic_ideas t WHERE t.status='approved' AND NOT EXISTS(SELECT 1 FROM agent_workflows f WHERE f.topic_id=t.id) ORDER BY t.created_at LIMIT 5",
  ).all<{ id: string; site_id: string; title: string; category: string }>();
  for (const t of topics.results) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const slug =
      (t.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 65)
        .replace(/-$/g, "") || "topic") +
      "-" +
      t.id.slice(0, 8);
    const claimed = await env.WORKBOARD_DB.prepare(
      "INSERT OR IGNORE INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES(?,?,?,'researcher','pending',?,?,?)",
    )
      .bind(
        id,
        t.id,
        t.site_id,
        JSON.stringify({ title: t.title, category: t.category, slug }),
        now,
        now,
      )
      .run();
    if (!claimed.meta.changes) continue;
    await env.WORKBOARD_DB.prepare(
      "INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'researching',?,?)",
    )
      .bind(id, t.site_id, slug, t.title, t.category, "{}", now, now)
      .run();
    await env.WORKBOARD_DB.prepare(
      "UPDATE topic_ideas SET status='in_progress' WHERE id=?",
    )
      .bind(t.id)
      .run();
  }
}
export async function advanceHarness(env: Env) {
  const reconnect = await env.WORKBOARD_DB.prepare(
    "SELECT job_id,site_id,stage,error FROM agent_workflows WHERE status='failed' AND stage IN ('photo_editor','publisher')",
  ).all<{ job_id: string; site_id: string; stage: string; error: string }>();
  for (const task of reconnect.results) {
    const photoConnected =
      task.stage === "photo_editor" &&
      task.error?.includes("PEXELS_API_KEY") &&
      (env.PEXELS_API_KEY || env.UNSPLASH_ACCESS_KEY);
    const deliveryConnected =
      task.stage === "publisher" &&
      task.error?.includes("사이트 연결 인증") &&
      (await readiness(await workspace(env, task.site_id), env)).ready;
    if (photoConnected || deliveryConnected)
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',error=NULL,updated_at=? WHERE job_id=? AND status='failed'",
      )
        .bind(new Date().toISOString(), task.job_id)
        .run();
  }
  await enqueueApproved(env);
  // A lost lease needs reconciliation; do not silently repeat paid calls or delivery.
  await env.WORKBOARD_DB.prepare(
    "UPDATE agent_workflows SET status='interrupted',error='중단된 단계의 결과 확인이 필요합니다.' WHERE status='running' AND lease_until<?",
  )
    .bind(new Date().toISOString())
    .run();
  const task = await env.WORKBOARD_DB.prepare(
    "SELECT * FROM agent_workflows WHERE status='pending' ORDER BY updated_at LIMIT 1",
  ).first<{
    job_id: string;
    topic_id: string;
    site_id: string;
    stage: string;
    payload_json: string;
  }>();
  if (!task) return { worked: false };
  const now = new Date().toISOString(),
    step = crypto.randomUUID();
  const claim = await env.WORKBOARD_DB.prepare(
    "UPDATE agent_workflows SET status='running',lease_until=?,updated_at=? WHERE job_id=? AND status='pending'",
  )
    .bind(new Date(Date.now() + 12 * 60000).toISOString(), now, task.job_id)
    .run();
  if (!claim.meta.changes) return { worked: false };
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO agent_steps(id,job_id,agent,status,started_at) VALUES(?,?,?,'running',?)",
  )
    .bind(step, task.job_id, task.stage, now)
    .run();
  const payload = JSON.parse(task.payload_json),
    w = await workspace(env, task.site_id);
  await env.WORKBOARD_DB.prepare(
    "UPDATE content_jobs SET status=?,error=NULL,updated_at=? WHERE id=?",
  )
    .bind(
      (
        {
          researcher: "researching",
          writer: "generating",
          photo_editor: "agent_pending",
          verifier: "verifying",
          publisher: "publishing",
        } as Record<string, string>
      )[task.stage] || "agent_pending",
      new Date().toISOString(),
      task.job_id,
    )
    .run();
  let repairNext: string | undefined;
  try {
    if (task.stage === "researcher")
      payload.research = await research(
        env,
        w.site_id,
        payload.title,
        payload.category,
        payload.slug,
      );
    if (task.stage === "writer") {
      const result = await generate(
        {
          site_id: w.site_id,
          slug: payload.slug,
          category: payload.category,
          topic: payload.title,
          research: payload.research.research,
          seo: { briefs: payload.research.briefs, repair: payload.repair },
          attach_images: false,
        },
        env,
      );
      payload.input = {
        site_id: w.site_id,
        slug: payload.slug,
        category: payload.category,
        request_id: task.job_id,
        translations: result.translations,
        reviewed: true,
      } satisfies DraftInput;
    }
    if (task.stage === "photo_editor") {
      if (!payload.input.translations[w.languages[0]].images?.length)
        payload.input.translations = await illustrate(
          env,
          w,
          payload.slug,
          payload.input.translations,
        );
      payload.input.featured_image_url =
        payload.input.translations[w.languages[0]].images?.[0]?.url;
    }
    if (
      task.stage === "photo_editor" &&
      w.strategy.media_mode === "hybrid" &&
      fireflyReady(env)
    ) {
      const prompt = `An editorial conceptual illustration for ${payload.title}. Natural lighting, Korean cultural context, no logos, text, prices or specific product claims. Illustrative, not documentary evidence.`;
      const image = await creativeAsset(
        env,
        task.job_id + "-image",
        w.site_id,
        "image",
        prompt,
      );
      for (const lang of w.languages) {
        const article = payload.input.translations[lang];
        if (!article.images.some((x: any) => x.provider === "Adobe Firefly")) {
          article.content_md += `\n\n![AI-generated conceptual illustration](${image.url})\n\n*AI-generated with Adobe Firefly. Not documentary evidence.*`;
          article.images.push({
            id: task.job_id + "-image",
            provider: "Adobe Firefly",
            url: image.url,
            page: "https://www.adobe.com/products/firefly.html",
            photographer: "Adobe Firefly",
            photographer_url: "https://www.adobe.com/products/firefly.html",
            alt: "AI-generated conceptual illustration",
            license_url: "https://www.adobe.com/legal/terms.html",
          });
        }
      }
      if (w.strategy.generate_video) {
        const video = await creativeAsset(
          env,
          task.job_id + "-video",
          w.site_id,
          "video",
          prompt + " Slow gentle camera movement.",
        );
        for (const lang of w.languages) {
          const article = payload.input.translations[lang];
          article.content_md += `\n\n[Video: AI-generated conceptual footage](${video.url})\n\n*AI-generated with Adobe Firefly. Not documentary evidence.*`;
          article.videos = [
            ...(article.videos || []),
            {
              id: task.job_id + "-video",
              provider: "Adobe Firefly",
              url: video.url,
              page: "https://www.adobe.com/products/firefly.html",
              alt: "AI-generated conceptual footage",
            },
          ];
        }
      }
    }
    if (task.stage === "verifier") {
      const report = await verifyGenerated(
        env,
        w,
        payload.input,
        payload.research.briefs,
      );
      const scores = Object.fromEntries(
        w.languages.map((l) => [
          l,
          quality(payload.input.translations[l], w, l),
        ]),
      );
      payload.quality = {
        languages: scores,
        factual: report.passed,
        verification: report,
      };
      const issues = Object.values(scores).flatMap((q) => q.issues);
      if (!report.passed || !Object.values(scores).every((q) => q.passed)) {
        const failing = report.claims.length + issues.length;
        if (
          canRepairAgain(
            payload.repair_attempts ?? 0,
            payload.repair_failing,
            failing,
          )
        ) {
          payload.repair_attempts = (payload.repair_attempts ?? 0) + 1;
          payload.repair_failing = failing;
          payload.repair = {
            factual: report.passed,
            reason: report.reason,
            unsupported_claims: report.claims.map((c) => ({
              lang: c.lang,
              claim: c.claim,
              status: c.status,
            })),
            issues,
            research_unsupported: Object.values(
              payload.research.briefs as Record<
                string,
                { unsupported?: unknown[] }
              >,
            ).flatMap((b) =>
              Array.isArray(b?.unsupported) ? b.unsupported : [],
            ),
            instruction:
              "Rewrite using only directly supported research. Every listed unsupported or contradicted claim must be deleted or rewritten to state only what the cited evidence says. Also remove any statement about the research_unsupported topics. Do not add new facts, numbers, prices, dates, brand or shop names. Fix all listed structural issues. Keep at least two distinct exact source URLs as visible links.",
          };
          repairNext = "writer";
        } else
          throw new HttpError(
            409,
            `출처·SEO·AEO·GEO 검증을 통과하지 못했습니다. ${[
              report.passed ? "" : report.reason,
              issues.length ? "구조 문제: " + issues.join(" ") : "",
            ]
              .filter(Boolean)
              .join(" ")
              .slice(0, 400)} 결과를 검토하세요.`.replace(/\s+/g, " "),
          );
      }
    }
    if (task.stage === "publisher") {
      validateDraft(payload.input, w);
      if (
        !w.languages.every(
          (l) => quality(payload.input.translations[l], w, l).passed,
        )
      )
        throw new HttpError(
          409,
          "발행 직전 현재 전략의 품질 검증을 통과하지 못했습니다.",
        );
      if (!(await readiness(w, env)).ready)
        throw new HttpError(
          503,
          "글과 사진이 준비되었습니다. 사이트 연결 인증 후 임시 발행을 재개하세요.",
        );
      if (payload.quality?.factual !== true)
        throw new HttpError(409, "검증되지 않은 글은 전송할 수 없습니다.");
      payload.remote = await publishJob(
        env,
        w,
        task.job_id,
        payload.input,
        "draft",
      );
    }
    const next = repairNext || stages[stages.indexOf(task.stage) + 1];
    await env.WORKBOARD_DB.prepare(
      "UPDATE agent_workflows SET stage=?,status=?,payload_json=?,lease_until=NULL,error=NULL,updated_at=? WHERE job_id=?",
    )
      .bind(
        next || task.stage,
        next ? "pending" : "complete",
        JSON.stringify(payload),
        new Date().toISOString(),
        task.job_id,
      )
      .run();
    await env.WORKBOARD_DB.prepare(
      "UPDATE agent_steps SET status='complete',output_json=?,finished_at=? WHERE id=?",
    )
      .bind(
        JSON.stringify({
          next: next || null,
          images: payload.input?.translations[w.languages[0]]?.images?.length,
          quality: payload.quality,
        }),
        new Date().toISOString(),
        step,
      )
      .run();
    if (payload.input)
      await saveProgress(
        env,
        task.job_id,
        payload,
        next ? (next === "writer" ? "generating" : "agent_pending") : "drafted",
      );
    if (!next)
      await env.WORKBOARD_DB.prepare(
        "UPDATE topic_ideas SET status='used' WHERE id=?",
      )
        .bind(task.topic_id)
        .run();
    return {
      worked: true,
      job_id: task.job_id,
      agent: task.stage,
      next: next || null,
    };
  } catch (e) {
    if (e instanceof PendingMedia) {
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',payload_json=?,lease_until=NULL,updated_at=? WHERE job_id=?",
      )
        .bind(JSON.stringify(payload), new Date().toISOString(), task.job_id)
        .run();
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_steps SET status='waiting',finished_at=? WHERE id=?",
      )
        .bind(new Date().toISOString(), step)
        .run();
      if (payload.input)
        await saveProgress(env, task.job_id, payload, "agent_pending");
      return {
        worked: true,
        waiting: true,
        job_id: task.job_id,
        agent: task.stage,
      };
    }
    const error = e instanceof Error ? e.message : "에이전트 실행 실패";
    await env.WORKBOARD_DB.prepare(
      "UPDATE agent_workflows SET status='failed',payload_json=?,error=?,lease_until=NULL,updated_at=? WHERE job_id=?",
    )
      .bind(
        JSON.stringify(payload),
        error,
        new Date().toISOString(),
        task.job_id,
      )
      .run();
    await env.WORKBOARD_DB.prepare(
      "UPDATE agent_steps SET status='failed',error=?,finished_at=? WHERE id=?",
    )
      .bind(error, new Date().toISOString(), step)
      .run();
    if (payload.input) await saveProgress(env, task.job_id, payload, "review");
    else
      await env.WORKBOARD_DB.prepare(
        "UPDATE content_jobs SET status='failed',error=?,updated_at=? WHERE id=?",
      )
        .bind(error, new Date().toISOString(), task.job_id)
        .run();
    await env.WORKBOARD_DB.prepare("UPDATE content_jobs SET error=? WHERE id=?")
      .bind(error, task.job_id)
      .run();
    return { worked: true, job_id: task.job_id, agent: task.stage, error };
  }
}
async function saveProgress(
  env: Env,
  id: string,
  payload: any,
  status: string,
) {
  await env.WORKBOARD_DB.prepare(
    "UPDATE content_jobs SET request_json=?,article_json=?,quality_json=?,remote_json=?,status=?,error=NULL,updated_at=? WHERE id=?",
  )
    .bind(
      JSON.stringify(payload.input),
      JSON.stringify(payload.input.translations),
      payload.quality ? JSON.stringify(payload.quality) : null,
      payload.remote ? JSON.stringify(payload.remote) : null,
      status,
      new Date().toISOString(),
      id,
    )
    .run();
}
