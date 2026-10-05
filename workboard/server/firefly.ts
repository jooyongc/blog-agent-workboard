import type { Env } from "./env";
import { HttpError } from "./http";
export class PendingMedia extends Error {}
export function fireflyReady(env: Env) {
  return !!(
    env.FIREFLY_SERVICES_CLIENT_ID && env.FIREFLY_SERVICES_CLIENT_SECRET
  );
}
async function auth(env: Env) {
  if (!fireflyReady(env))
    throw new HttpError(
      503,
      "Adobe Developer Firefly Services 연결이 필요합니다.",
    );
  const response = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: String(env.FIREFLY_SERVICES_CLIENT_ID),
      client_secret: String(env.FIREFLY_SERVICES_CLIENT_SECRET),
      scope: String(
        env.FIREFLY_SERVICES_SCOPE ||
          "openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis",
      ),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new HttpError(
      503,
      "Adobe Firefly 인증 또는 API 이용 권한을 확인하세요.",
    );
  const token = (await response.json()) as { access_token: string };
  return {
    Authorization: "Bearer " + token.access_token,
    "x-api-key": String(env.FIREFLY_SERVICES_CLIENT_ID),
    "Content-Type": "application/json",
  };
}
export async function creativeAsset(
  env: Env,
  id: string,
  siteId: string,
  kind: "image" | "video",
  prompt: string,
) {
  const row = await env.WORKBOARD_DB.prepare(
    "SELECT status,status_url,result_json FROM creative_requests WHERE id=?",
  )
    .bind(id)
    .first<{
      status: string;
      status_url: string | null;
      result_json: string | null;
    }>();
  if (row?.result_json)
    return JSON.parse(row.result_json) as {
      url: string;
      kind: string;
      generated: true;
    };
  if (row && ["failed", "submitting"].includes(row.status))
    throw new HttpError(
      409,
      "이전 Adobe 생성 결과를 확인해야 합니다. 중복 요청하지 않습니다.",
    );
  const headers = await auth(env);
  if (!row) {
    const now = new Date().toISOString();
    const claim = await env.WORKBOARD_DB.prepare(
      "INSERT OR IGNORE INTO creative_requests(id,site_id,kind,prompt,status,created_at,updated_at) VALUES(?,?,?,?,'submitting',?,?)",
    )
      .bind(id, siteId, kind, prompt, now, now)
      .run();
    if (!claim.meta.changes) throw new PendingMedia("생성 요청 진행 중");
    const endpoint =
      kind === "image"
        ? "https://firefly-api.adobe.io/v3/images/generate-async"
        : String(
            env.FIREFLY_VIDEO_ENDPOINT ||
              "https://firefly-api.adobe.io/v3/videos/generate",
          );
    if (new URL(endpoint).origin !== "https://firefly-api.adobe.io")
      throw new HttpError(400, "Adobe 공식 영상 API 주소를 사용하세요.");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...headers,
        ...(kind === "video" ? { "x-model-version": "video1_standard" } : {}),
      },
      body: JSON.stringify(
        kind === "image"
          ? { prompt, size: { width: 1344, height: 768 }, numVariations: 1 }
          : {
              prompt,
              sizes: [{ width: 1280, height: 720 }],
              bitRateFactor: 23,
            },
      ),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await env.WORKBOARD_DB.prepare(
        "UPDATE creative_requests SET status='failed',error=? WHERE id=?",
      )
        .bind("Adobe HTTP " + response.status, id)
        .run();
      throw new HttpError(502, "Adobe 생성 요청을 완료하지 못했습니다.");
    }
    const job = (await response.json()) as {
      statusUrl?: string;
      outputs?: unknown;
    };
    if (
      !job.statusUrl ||
      new URL(job.statusUrl).origin !== "https://firefly-api.adobe.io"
    )
      throw new HttpError(
        502,
        "Adobe 생성 작업 상태 주소를 확인하지 못했습니다.",
      );
    await env.WORKBOARD_DB.prepare(
      "UPDATE creative_requests SET status='running',status_url=?,updated_at=? WHERE id=?",
    )
      .bind(job.statusUrl, new Date().toISOString(), id)
      .run();
    throw new PendingMedia("Adobe 생성 중");
  }
  if (
    !row.status_url ||
    new URL(row.status_url).origin !== "https://firefly-api.adobe.io"
  )
    throw new HttpError(409, "생성 상태를 확인하세요.");
  const response = await fetch(row.status_url, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new HttpError(502, "Adobe 생성 상태 조회 실패");
  const result = (await response.json()) as {
    status: string;
    result?: { outputs?: any[] };
    outputs?: any[];
  };
  if (["failed", "canceled", "cancelled"].includes(result.status)) {
    await env.WORKBOARD_DB.prepare(
      "UPDATE creative_requests SET status='failed' WHERE id=?",
    )
      .bind(id)
      .run();
    throw new HttpError(409, "Adobe 생성이 실패했습니다.");
  }
  const outputs = result.outputs || result.result?.outputs;
  const source = outputs?.[0]?.[kind]?.url || outputs?.[0]?.url;
  if (!source) throw new PendingMedia("Adobe 생성 중");
  const url = await storeGenerated(env, id, kind, source);
  const asset = { url, kind, generated: true };
  await env.WORKBOARD_DB.prepare(
    "UPDATE creative_requests SET status='complete',result_json=?,updated_at=? WHERE id=?",
  )
    .bind(JSON.stringify(asset), new Date().toISOString(), id)
    .run();
  return asset;
}
async function storeGenerated(env: Env, id: string, kind: string, url: string) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !["amazonaws.com", "windows.net", "adobe.io", "adobe.com"].some(
      (d) => u.hostname === d || u.hostname.endsWith("." + d),
    )
  )
    throw new HttpError(400, "Adobe 생성 결과 주소를 확인하세요.");
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw new HttpError(502, "생성 원본을 확보하지 못했습니다.");
  const data = await response.arrayBuffer();
  if (data.byteLength > 50 * 1024 * 1024)
    throw new HttpError(413, "생성 미디어 저장 크기 초과");
  const mime =
    response.headers.get("Content-Type")?.split(";")[0] ||
    (kind === "image" ? "image/png" : "video/mp4");
  const extension =
    kind === "image" ? (mime === "image/jpeg" ? "jpg" : "png") : "mp4";
  const path = "firefly/" + id.replace(/[^a-z0-9-]/gi, "-") + "." + extension;
  const base = String(env.NATIVE_BLOG_SUPABASE_URL) + "/storage/v1";
  const uploaded = await fetch(base + "/object/workboard-media/" + path, {
    method: "POST",
    headers: {
      apikey: String(env.NATIVE_BLOG_SUPABASE_KEY),
      Authorization: "Bearer " + String(env.NATIVE_BLOG_SUPABASE_KEY),
      "Content-Type": mime,
      "x-upsert": "true",
    },
    body: data,
    signal: AbortSignal.timeout(60000),
  });
  if (!uploaded.ok) throw new HttpError(502, "생성 결과 보관 실패");
  return base + "/object/public/workboard-media/" + path;
}
