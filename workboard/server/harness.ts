import type { Env } from "./env";
import type { DraftInput } from "../shared/types";
import { workspace, readiness } from "./registry";
import { research } from "./strategy";
import { generate } from "./ai";
import { illustrate, approvedMedia } from "./media";
import { verifyGenerated } from "./automation";
import { quality } from "./seo";
import { validateDraft } from "./content";
import { publishJob } from "./publication";
import { HttpError } from "./http";
import {
  BudgetWait,
  IncompleteResponse,
  ProviderWait,
  workerModel,
  reviewModel,
} from "./model";
import { budgetSettings } from "./budget";
import {
  supervise,
  editUnderSupervision,
  prepareForReview,
  articleFingerprint,
  MAX_SUPERVISOR_ROUNDS,
  SUPERVISOR_MODEL,
} from "./supervisor";
import { creativeAsset, fireflyReady, PendingMedia } from "./firefly";
const stages = [
  "researcher",
  "writer",
  "photo_editor",
  "verifier",
  "supervisor",
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
export function planRepair(payload: any, w: { languages: string[] }) {
  const report = payload.quality?.verification;
  if (!report || !payload.input || !payload.research?.briefs) return false;
  const issues = Object.values(payload.quality.languages || {}).flatMap(
    (q: any) => q.issues || [],
  );
  const failing = (report.claims?.length || 0) + issues.length;
  if (report.passed && !failing) return false;
  const previous =
    payload.repair_failing ??
    (payload.repair?.unsupported_claims
      ? payload.repair.unsupported_claims.length +
        (payload.repair.issues?.length || 0)
      : undefined);
  if (!canRepairAgain(payload.repair_attempts ?? 0, previous, failing))
    return false;
  payload.repair_attempts = (payload.repair_attempts ?? 0) + 1;
  payload.repair_failing = failing;
  const targets = w.languages.filter(
    (l) =>
      report.claims?.some((c: any) => c.lang === l) ||
      !payload.quality.languages?.[l]?.passed,
  );
  payload.repair = {
    factual: report.passed,
    reason: report.reason,
    target_languages: targets.length ? targets : w.languages,
    unsupported_claims: (report.claims || []).map((c: any) => ({
      ...c,
      evidence: payload.research.briefs[c.lang]?.sources?.filter(
        (source: any) => source.url === c.source_url,
      ),
    })),
    issues,
    research_unsupported: Object.values(payload.research.briefs).flatMap(
      (b: any) => b.unsupported || [],
    ),
    instruction:
      "Correct listed contradicted or unsupported statements everywhere including introduction, tables and FAQ. Use only the exact supplied evidence. Distinguish weekdays from weekends and holidays, and 24:00 midnight from 25:00 next-day 01:00. Delete claims without evidence. Never invent facts. Keep two distinct exact research source URLs visible. Independently write each target language and preserve unaffected languages.",
  };
  return true;
}
export async function recoverWorkflows(env: Env, now = Date.now()) {
  const tasks = await env.WORKBOARD_DB.prepare(
    "SELECT job_id,site_id,stage,status,error,payload_json FROM agent_workflows WHERE status IN ('failed','budget_wait','retry_wait') AND EXISTS(SELECT 1 FROM content_jobs c WHERE c.id=agent_workflows.job_id AND c.status NOT IN ('cancelled','published','drafted')) ORDER BY updated_at LIMIT 100",
  ).all<{
    job_id: string;
    site_id: string;
    stage: string;
    status: string;
    error: string;
    payload_json: string;
  }>();
  const budgets = new Map<string, Awaited<ReturnType<typeof budgetSettings>>>();
  for (const task of tasks.results) {
    if (task.status === "budget_wait" && !budgets.has(task.site_id))
      budgets.set(task.site_id, await budgetSettings(env, task.site_id));
    const settings = budgets.get(task.site_id);
    const payload = JSON.parse(task.payload_json);
    let stage = task.stage,
      resume = false;
    if (
      (stage === "verifier" ||
        (stage === "publisher" && task.error?.includes("상위 검토 승인"))) &&
      payload.input &&
      payload.research?.briefs &&
      (payload.supervisor_rounds || 0) < MAX_SUPERVISOR_ROUNDS
    ) {
      stage = "supervisor";
      if (task.status === "budget_wait") {
        await env.WORKBOARD_DB.prepare(
          "UPDATE agent_workflows SET stage='supervisor',payload_json=? WHERE job_id=? AND status='budget_wait' AND stage='verifier'",
        )
          .bind(JSON.stringify(payload), task.job_id)
          .run();
      } else resume = true;
    }
    if (task.status === "budget_wait")
      resume =
        Date.parse(payload.recovery?.retry_at) <= now ||
        (settings !== undefined &&
          settings.revision > (payload.recovery?.budget_revision ?? 1));
    else if (task.error?.includes("예산") && task.error.includes("한도"))
      resume = true;
    else if (
      stage === "writer" &&
      payload.repair?.target_languages &&
      task.error?.includes("실제 언어 오류")
    )
      resume = true;
    if (
      task.status === "failed" &&
      ["supervisor", "editor"].includes(stage) &&
      task.error?.includes("AI 답변이 완결") &&
      !(payload.response_retries >= 1)
    ) {
      payload.response_retries = (payload.response_retries || 0) + 1;
      resume = true;
    }
    if (
      task.status === "failed" &&
      ["supervisor", "editor"].includes(stage) &&
      task.error?.includes("AI 응답 형식을 확인하지") &&
      !(payload.format_retries >= 1)
    ) {
      const run = await env.WORKBOARD_DB.prepare(
        "SELECT actual,status FROM ai_runs WHERE article_key=? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(`${task.site_id}/${payload.slug}`)
        .first<{ actual: number | null; status: string }>();
      // A fully received, billed malformed response is safe to repeat once.
      // Unknown delivery/timeouts retain their reconciliation gate.
      if (run?.status === "failed" && run.actual !== null) {
        payload.format_retries = (payload.format_retries || 0) + 1;
        resume = true;
      }
    }
    if(task.status === "failed" && stage === "researcher" && env.AI_PROVIDER === "gemini" && task.error?.includes("독립적인 출처") && !payload.grounding_recovery_v2) {
      payload.grounding_recovery_v2 = true;
      resume = true;
    }
    if (task.status === "retry_wait")
      resume = Date.parse(payload.provider_retry_at) <= now;
    if (
      task.status === "failed" &&
      ["supervisor", "editor"].includes(stage) &&
      task.error?.includes("AI 요청을 처리하지") &&
      !payload.legacy_provider_retry
    ) {
      const run = await env.WORKBOARD_DB.prepare(
        "SELECT actual,status FROM ai_runs WHERE article_key=? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(`${task.site_id}/${payload.slug}`)
        .first<{ actual: number | null; status: string }>();
      if (run?.status === "failed" && run.actual === 0) {
        payload.legacy_provider_retry = true;
        resume = true;
      }
    }
    if (
      task.status === "failed" &&
      stage === "publisher" &&
      task.error?.includes("원격에 같은 slug")
    )
      resume = true;
    if (
      task.status === "failed" &&
      env.AI_PROVIDER === "gemini" &&
      env.GEMINI_API_KEY &&
      task.error?.includes("credit balance") &&
      !payload.gemini_transition
    ) {
      payload.gemini_transition = true;
      resume = true;
    }
    if (!resume) continue;
    delete payload.recovery;
    const changed = await env.WORKBOARD_DB.prepare(
      "UPDATE agent_workflows SET stage=?,status='pending',error=NULL,payload_json=?,updated_at=? WHERE job_id=? AND status=?",
    )
      .bind(
        stage,
        JSON.stringify(payload),
        new Date(now).toISOString(),
        task.job_id,
        task.status,
      )
      .run();
    if (changed.meta.changes)
      await env.WORKBOARD_DB.prepare(
        "UPDATE content_jobs SET status='agent_pending',error=NULL,updated_at=? WHERE id=? AND status NOT IN ('cancelled','published','drafted')",
      )
        .bind(new Date(now).toISOString(), task.job_id)
        .run();
  }
}

export async function enqueueApproved(env: Env) {
  const topics = await env.WORKBOARD_DB.prepare(
    "SELECT t.id,t.site_id,t.title,t.category FROM topic_ideas t WHERE t.status='approved' AND NOT EXISTS(SELECT 1 FROM agent_workflows f WHERE f.topic_id=t.id) ORDER BY t.created_at LIMIT 5",
  ).all<{ id: string; site_id: string; title: string; category: string }>();
  for (const t of topics.results) {
    if ((await workspace(env, t.site_id)).schedule.owner === "aside") continue;
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
  await recoverWorkflows(env);
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
    "SELECT * FROM agent_workflows WHERE status='pending' AND site_id NOT IN (SELECT site_id FROM workspace_records WHERE json_extract(config_json,'$.schedule.owner')='aside') ORDER BY updated_at LIMIT 1",
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
          supervisor: "supervising",
          editor: "editing",
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
        payload.supervision?.at(-1)?.action === "research"
          ? payload.supervision.at(-1).instructions
          : undefined,
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
          target_languages: payload.repair?.target_languages,
        },
        env,
      );
      payload.input = {
        site_id: w.site_id,
        slug: payload.slug,
        category: payload.category,
        request_id: task.job_id,
        translations: {
          ...(payload.input?.translations || {}),
          ...result.translations,
        },
        reviewed: true,
      } satisfies DraftInput;
    }
    if (task.stage === "photo_editor") {
      if (
        w.languages.some(
          (l) =>
            (env.MEDIA_POLICY === "adobe-generated" &&
              !approvedMedia(payload.input.translations[l])) ||
            (payload.input.translations[l].images?.length || 0) <
              Math.max(2, w.strategy.required_images),
        )
      )
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
      repairNext = "supervisor";
    }
    if (task.stage === "editor") {
      await editUnderSupervision(env, w, payload);
      repairNext = "photo_editor";
    }
    if (task.stage === "supervisor") {
      for (const lang of w.languages)
        payload.input.translations[lang] = prepareForReview(
          payload.input.translations[lang],
          payload.research.briefs[lang],
          lang,
        );
      const decision = await supervise(env, w, payload);
      payload.supervisor_rounds = decision.round;
      payload.supervision = [...(payload.supervision || []), decision];
      if (decision.action === "approve") {
        payload.quality = {
          languages: Object.fromEntries(
            w.languages.map((l) => [
              l,
              quality(payload.input.translations[l], w, l),
            ]),
          ),
          factual: true,
          verification: {
            passed: true,
            reason: decision.reason,
            verified: decision.claims.length,
            claims: [],
          },
        };
        payload.supervisor_approval = await articleFingerprint(payload.input);
        repairNext = "publisher";
      } else if (
        decision.action === "edit" &&
        decision.round < MAX_SUPERVISOR_ROUNDS
      )
        repairNext = "editor";
      else if (
        decision.action === "research" &&
        decision.round < MAX_SUPERVISOR_ROUNDS &&
        !(payload.supervisor_researches >= 1)
      ) {
        payload.supervisor_researches =
          (payload.supervisor_researches || 0) + 1;
        payload.repair = {
          target_languages: decision.target_languages,
          instruction: decision.instructions,
        };
        repairNext = "researcher";
      } else
        throw new HttpError(
          409,
          `상위 검토: ${decision.reason} ${decision.round >= MAX_SUPERVISOR_ROUNDS ? "자동 보완 한도에 도달했습니다." : "추가 근거 또는 연결 설정이 필요합니다."}`,
        );
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
      if (
        payload.supervisor_approval !==
        (await articleFingerprint(payload.input))
      )
        throw new HttpError(
          409,
          "현재 글에 대한 상위 검토 승인이 없어 전송하지 않았습니다.",
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
          supervision:
            task.stage === "supervisor"
              ? payload.supervision?.at(-1)
              : undefined,
          model: ["supervisor", "editor"].includes(task.stage)
            ? reviewModel(env)
            : ["researcher", "writer", "verifier"].includes(task.stage)
              ? task.stage === "researcher" && env.AI_PROVIDER === "gemini"
                ? "gemini-2.5-flash"
                : workerModel(env)
              : undefined,
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
        next
          ? (
              {
                writer: "generating",
                supervisor: "supervising",
                editor: "editing",
              } as Record<string, string>
            )[next] || "agent_pending"
          : "drafted",
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
    if (e instanceof ProviderWait) {
      const retryKey =
        task.stage +
        "/" +
        (payload.supervision?.at(-1)?.run_id || payload.supervisor_rounds || 0);
      payload.provider_retries ||= {};
      const count = payload.provider_retries[retryKey] || 0;
      if (count < 3) {
        const delay = Math.min(900, e.retrySeconds * Math.pow(2, count));
        payload.provider_retries[retryKey] = count + 1;
        payload.provider_retry_at = new Date(
          Date.now() + delay * 1000,
        ).toISOString();
        await env.WORKBOARD_DB.prepare(
          "UPDATE agent_workflows SET status='retry_wait',payload_json=?,error=?,lease_until=NULL,updated_at=? WHERE job_id=?",
        )
          .bind(
            JSON.stringify(payload),
            e.message,
            new Date().toISOString(),
            task.job_id,
          )
          .run();
        await env.WORKBOARD_DB.prepare(
          "UPDATE agent_steps SET status='waiting',error=?,finished_at=? WHERE id=?",
        )
          .bind(e.message, new Date().toISOString(), step)
          .run();
        if (payload.input)
          await saveProgress(env, task.job_id, payload, "retry_wait");
        await env.WORKBOARD_DB.prepare(
          "UPDATE content_jobs SET status='retry_wait',error=?,updated_at=? WHERE id=?",
        )
          .bind(e.message, new Date().toISOString(), task.job_id)
          .run();
        return {
          worked: true,
          waiting: true,
          delay_seconds: delay,
          job_id: task.job_id,
          agent: task.stage,
        };
      }
    }
    if (
      e instanceof IncompleteResponse &&
      ["supervisor", "editor"].includes(task.stage) &&
      !(payload.response_retries >= 1)
    ) {
      payload.response_retries = (payload.response_retries || 0) + 1;
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',payload_json=?,error=NULL,lease_until=NULL,updated_at=? WHERE job_id=?",
      )
        .bind(JSON.stringify(payload), new Date().toISOString(), task.job_id)
        .run();
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_steps SET status='waiting',error='출력 길이 제한: 한 번 자동 복구합니다.',finished_at=? WHERE id=?",
      )
        .bind(new Date().toISOString(), step)
        .run();
      if (payload.input)
        await saveProgress(
          env,
          task.job_id,
          payload,
          task.stage === "supervisor" ? "supervising" : "editing",
        );
      return {
        worked: true,
        job_id: task.job_id,
        agent: task.stage,
        recovering: true,
      };
    }
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
    if (e instanceof BudgetWait) {
      payload.recovery = {
        scope: e.scope,
        retry_at: e.retryAt,
        budget_revision: e.revision,
      };
      const error = `${e.message} 한도 갱신 후 자동 재개합니다.`;
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='budget_wait',payload_json=?,error=?,lease_until=NULL,updated_at=? WHERE job_id=?",
      )
        .bind(
          JSON.stringify(payload),
          error,
          new Date().toISOString(),
          task.job_id,
        )
        .run();
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_steps SET status='waiting',error=?,finished_at=? WHERE id=?",
      )
        .bind(error, new Date().toISOString(), step)
        .run();
      if (payload.input)
        await saveProgress(env, task.job_id, payload, "budget_wait");
      await env.WORKBOARD_DB.prepare(
        "UPDATE content_jobs SET status='budget_wait',error=?,updated_at=? WHERE id=?",
      )
        .bind(error, new Date().toISOString(), task.job_id)
        .run();
      return {
        worked: true,
        job_id: task.job_id,
        agent: task.stage,
        blocked: true,
        retry_at: e.retryAt,
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
