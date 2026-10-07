import type { Env } from "./env";
export async function importLicensedMedia(env: Env) {
  const job = await env.WORKBOARD_DB.prepare(
    "SELECT * FROM media_imports WHERE status='ready' ORDER BY created_at LIMIT 1",
  ).first<{
    id: string;
    site_id: string;
    asset_id: string;
    title: string;
    tags_json: string;
    download_url: string;
    license_reference: string;
    license_state: string;
    pricing: string;
  }>();
  if (!job) return false;
  const claim = await env.WORKBOARD_DB.prepare(
    "UPDATE media_imports SET status='running',updated_at=? WHERE id=? AND status='ready'",
  )
    .bind(new Date().toISOString(), job.id)
    .run();
  if (!claim.meta.changes) return true;
  try {
    const source = new URL(job.download_url);
    if (
      job.pricing !== "free" ||
      !["purchased", "just_purchased"].includes(job.license_state) ||
      !/^[0-9]+$/.test(job.asset_id) ||
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      !/^stock-apex-images-prod-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(
        source.hostname,
      )
    )
      throw Error("확보한 무료 Adobe 라이선스와 다운로드 주소를 확인하세요.");
    const r = await fetch(source, {
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw Error("Adobe 원본 다운로드 실패 또는 주소 만료");
    const mime = r.headers.get("Content-Type")?.split(";")[0] || "";
    if (!["image/jpeg", "image/png"].includes(mime))
      throw Error("Adobe 원본 이미지 형식 오류");
    if (Number(r.headers.get("Content-Length")) > 12 * 1024 * 1024)
      throw Error("검토용 원본은 12MB 이하로 준비하세요.");
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > 12 * 1024 * 1024)
      throw Error("검토용 원본은 12MB 이하로 준비하세요.");
    const base = new URL(String(env.NATIVE_BLOG_SUPABASE_URL));
    if (base.protocol !== "https:") throw Error("보관 사이트 연결 오류");
    const path = `adobe-stock/${job.asset_id}.${mime === "image/jpeg" ? "jpg" : "png"}`;
    const uploaded = await fetch(
      base.origin + "/storage/v1/object/workboard-media/" + path,
      {
        method: "POST",
        headers: {
          apikey: String(env.NATIVE_BLOG_SUPABASE_KEY),
          Authorization: "Bearer " + String(env.NATIVE_BLOG_SUPABASE_KEY),
          "Content-Type": mime,
          "x-upsert": "true",
        },
        body: bytes,
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!uploaded.ok) throw Error("Adobe 원본 보관 실패");
    await env.WORKBOARD_DB.prepare(
      "INSERT OR IGNORE INTO reusable_media(id,site_id,provider,kind,title,tags_json,url,source_url,license_reference,created_at) VALUES(?,?,'Adobe Stock','photo',?,?,?,?,?,?)",
    )
      .bind(
        job.id,
        job.site_id,
        job.title,
        job.tags_json,
        base.origin + "/storage/v1/object/public/workboard-media/" + path,
        "https://stock.adobe.com/images/" + job.asset_id,
        job.license_reference,
        new Date().toISOString(),
      )
      .run();
    await env.WORKBOARD_DB.prepare(
      "UPDATE media_imports SET status='complete',download_url='',error=NULL,updated_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), job.id)
      .run();
    await env.WORKBOARD_DB.prepare(
      "UPDATE agent_workflows SET status='pending',error=NULL,payload_json=json_remove(payload_json,'$.recovery'),updated_at=? WHERE site_id=? AND stage='photo_editor' AND (status IN ('media_wait','failed') OR (status='budget_wait' AND instr(error,'이미지 생성')=1)) AND EXISTS(SELECT 1 FROM content_jobs c WHERE c.id=agent_workflows.job_id AND c.status NOT IN ('cancelled','published','drafted'))",
    )
      .bind(new Date().toISOString(), job.site_id)
      .run();
  } catch (e) {
    await env.WORKBOARD_DB.prepare(
      "UPDATE media_imports SET status='failed',error=?,updated_at=? WHERE id=?",
    )
      .bind(
        e instanceof Error ? e.message : "원본 등록 실패",
        new Date().toISOString(),
        job.id,
      )
      .run();
  }
  return true;
}
