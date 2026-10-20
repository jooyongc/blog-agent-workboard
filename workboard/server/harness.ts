import {nextWake} from "./control-room";
import {planMediaRecovery,recordMediaResourceWait,planMediaRepair,ImageCandidatesRejected} from "./media-recovery";
import {applyModelSettings} from "./model-settings";
import { importLicensedMedia } from "./media-import";
import type { Env } from "./env";
import type { DraftInput } from "../shared/types";
import { workspace, readiness } from "./registry";
import { research } from "./strategy";
import { generate } from "./ai";
import { generatedImagesReady } from "./generated-media";
import { illustrate, approvedMedia, stockPhotos } from "./media";
import { verifyGenerated } from "./automation";
import { quality } from "./seo";
import { validateDraft } from "./content";
import { publishJob } from "./publication";
import { HttpError } from "./http";
import {
  BudgetWait,
  IncompleteResponse,
  MalformedResponse,
  UnsettledResponse,
  ProviderWait,
  workerModel,
  reviewModel,
  editorModel,
} from "./model";
import { budgetSettings } from "./budget";
import {
  supervise,
  editUnderSupervision,
  prepareForReview,
  articleFingerprint,
  MAX_SUPERVISOR_ROUNDS,
  planFinalCorrection,
  convertExhaustedResearch,
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
/**
 * Every stop is classified once, at the moment it happens, and the class is
 * persisted with the checkpoint. Recovery decides from the class, never from a
 * substring of a human-readable message.
 */
export type FailureKind =
  | "incomplete"
  | "malformed"
  | "transient"
  | "evidence"
  | "review"
  | "provider"
  | "unknown"
  | "media"
  | "connection"
  | "other";
export const AUTO_RETRY_LIMIT = 1;
export const LEASE_MINUTES = 12;
const stageStatus: Record<string, string> = {
  researcher: "researching",
  writer: "generating",
  photo_editor: "agent_pending",
  verifier: "verifying",
  supervisor: "supervising",
  editor: "editing",
  publisher: "publishing",
};
export function classifyFailure(e: unknown, stage: string): FailureKind {
  if (e instanceof IncompleteResponse)
    return e.recoverable ? "incomplete" : "provider";
  if (e instanceof MalformedResponse) return "malformed";
  if (e instanceof UnsettledResponse) return "unknown";
  if (e instanceof ProviderWait) return "transient";
  return classifyMessage(e instanceof Error ? e.message : "", stage);
}
/** Fallback for checkpoints written before the class was persisted. */
export function classifyMessage(message: string, stage: string): FailureKind {
  if (/AI 답변이 완결되지 않았습니다/.test(message)) return "incomplete";
  if (/AI 응답 형식을 확인하지 못했습니다|글 형식을 확인하지 못했습니다|판단 형식을 확인하지 못했습니다|검증 형식이 올바르지|지시 내용이 없습니다|국소 수정 형식/.test(message))
    return "malformed";
  if (/AI 응답을 받지 못했습니다/.test(message)) return "unknown";
  if (/일시적으로 요청을 제한/.test(message)) return "transient";
  if (
    stage === "researcher" &&
    /독립적인 출처|출처 근거를 확인|핵심 용어/.test(message)
  )
    return "evidence";
  if (/^상위 검토/.test(message)) return "review";
  if (/AI 요청이 거절|AI 요청을 처리하지|credit balance/i.test(message))
    return "provider";
  if (/MEDIA_REVIEW|이미지/.test(message)) return "media";
  if (/사이트 연결 인증|연결 변수|OAuth/.test(message)) return "connection";
  return "other";
}
/**
 * Bounded, visible automatic retry. At most AUTO_RETRY_LIMIT repeat per role
 * and review round, only for an unfinished or malformed answer or a research
 * pass that found too few sources, and only when the previous charge is known.
 * The repeat runs with a larger output ceiling, so a truncated answer is not
 * simply reproduced. Media and delivery keep their own receipts and are never
 * repeated here. Returns the attempt number or 0.
 */
export function planAutoRetry(
  payload: any,
  stage: string,
  kind: FailureKind,
  settled: boolean,
) {
  if (!["incomplete", "malformed", "evidence"].includes(kind)) return 0;
  if (!settled || ["publisher", "photo_editor"].includes(stage)) return 0;
  const key = `${stage}/${payload.supervisor_rounds || 0}`;
  payload.retries ||= {};
  const used = Number(payload.retries[key]) || 0;
  if (used >= AUTO_RETRY_LIMIT) return 0;
  payload.retries[key] = used + 1;
  return used + 1;
}
function retryNotice(kind: FailureKind, attempt: number) {
  return `${
    kind === "evidence"
      ? "확인된 출처가 부족해 검색을 한 번 더 실행합니다."
      : kind === "incomplete"
        ? "답변이 중간에 끊겨 출력 한도를 늘려 한 번 더 실행합니다."
        : "응답 형식이 맞지 않아 출력 한도를 늘려 한 번 더 실행합니다."
  } (자동 복구 ${attempt}/${AUTO_RETRY_LIMIT})`;
}
/** Output ceiling level for the current role: the number of automatic repeats already used. */
export function outputBoost(payload: any, stage: string) {
  return Number(payload.retries?.[`${stage}/${payload.supervisor_rounds || 0}`]) || 0;
}
/**
 * True only when every model run made for this article since the role started
 * has a known charge. A newer settled run (for example an operator recheck)
 * cannot hide an earlier unknown one.
 */
async function chargeSettled(
  env: Env,
  siteId: string,
  slug: string | undefined,
  since: string | null,
) {
  if (!slug) return true;
  const open = await env.WORKBOARD_DB.prepare(
    "SELECT COUNT(*) AS n FROM ai_runs WHERE article_key=? AND created_at>=? AND (actual IS NULL OR status IN ('running','interrupted'))",
  )
    .bind(`${siteId}/${slug}`, since ?? "")
    .first<{ n: number }>();
  return !open?.n;
}
async function roleStarted(env: Env, jobId: string, stage: string) {
  const row = await env.WORKBOARD_DB.prepare(
    "SELECT started_at FROM agent_steps WHERE job_id=? AND agent=? ORDER BY started_at DESC LIMIT 1",
  )
    .bind(jobId, stage)
    .first<{ started_at: string }>();
  return row?.started_at ?? null;
}
const LEGACY_RETRY_FLAGS: Partial<Record<FailureKind, string[]>> = {
  incomplete: ["response_retries"],
  malformed: ["format_retries"],
  evidence: ["grounding_recovery_v3", "flash36_transition", "flash31_transition"],
};
function wipResearchValid(notes: Record<string, string> | undefined) {
  return (
    !!notes &&
    Object.values(notes).every(
      (note) =>
        typeof note === "string" &&
        note.trim().length >= 30 &&
        note.length <= 360000,
    )
  );
}
export async function recoverWorkflows(env: Env, now = Date.now()) {
  const tasks = await env.WORKBOARD_DB.prepare(
    "SELECT job_id,site_id,stage,status,error,payload_json FROM agent_workflows WHERE status IN ('failed','budget_wait','retry_wait','media_wait') AND site_id NOT IN (SELECT site_id FROM workspace_records WHERE json_extract(config_json,'$.schedule.owner')='aside') AND EXISTS(SELECT 1 FROM content_jobs c WHERE c.id=agent_workflows.job_id AND c.status NOT IN ('cancelled','published','drafted')) ORDER BY updated_at LIMIT 100",
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
    if(task.status==="media_wait" && stage==="photo_editor" && payload.input){
      const job=await env.WORKBOARD_DB.prepare("SELECT request_json FROM content_jobs WHERE id=?").bind(task.job_id).first<{request_json:string}>();
      if(job?.request_json===JSON.stringify(payload.input) && await chargeSettled(env,task.site_id,payload.slug,null)){
        const first=Object.values(payload.input.translations)[0] as any;
        const candidates=await stockPhotos(env,first.primary_keyword || first.title,0,task.site_id);
        const seen=new Set(payload.media_library_checked || []);
        if(candidates.some(p=>!seen.has(p.id))){payload.media_library_checked=candidates.map(p=>p.id);resume=true;}
      }
    }
    if(task.status==="media_wait" && stage==="photo_editor" && !payload.media_manual_hold && payload.photo_retry_revision && payload.media_recovery?.reasons?.length){
      const job=await env.WORKBOARD_DB.prepare("SELECT request_json FROM content_jobs WHERE id=?").bind(task.job_id).first<{request_json:string}>();
      if(job?.request_json===JSON.stringify(payload.input)){
        // Stored recovery reasons may predate the latest failed slot; read actual rejected receipts.
        const last=await env.WORKBOARD_DB.prepare("SELECT id,result_json FROM creative_requests WHERE site_id=? AND kind='image' AND status='complete' AND substr(id,1,length(?))=? AND instr(id,'-v4-')>0 AND json_extract(result_json,'$.visual_review.approved')=0 ORDER BY created_at DESC LIMIT 1").bind(task.site_id,`${task.site_id}-${payload.slug}-gemini-image-`,`${task.site_id}-${payload.slug}-gemini-image-`).first<{id:string;result_json:string}>();
        if(last){const slot=Number(last.id.match(/-v4-(\d+)-\d+$/)?.[1]);const photo=JSON.parse(last.result_json);
          if(Number.isInteger(slot) && planMediaRepair(payload,new ImageCandidatesRejected(slot,[photo.visual_review.reason]),await chargeSettled(env,task.site_id,payload.slug,null)))resume=true;
        }
      }
    }
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
    if (task.status === "failed" && !resume) {
      // One policy for every role: the persisted class decides, a bounded counter limits it,
      // and an unknown charge (no settled ai_run) keeps the reconciliation gate.
      const failure =
        payload.last_failure?.stage === task.stage ? payload.last_failure : null;
      const kind: FailureKind =
        failure?.kind ?? classifyMessage(task.error || "", task.stage);
      // Checkpoints from before this policy keep the retries they already spent.
      const spent =
        !failure &&
        (LEGACY_RETRY_FLAGS[kind] || []).some((flag) => payload[flag]);
      // An operator who edited the stopped draft owns it now; never overwrite that edit.
      const job = await env.WORKBOARD_DB.prepare(
        "SELECT request_json FROM content_jobs WHERE id=?",
      )
        .bind(task.job_id)
        .first<{ request_json: string }>();
      const edited =
        !!payload.input && job?.request_json !== JSON.stringify(payload.input);
      if (
        !spent &&
        !edited &&
        ["incomplete", "malformed", "evidence"].includes(kind) &&
        planAutoRetry(
          payload,
          task.stage,
          kind,
          await chargeSettled(
            env,
            task.site_id,
            payload.slug,
            await roleStarted(env, task.job_id, task.stage),
          ),
        )
      ) {
        resume = true;
        const at = new Date(now).toISOString();
        await env.WORKBOARD_DB.prepare(
          "INSERT INTO agent_steps(id,job_id,agent,status,error,started_at,finished_at) VALUES(?,?,?,'waiting',?,?,?)",
        )
          .bind(
            crypto.randomUUID(),
            task.job_id,
            task.stage,
            retryNotice(kind, 1),
            at,
            at,
          )
          .run();
      }
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
    if (
      task.status === "failed" &&
      stage === "writer" &&
      task.error?.includes("출처 메모") &&
      !payload.research_length_recovery &&
      wipResearchValid(payload.research?.research)
    ) {
      payload.research_length_recovery = true;
      resume = true;
    }
    if (
      task.status === "budget_wait" &&
      stage === "photo_editor" &&
      task.error?.startsWith("이미지 생성") &&
      !payload.image_budget_sizing_v2
    ) {
      payload.image_budget_sizing_v2 = true;
      resume = true;
    }
    if (
      task.status === "budget_wait" &&
      stage === "supervisor" &&
      env.AI_PROVIDER === "gemini" &&
      payload.input &&
      Object.keys(payload.input.translations).length === 1 &&
      !payload.review_budget_sizing_v2
    ) {
      payload.review_budget_sizing_v2 = true;
      resume = true;
    }
    const rejectedApproval=payload.supervision?.at(-1);
    if(task.status === "failed" && stage === "supervisor" && task.error?.includes("자동 보완 한도") && rejectedApproval && planFinalCorrection(payload,rejectedApproval)){
      stage="editor";resume=true;
    }
    if(task.status === "failed" && stage === "supervisor" && !payload.invalid_approval_instruction_recovery && rejectedApproval?.action === "edit" && /no further edits|no edits required/i.test(rejectedApproval.instructions || "") && rejectedApproval.claims?.some((c:any)=>c.status!=="verified")) {
      rejectedApproval.instructions="Remove these unsupported claims everywhere, including introduction, body, tables and FAQ: " + JSON.stringify(rejectedApproval.claims.filter((c:any)=>c.status!=="verified").map((c:any)=>({lang:c.lang,claim:c.claim,source_url:c.source_url}))) + ". Do not follow the stale no-edit instruction. Preserve reviewed images and retain only facts backed by exact supplied evidence.";
      payload.invalid_approval_instruction_recovery=true;
      payload.supervisor_rounds=MAX_SUPERVISOR_ROUNDS-1;
      delete payload.supervisor_approval;
      stage="editor";resume=true;
    }
    if (!resume) continue;
    delete payload.recovery;
    if (payload.last_failure?.stage === task.stage) delete payload.last_failure;
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
/**
 * A lease that expired means the request executing that role died. The role
 * result is unknown, so the checkpoint, its step row and any still-running
 * cost reservation are all marked interrupted (the reservation stays counted).
 */
export async function expireLeases(env: Env, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const expired = await env.WORKBOARD_DB.prepare(
    "SELECT job_id,site_id,stage,payload_json,lease_until FROM agent_workflows WHERE status='running' AND lease_until<?",
  )
    .bind(iso)
    .all<{ job_id: string; site_id: string; stage: string; payload_json: string; lease_until: string }>();
  for (const row of expired.results) {
    const changed = await env.WORKBOARD_DB.prepare(
      "UPDATE agent_workflows SET status='interrupted',error='중단된 단계의 결과 확인이 필요합니다.',lease_until=NULL,updated_at=? WHERE job_id=? AND status='running' AND lease_until<?",
    )
      .bind(iso, row.job_id, iso)
      .run();
    if (!changed.meta.changes) continue;
    await env.WORKBOARD_DB.prepare(
      "UPDATE agent_steps SET status='interrupted',error='실행 리스가 만료되어 결과를 받지 못했습니다.',finished_at=? WHERE job_id=? AND status='running' AND started_at<?",
    )
      .bind(iso, row.job_id, row.lease_until)
      .run();
    const slug = JSON.parse(row.payload_json || "{}").slug;
    if (slug)
      await env.WORKBOARD_DB.prepare(
        "UPDATE ai_runs SET status='interrupted' WHERE article_key=? AND status='running' AND created_at<?",
      )
        .bind(`${row.site_id}/${slug}`, row.lease_until)
        .run();
    await env.WORKBOARD_DB.prepare(
      "UPDATE content_jobs SET status=?,error=?,updated_at=? WHERE id=? AND status NOT IN ('cancelled','published','drafted') AND EXISTS(SELECT 1 FROM agent_workflows f WHERE f.job_id=content_jobs.id AND f.status='interrupted')",
    )
      .bind(
        row.stage === "publisher" ? "needs_reconcile" : "review",
        row.stage === "publisher"
          ? "임시 발행 단계가 중단되었습니다. 원격 초안 존재 여부를 확인한 뒤 재개하세요."
          : "에이전트 단계 실행이 중단되었습니다. 저장된 결과를 확인한 뒤 '중단 단계부터 재개'를 누르세요.",
        iso,
        row.job_id,
      )
      .run();
  }
  // Step rows whose workflow already moved on must not stay "running" forever.
  await env.WORKBOARD_DB.prepare(
    "UPDATE agent_steps SET status='interrupted',error='실행 결과를 받지 못한 단계입니다.',finished_at=? WHERE status='running' AND started_at<? AND job_id NOT IN (SELECT job_id FROM agent_workflows WHERE status='running')",
  )
    .bind(iso, new Date(now - LEASE_MINUTES * 60000).toISOString())
    .run();
  return expired.results.length;
}
export async function advanceHarness(env: Env) {
  if (await importLicensedMedia(env))
    return { worked: true, agent: "licensed_media_import" };
  await expireLeases(env);
  await recoverWorkflows(env);
  const reconnect = await env.WORKBOARD_DB.prepare(
    "SELECT job_id,site_id,stage,error,payload_json FROM agent_workflows WHERE status IN ('failed','media_wait') AND stage IN ('photo_editor','publisher') AND EXISTS(SELECT 1 FROM content_jobs c WHERE c.id=agent_workflows.job_id AND c.status NOT IN ('cancelled','published','drafted'))",
  ).all<{
    job_id: string;
    site_id: string;
    stage: string;
    error: string;
    payload_json: string;
  }>();
  for (const task of reconnect.results) {
    const photoConnected =
      task.stage === "photo_editor" &&
      generatedImagesReady(env) &&
      !JSON.parse(task.payload_json || "{}").auto_media_started;
    const deliveryConnected =
      task.stage === "publisher" &&
      task.error?.includes("사이트 연결 인증") &&
      (await readiness(await workspace(env, task.site_id), env)).ready;
    if (photoConnected || deliveryConnected)
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',error=NULL,updated_at=? WHERE job_id=? AND status IN ('failed','media_wait')",
      )
        .bind(new Date().toISOString(), task.job_id)
        .run();
  }
  await enqueueApproved(env);
  if (env.MEDIA_POLICY === "adobe-generated" && generatedImagesReady(env)) {
    const outdated = await env.WORKBOARD_DB.prepare(
      "SELECT job_id,payload_json FROM agent_workflows WHERE status='pending' AND stage IN ('verifier','supervisor','publisher')",
    ).all<{ job_id: string; payload_json: string }>();
    for (const row of outdated.results) {
      const payload = JSON.parse(row.payload_json);
      if (
        payload.input &&
        Object.values(payload.input.translations).some(
          (article: any) => !approvedMedia(article),
        )
      ) {
        delete payload.supervisor_approval;
        payload.supervisor_rounds = 0;
        await env.WORKBOARD_DB.prepare(
          "UPDATE agent_workflows SET stage='photo_editor',payload_json=?,updated_at=? WHERE job_id=? AND status='pending'",
        )
          .bind(JSON.stringify(payload), new Date().toISOString(), row.job_id)
          .run();
      }
    }
  }
  const task = await env.WORKBOARD_DB.prepare(
    "SELECT * FROM agent_workflows WHERE status='pending' AND site_id NOT IN (SELECT site_id FROM workspace_records WHERE json_extract(config_json,'$.schedule.owner')='aside') ORDER BY updated_at LIMIT 1",
  ).first<{
    job_id: string;
    topic_id: string;
    site_id: string;
    stage: string;
    payload_json: string;
  }>();
  if (!task) {const delay=await nextWake(env);return {worked:false,waiting:delay!==null,delay_seconds:delay ?? undefined};}
  const now = new Date().toISOString(),
    step = crypto.randomUUID();
  const claim = await env.WORKBOARD_DB.prepare(
    "UPDATE agent_workflows SET status='running',lease_until=?,updated_at=? WHERE job_id=? AND status='pending'",
  )
    .bind(new Date(Date.now() + LEASE_MINUTES * 60000).toISOString(), now, task.job_id)
    .run();
  if (!claim.meta.changes) return { worked: false };
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO agent_steps(id,job_id,agent,status,started_at) VALUES(?,?,?,'running',?)",
  )
    .bind(step, task.job_id, task.stage, now)
    .run();
  env = await applyModelSettings(env);
  const payload = JSON.parse(task.payload_json),
    w = await workspace(env, task.site_id);
  env = {...env, MEDIA_GENERATION_REVISION: payload.photo_retry_revision || 3, MEDIA_RECOVERY_REASONS:payload.media_recovery?.reasons || [], MEDIA_REPAIR:payload.media_repair, MEDIA_MANUAL_ONLY:payload.media_manual_hold, MEDIA_EXCLUDED_IDS:payload.media_excluded_ids, AI_OUTPUT_BOOST: outputBoost(payload, task.stage)};
  await env.WORKBOARD_DB.prepare(
    "UPDATE content_jobs SET status=?,error=NULL,updated_at=? WHERE id=?",
  )
    .bind(
      stageStatus[task.stage] || "agent_pending",
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
      if (generatedImagesReady(env)) payload.auto_media_started = true;
      if (
        w.languages.some(
          (l) =>
            payload.media_manual_hold ||
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
      delete payload.media_manual_hold;
      if(payload.media_recovery)payload.media_recovery={...payload.media_recovery,state:"complete",finished_at:new Date().toISOString()};
      if(payload.media_repair)payload.media_repair={...payload.media_repair,state:"complete"};
      if(payload.supervision?.length)repairNext="supervisor";
      payload.input.featured_image_url =
        payload.input.translations[w.languages[0]].images?.[0]?.url;
    }
    if (
      task.stage === "photo_editor" &&
      env.MEDIA_POLICY !== "adobe-generated" &&
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
      repairNext = w.languages.every(l=>approvedMedia(payload.input.translations[l]) && payload.input.translations[l].images.length>=Math.max(2,w.strategy.required_images)) ? "supervisor" : "photo_editor";
    }
    if (task.stage === "supervisor") {
      for (const lang of w.languages)
        payload.input.translations[lang] = prepareForReview(
          payload.input.translations[lang],
          payload.research.briefs[lang],
          lang,
        );
      const decision = convertExhaustedResearch(
        await supervise(env, w, payload),
        payload,
        w,
      );
      payload.supervisor_rounds = decision.round;
      payload.supervision = [...(payload.supervision || []), decision];
      if (decision.action === "approve") {
        if(payload.final_repair_attempted)payload.final_repair_state="complete";
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
      } else if (planFinalCorrection(payload,decision)) {
        repairNext="editor";
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
          model:
            task.stage === "supervisor"
              ? reviewModel(env)
              : task.stage === "editor"
                ? payload.final_repair_attempted ? reviewModel(env) : editorModel(env)
                : ["researcher", "writer", "verifier"].includes(task.stage)
                  ? task.stage === "researcher" && env.AI_PROVIDER === "gemini"
                    ? "gemini-3.1-flash-lite"
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
    if(task.stage === "photo_editor" && planMediaRecovery(payload,e)){
      const notice="이미지 반려 이유를 반영해 문제 영역을 프레임에서 제외합니다. 승인된 이미지는 유지하고 새 후보를 한 차례 자동 검사합니다.";
      await env.WORKBOARD_DB.prepare("UPDATE agent_workflows SET status='pending',error=NULL,payload_json=?,lease_until=NULL,updated_at=? WHERE job_id=?").bind(JSON.stringify(payload),new Date().toISOString(),task.job_id).run();
      await env.WORKBOARD_DB.prepare("UPDATE agent_steps SET status='waiting',error=?,finished_at=? WHERE id=?").bind(notice,new Date().toISOString(),step).run();
      await saveProgress(env,task.job_id,payload,"agent_pending");
      return {worked:true,job_id:task.job_id,agent:task.stage,recovering:true};
    }
    if(task.stage === "photo_editor" && planMediaRepair(payload,e,await chargeSettled(env,task.site_id,payload.slug,await roleStarted(env,task.job_id,task.stage)))){
      const notice="상위 검토가 반려한 원본을 자동 편집합니다. 승인된 사진은 유지하고, 문제 부분만 고친 뒤 다시 픽셀 검토합니다.";
      await env.WORKBOARD_DB.prepare("UPDATE agent_workflows SET status='pending',error=NULL,payload_json=?,lease_until=NULL,updated_at=? WHERE job_id=?").bind(JSON.stringify(payload),new Date().toISOString(),task.job_id).run();
      await env.WORKBOARD_DB.prepare("UPDATE agent_steps SET status='waiting',error=?,finished_at=? WHERE id=?").bind(notice,new Date().toISOString(),step).run();
      await saveProgress(env,task.job_id,payload,"agent_pending");
      return {worked:true,job_id:task.job_id,agent:task.stage,recovering:true};
    }
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
          delay_seconds: (await nextWake(env)) ?? delay,
          job_id: task.job_id,
          agent: task.stage,
        };
      }
    }
    const kind = classifyFailure(e, task.stage);
    const attempt = planAutoRetry(
      payload,
      task.stage,
      kind,
      await chargeSettled(env, w.site_id, payload.slug, now),
    );
    if (attempt) {
      const notice = retryNotice(kind, attempt);
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='pending',payload_json=?,error=NULL,lease_until=NULL,updated_at=? WHERE job_id=?",
      )
        .bind(JSON.stringify(payload), new Date().toISOString(), task.job_id)
        .run();
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_steps SET status='waiting',error=?,finished_at=? WHERE id=?",
      )
        .bind(notice, new Date().toISOString(), step)
        .run();
      if (payload.input)
        await saveProgress(env, task.job_id, payload, stageStatus[task.stage] || "agent_pending");
      return {
        worked: true,
        job_id: task.job_id,
        agent: task.stage,
        recovering: true,
      };
    }
    if(task.stage === "photo_editor" && e instanceof ProviderWait)e=new HttpError(409,"MEDIA_REVIEW: 이미지 API의 일시 오류가 반복되어 연결 복구 또는 원본 등록을 기다립니다.");
    if(task.stage === "photo_editor" && e instanceof HttpError && !(e instanceof BudgetWait) && !e.message.includes("MEDIA_REVIEW"))e=new HttpError(e.status,"MEDIA_REVIEW: "+e.message+" 저장된 글을 유지하고 이미지 자료 또는 연결 복구를 기다립니다.");
    if (
      task.stage === "photo_editor" &&
      e instanceof HttpError &&
      e.message.includes("MEDIA_REVIEW")
    ) {
      recordMediaResourceWait(payload,e);
      const error =
        "이미지 확보 대기: " +
        e.message.replace("MEDIA_REVIEW: ", "") +
        " 원본을 등록하면 이 단계부터 자동 재개합니다.";
      await env.WORKBOARD_DB.prepare(
        "UPDATE agent_workflows SET status='media_wait',error=?,payload_json=?,lease_until=NULL,updated_at=? WHERE job_id=?",
      )
        .bind(
          error,
          JSON.stringify(payload),
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
        await saveProgress(env, task.job_id, payload, "media_wait");
      await env.WORKBOARD_DB.prepare(
        "UPDATE content_jobs SET status='media_wait',error=?,updated_at=? WHERE id=?",
      )
        .bind(error, new Date().toISOString(), task.job_id)
        .run();
      return {
        worked: true,
        job_id: task.job_id,
        agent: task.stage,
        media_wait: true,
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
    // The class travels with the checkpoint so recovery never re-parses the message.
    payload.last_failure = { stage: task.stage, kind, at: new Date().toISOString() };
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
