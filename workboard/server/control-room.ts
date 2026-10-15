import type {Env} from "./env";
export function recoveryAction(task:{status:string;stage:string;scope?:string|null;repair?:string|null}){
 if(task.status==="budget_wait")return task.scope==="article"?"글당 한도 변경 필요 · 저장된 결과 유지":"예산 기간 갱신 후 자동 재개";
 if(task.status==="retry_wait")return "API 제한 해제 시 자동 재개 · 다른 채널 계속 처리";
 if(task.status==="media_wait")return "이미지 대안 소진 · 라이선스 원본 필요";
 if(task.status==="interrupted"||task.status==="needs_reconcile")return "요청 결과·비용 확인 필요 · 중복 실행 방지";
 if(task.status==="failed")return "자동 복구 소진 · 원인 확인 필요";
 if(task.repair==="assigned")return "반려 원본 자동 편집 → 픽셀 재검토";
 if(task.stage==="editor")return "문제 문구 보완 → 상위 검토";
 return task.status==="running"?"에이전트 실행 중":"다음 체크포인트 자동 실행";
}
export async function controlRoom(env:Env){
 const rows=await env.WORKBOARD_DB.prepare("SELECT f.job_id,f.site_id,f.stage,f.status,f.updated_at,f.error,c.title,json_extract(f.payload_json,'$.recovery.scope') scope,json_extract(f.payload_json,'$.media_repair.state') repair FROM agent_workflows f JOIN content_jobs c ON c.id=f.job_id WHERE f.status<>'complete' AND c.status NOT IN ('cancelled','published','drafted') AND f.site_id NOT IN (SELECT site_id FROM workspace_records WHERE json_extract(config_json,'$.schedule.owner')='aside') ORDER BY f.updated_at LIMIT 100").all<any>();
 return rows.results.map(row=>({...row,next_action:recoveryAction(row)}));
}
/** A delayed provider must not hold the only queue chain while other channels are ready. */
export async function nextWake(env:Env,now=Date.now()){
 const pending=await env.WORKBOARD_DB.prepare("SELECT job_id FROM agent_workflows WHERE status='pending' AND site_id NOT IN (SELECT site_id FROM workspace_records WHERE json_extract(config_json,'$.schedule.owner')='aside') LIMIT 1").first();
 if(pending)return 1;
 const next=await env.WORKBOARD_DB.prepare("SELECT MIN(json_extract(payload_json,'$.provider_retry_at')) due FROM agent_workflows WHERE status='retry_wait' AND site_id NOT IN (SELECT site_id FROM workspace_records WHERE json_extract(config_json,'$.schedule.owner')='aside')").first<{due:string|null}>();
 const due=next?.due ? Date.parse(next.due) : NaN;
 return Number.isFinite(due)?Math.max(1,Math.min(900,Math.ceil((due-now)/1000))):null;
}
