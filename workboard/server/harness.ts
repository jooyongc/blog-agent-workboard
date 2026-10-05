import type { Env } from "./env";
import type { DraftInput } from "../shared/types";
import { workspace, readiness } from "./registry";
import { research } from "./strategy";
import { generate } from "./ai";
import { illustrate } from "./media";
import { verifyGenerated } from "./automation";
import { quality } from "./seo";
import { publishJob } from "./publication";
import { HttpError } from "./http";
const stages = [
  "researcher",
  "writer",
  "photo_editor",
  "verifier",
  "publisher",
];
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
          seo: payload.research.briefs,
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
      payload.input.translations = await illustrate(
        env,
        w,
        payload.slug,
        payload.input.translations,
      );
      payload.input.featured_image_url =
        payload.input.translations[w.languages[0]].images?.[0]?.url;
    }
    if (task.stage === "verifier") {
      const factual = await verifyGenerated(
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
      payload.quality = { languages: scores, factual };
      if (!factual || !Object.values(scores).every((q) => q.passed))
        throw new HttpError(
          409,
          "출처·SEO·AEO·GEO 검증을 통과하지 못했습니다. 결과를 검토하세요.",
        );
    }
    if (task.stage === "publisher") {
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
    const next = stages[stages.indexOf(task.stage) + 1];
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
    "UPDATE content_jobs SET request_json=?,article_json=?,quality_json=?,remote_json=?,status=?,updated_at=? WHERE id=?",
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
