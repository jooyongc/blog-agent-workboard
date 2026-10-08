import type {Env} from "./env";
import {MODEL_RATES, workerModel, reviewModel, type ModelId} from "./model";
import {HttpError} from "./http";
export async function applyModelSettings(env:Env):Promise<Env>{
 const row=await env.WORKBOARD_DB.prepare("SELECT worker,supervisor FROM ai_model_settings WHERE id=1").first<{worker:ModelId;supervisor:ModelId}>();
 return row?{...env,AI_WORKER_MODEL:row.worker,AI_REVIEW_MODEL:row.supervisor,AI_PROVIDER:row.worker.startsWith("gemini-")?"gemini":"anthropic"}:env;
}
export async function modelCatalog(env:Env){
 const statuses:Record<string,{ready:boolean;error?:string;ids:string[]}>= {};
 await Promise.all(["gemini","anthropic"].map(async provider=>{
  const key=provider==="gemini"?env.GEMINI_API_KEY:env.ANTHROPIC_API_KEY;
  if(!key){statuses[provider]={ready:false,error:"Cloudflare API 키 설정 필요",ids:[]};return;}
  try{
   const r=await fetch(provider==="gemini"?"https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000":"https://api.anthropic.com/v1/models?limit=1000",{headers:provider==="gemini"?{"x-goog-api-key":key}:{"x-api-key":key,"anthropic-version":"2023-06-01"},signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw new Error(`API HTTP ${r.status}`);
   const d:any=await r.json();statuses[provider]={ready:true,ids:provider==="gemini"?(d.models||[]).filter((m:any)=>m.supportedGenerationMethods?.includes("generateContent")).map((m:any)=>m.name.replace("models/","")):(d.data||[]).map((m:any)=>m.id)};
  }catch(e){statuses[provider]={ready:false,error:String(e),ids:[]};}
 }));
 const choices=Object.keys(MODEL_RATES).map(id=>{const provider=id.startsWith("gemini-")?"gemini":"anthropic";return {id,provider,available:statuses[provider].ids.some(x=>x===id||x.startsWith(id+"-")),senior:/pro|sonnet|opus/.test(id),rates:MODEL_RATES[id as ModelId]};});
 return {choices,providers:statuses,selected:{worker:workerModel(env),supervisor:reviewModel(env)},scope:"all_workspaces",image_model:"gemini-3.1-flash-image"};
}
export async function saveModels(env:Env,input:any){
 if(!input||![input.worker,input.supervisor].every(id=>typeof id==="string"&&Object.hasOwn(MODEL_RATES,id)))throw new HttpError(400,"지원되는 모델을 선택하세요.");
 if(!/pro|sonnet|opus/.test(input.supervisor))throw new HttpError(400,"상위 검토에는 Pro·Sonnet·Opus를 선택하세요.");
 const catalog=await modelCatalog(env);
 for(const id of [input.worker,input.supervisor])if(!catalog.choices.some(c=>c.id===id&&c.available))throw new HttpError(409,"이 계정에서 사용 가능한 모델인지 확인하지 못했습니다. API 연결을 확인하세요.");
 await env.WORKBOARD_DB.prepare("INSERT INTO ai_model_settings(id,worker,supervisor,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET worker=excluded.worker,supervisor=excluded.supervisor,updated_at=excluded.updated_at").bind(input.worker,input.supervisor,new Date().toISOString()).run();
 return {worker:input.worker,supervisor:input.supervisor};
}
