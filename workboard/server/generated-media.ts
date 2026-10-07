import type { Env } from "./env";
import type { StockPhoto } from "./media";
import { HttpError } from "./http";
import {
  BudgetWait,
  ProviderWait,
  budgetReset,
  modelJson,
  reviewModel,
} from "./model";
import { budgetSettings } from "./budget";
import { PendingMedia } from "./firefly";
const IMAGE_MODEL = "gemini-3.1-flash-image";
export const VISUAL_POLICY="korea-topic-no-text-v2";
export function generatedImagesReady(env: Env) {
  return (
    env.GEMINI_IMAGES_ENABLED === "true" &&
    env.AI_ENABLED === "true" &&
    !!env.GEMINI_API_KEY &&
    !!env.NATIVE_BLOG_SUPABASE_URL &&
    !!env.NATIVE_BLOG_SUPABASE_KEY
  );
}
export function imageCost(usage: any, hasImage: boolean) {
  const details = usage.candidatesTokensDetails || [];
  const imageTokens = details
    .filter((p: any) => p.modality === "IMAGE")
    .reduce((n: number, p: any) => n + Number(p.tokenCount || 0), 0);
  const otherTokens = details
    .filter((p: any) => p.modality !== "IMAGE")
    .reduce((n: number, p: any) => n + Number(p.tokenCount || 0), 0);
  return (
    (Number(usage.promptTokenCount || 0) * 0.5) / 1e6 +
    (Number(usage.thoughtsTokenCount || 0) * 3) / 1e6 +
    (imageTokens ? (imageTokens * 60) / 1e6 : hasImage ? 0.067 : 0) +
    ((otherTokens ||
      (!hasImage ? Number(usage.candidatesTokenCount || 0) : 0)) *
      3) /
      1e6
  );
}
async function reserve(env: Env, key: string, prompt: string) {
  const id = crypto.randomUUID(),
    now = Date.now();
  try {
    await env.WORKBOARD_DB.prepare(
      "INSERT INTO ai_runs(id,article_key,month,week,reserved,status,created_at,model) VALUES(?,?,?,?,?,'running',?,?)",
    )
      .bind(
        id,
        key,
        new Date(now + 9 * 3600000).toISOString().slice(0, 7),
        String(Math.floor((now + 9 * 3600000 - 4 * 86400000) / (7 * 86400000))),
        0.25 + (new TextEncoder().encode(prompt).length * 0.5) / 1e6,
        new Date(now).toISOString(),
        IMAGE_MODEL,
      )
      .run();
  } catch (e) {
    const detail = String(e);
    if (detail.includes("budget")) {
      const settings = await budgetSettings(env, key.split("/")[0]);
      const scope = detail.includes("monthly_budget")
        ? "monthly"
        : detail.includes("weekly_budget")
          ? "weekly"
          : "article";
      throw new BudgetWait(
        scope,
        budgetReset(scope, now),
        `이미지 생성이 ${scope === "article" ? "글당" : scope === "weekly" ? "주간" : "월간"} AI 예산 $${settings[scope].toFixed(2)} 한도에 도달했습니다.`,
        settings.revision,
      );
    }
    throw new HttpError(503, "이미지 생성 예산 예약 실패");
  }
  return id;
}
async function settle(
  env: Env,
  id: string,
  actual: number | null,
  status: string,
) {
  await env.WORKBOARD_DB.prepare(
    "UPDATE ai_runs SET actual=?,reserved=CASE WHEN ? IS NULL THEN reserved ELSE ? END,status=? WHERE id=?",
  )
    .bind(actual, actual, actual, status, id)
    .run();
}
function bytes(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
function encode(data: ArrayBuffer) {
  const u = new Uint8Array(data);
  let value = "";
  for (let i = 0; i < u.length; i += 8192)
    value += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(value);
}
async function imageHash(data: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function assertReviewedPhotos(env: Env, photos: StockPhoto[]) {
  for (const photo of [...new Map(photos.map((p) => [p.url, p])).values()]) {
    ownedUrl(env, photo.url);
    const record = await env.WORKBOARD_DB.prepare(
      "SELECT status FROM ai_runs WHERE id=? AND status='complete' AND model='gemini-3.1-pro-preview'",
    )
      .bind(photo.visual_review?.run_id || "")
      .first();
    if (!record || !photo.visual_review?.approved)
      throw new HttpError(
        409,
        "MEDIA_REVIEW: 실제 이미지 검토 기록이 필요합니다.",
      );
    const response = await fetch(photo.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new HttpError(
        409,
        "MEDIA_REVIEW: 발행할 이미지 원본을 읽을 수 없습니다.",
      );
    const bytes = await response.arrayBuffer();
    if (
      bytes.byteLength > 12 * 1024 * 1024 ||
      (await imageHash(bytes)) !== photo.visual_review.sha256
    )
      throw new HttpError(
        409,
        "MEDIA_REVIEW: 검토 후 이미지가 변경됐습니다. 재검토가 필요합니다.",
      );
  }
}
function ownedUrl(env: Env, url: string) {
  const u = new URL(url),
    base = new URL(String(env.NATIVE_BLOG_SUPABASE_URL));
  const localStock =
    u.origin ===
      new URL(
        String(
          env.PUBLIC_WORKBOARD_URL || "https://blog-agent-workboard.pages.dev",
        ),
      ).origin && /^\/stock\/[0-9]+\.(jpg|png)$/.test(u.pathname);
  if (
    u.protocol !== "https:" ||
    !(
      localStock ||
      (u.origin === base.origin &&
        u.pathname.startsWith("/storage/v1/object/public/workboard-media/"))
    )
  )
    throw new HttpError(
      409,
      "MEDIA_REVIEW: 자체 보관된 원본만 이미지 검토에 사용할 수 있습니다.",
    );
  return u;
}
export async function reviewPhoto(
  env: Env,
  site: string,
  slug: string,
  topic: string,
  photo: StockPhoto,
): Promise<StockPhoto> {
  if (photo.visual_review?.approved && photo.visual_review.policy === VISUAL_POLICY) return photo;
  const id = `${site}-${slug}-visual-v2-${photo.id}`.replace(/[^a-z0-9-]/gi, "-");
  const prior = await env.WORKBOARD_DB.prepare(
    "SELECT result_json FROM creative_requests WHERE id=?",
  )
    .bind(id)
    .first<{ result_json: string | null }>();
  if (prior?.result_json)
    return { ...photo, visual_review: JSON.parse(prior.result_json) };
  ownedUrl(env, photo.url);
  const response = await fetch(photo.url, {
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new HttpError(502, "이미지 검토 원본을 읽지 못했습니다.");
  const mimeType = response.headers.get("Content-Type")?.split(";")[0] || "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType))
    throw new HttpError(409, "MEDIA_REVIEW: 검토할 이미지 형식을 확인하세요.");
  const data = await response.arrayBuffer();
  if (data.byteLength > 12 * 1024 * 1024)
    throw new HttpError(413, "검토 이미지가 너무 큽니다.");
  const model = "gemini-3.1-pro-preview" as const;
  const audit = await modelJson(
    env,
    `${site}/${slug}`,
    'You are the senior visual quality reviewer for a South Korea editorial blog. Inspect the actual attached image. Reject Japanese or other-country markers, irrelevant generic stock, misleading documentary claims, distorted hands/faces/objects, unreadable fake text, watermarks, logos, and cultural inaccuracies. Require clear topic relevance and plausible South Korean context. Generated images are explicitly labeled conceptual illustrations, not photographs proving facts or actual locations. For generated images (Gemini or Adobe Firefly), reject ANY visible letters, words or numbers anywhere, including menu panels, signs and icons, even if apparently readable or correct. Blank menus/screens and purely pictorial symbols are acceptable. For Adobe Stock, genuine photographed text can remain. Do not require photorealism, named locations or text. Return JSON {approved:boolean,reason:"short Korean explanation"}. Approve only if the image can credibly illustrate the supplied topic.',
    {
      topic,
      alt: photo.alt,
      provider: photo.provider,
      kind:
        photo.provider === "Gemini" || photo.provider === "Adobe Firefly"
          ? "labeled conceptual illustration"
          : "licensed stock",
    },
    1500,
    undefined,
    model,
    [{ mimeType, data: encode(data) }],
  );
  if (
    typeof audit.data.approved !== "boolean" ||
    typeof audit.data.reason !== "string"
  )
    throw new HttpError(502, "이미지 적합성 검토 형식 오류");
  const sha256 = await imageHash(data);
  const review = {
    approved: audit.data.approved,
    reason: audit.data.reason,
    model,
    run_id: audit.run_id,
    sha256,
    policy:VISUAL_POLICY,
  };
  await env.WORKBOARD_DB.prepare(
    "INSERT OR IGNORE INTO creative_requests(id,site_id,kind,prompt,status,result_json,created_at,updated_at) VALUES(?,?,'visual_review',?,'complete',?,?,?)",
  )
    .bind(
      id,
      site,
      topic,
      JSON.stringify(review),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  return { ...photo, visual_review: review };
}
async function createImage(
  env: Env,
  site: string,
  slug: string,
  topic: string,
  slot: number,
  variant: number,
): Promise<StockPhoto> {
  const id = `${site}-${slug}-gemini-image-${slot}-${variant}`;
  const cached = await env.WORKBOARD_DB.prepare(
    "SELECT status,result_json FROM creative_requests WHERE id=?",
  )
    .bind(id)
    .first<{ status: string; result_json: string | null }>();
  if (cached?.result_json) return JSON.parse(cached.result_json);
  if (cached && !["retryable"].includes(cached.status))
    throw new HttpError(
      409,
      "MEDIA_REVIEW: 이전 이미지 요청 결과가 불명확하거나 거절되었습니다. 중복 생성하지 않습니다.",
    );
  const focus = /bow|greeting|respect/i.test(topic)
    ? (slot%2===0 ? "Show TWO adults exchanging a clear forward bow from the waist, arms relaxed at their sides, no touching, hugging or handshake, outside a Korean hanok courtyard. The bow itself must be unmistakable." : "Show a clear side view of a person giving a respectful forward bow, arms at sides, in a plain South Korean setting. No touching or handshake.")
    : /kiosk|self.service/i.test(topic) ? "Show ordering at a Korean restaurant kiosk. The screen must be blank with only abstract pictorial shapes, absolutely no letters or numbers. Include Korean banchan and metal utensils for context."
    : /food|restaurant|dietary|spicy/i.test(topic) ? (slot%2===0 ? "Show a Korean restaurant customer communicating with a server, with a completely blank menu, Korean banchan and metal utensils. All signs and menus must be blank." : "Show a close-up Korean meal with banchan, metal spoon and chopsticks, fresh vegetables and chili peppers. No menus, labels, signs or text.")
    : "Illustrate the practical topic in a recognizable South Korean setting, with no writing.";
  const prompt = `Create one high-quality editorial illustration for this article: ${topic}. South Korea only. ${focus} ${slot % 2 === 0 ? "Wide scene showing the practical situation" : "Close-up detail illustrating a different aspect of this topic"}. ${variant ? "Use a simpler composition without faces or hands." : ""} Warm natural colors, clean realistic editorial illustration, 16:9. Korean context: if dining, use Korean banchan, metal spoon and chopsticks and Korean dishes; if transit, a contemporary Seoul transit setting without claiming a real station; if greetings, a culturally appropriate Korean gesture. No Japanese landmarks, tatami, torii, sushi, kimono or non-Korean cultural markers. ABSOLUTELY NO TEXT OR TYPOGRAPHY anywhere: no letters of any language, no Hangul, no English words, no numbers, no labels, menu writing, sign writing, speech bubbles or charts. Leave menus, screens and signs blank. Show only pictorial food and context. No logos, brands, prices or maps. No invented documentary evidence or named real locations. This is a labeled conceptual illustration, not a stock photo. Do not fetch or copy stock images.`;
  const run = await reserve(env, `${site}/${slug}`, prompt);
  const now = new Date().toISOString();
  const claim = cached
    ? await env.WORKBOARD_DB.prepare(
        "UPDATE creative_requests SET status='submitting',error=NULL,updated_at=? WHERE id=? AND status='retryable'",
      )
        .bind(now, id)
        .run()
    : await env.WORKBOARD_DB.prepare(
        "INSERT OR IGNORE INTO creative_requests(id,site_id,kind,prompt,status,created_at,updated_at) VALUES(?,?,'image',?,'submitting',?,?)",
      )
        .bind(id, site, prompt, now, now)
        .run();
  if (!claim.meta.changes) {
    await settle(env, run, 0, "failed");
    throw new PendingMedia("다른 이미지 생성 요청 진행 중");
  }
  let actual: number | null = null,
    received = false;
  try {
    const formats = [
      {imageConfig:{aspectRatio:"16:9",imageSize:"1K"}},
      {responseFormat:{image:{aspectRatio:"ASPECT_RATIO_SIXTEEN_BY_NINE",imageSize:"IMAGE_SIZE_ONE_K"}}},
      {},
    ];
    let r:Response | undefined;
    for(let attempt=0; attempt<formats.length; attempt++) {
      r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`,{
        method:"POST",redirect:"manual",headers:{"x-goog-api-key":String(env.GEMINI_API_KEY),"Content-Type":"application/json"},
        body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{responseModalities:["TEXT","IMAGE"],maxOutputTokens:4096,...formats[attempt]}}),signal:AbortSignal.timeout(180000),
      });
      if(r.status!==400 || attempt===formats.length-1) break;
      const rejection:any=await r.json().catch(()=>null);
      if(!/invalid (argument|value)|unknown name/i.test(rejection?.error?.message || "")) {
        r=Response.json(rejection,{status:400});break;
      }
      // Confirmed invalid-request responses generate no asset and are unbilled.
      // Try only wire-format compatibility; never repeat an unknown outcome.
    }
    if(!r) throw new HttpError(502,"이미지 요청을 실행하지 못했습니다.");
    if (!r.ok) {
      actual = 0;
      await settle(env, run, 0, "failed");
      const hint = (
        (await r.json().catch(() => null)) as {
          error?: { message?: string };
        } | null
      )?.error?.message;
      const detail =
        typeof hint === "string"
          ? hint
              .replaceAll(String(env.GEMINI_API_KEY), "[credential]")
              .slice(0, 190)
          : "";
      const retryable = [429, 500, 502, 503, 504].includes(r.status);
      await env.WORKBOARD_DB.prepare(
        "UPDATE creative_requests SET status=?,error=? WHERE id=?",
      )
        .bind(
          retryable ? "retryable" : "failed",
          `Gemini HTTP ${r.status}: ${detail}`,
          id,
        )
        .run();
      if (retryable) throw new ProviderWait(r.status, 60);
      throw new HttpError(
        409,
        `MEDIA_REVIEW: Gemini 이미지 생성이 거절됐습니다 (HTTP ${r.status}). API 이미지 생성 이용 권한을 확인하세요.`,
      );
    }
    const raw: any = await r.json();
    received = true;
    const parts = raw.candidates?.[0]?.content?.parts || [];
    const image = parts.find(
      (p: any) =>
        !p.thought &&
        p.inlineData?.data &&
        ["image/png", "image/jpeg"].includes(p.inlineData.mimeType),
    )?.inlineData;
    actual = imageCost(raw.usageMetadata || {}, !!image);
    await settle(env, run, actual, "complete");
    if (!image) {
      await env.WORKBOARD_DB.prepare(
        "UPDATE creative_requests SET status='failed',error='No image returned' WHERE id=?",
      )
        .bind(id)
        .run();
      throw new HttpError(
        409,
        "MEDIA_REVIEW: Gemini가 이미지를 반환하지 않았습니다.",
      );
    }
    const data = bytes(image.data);
    if (data.byteLength > 12 * 1024 * 1024)
      throw new HttpError(413, "생성 이미지 저장 크기 초과");
    const path = `gemini/${id.replace(/[^a-z0-9-]/gi, "-")}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`;
    const base = String(env.NATIVE_BLOG_SUPABASE_URL) + "/storage/v1";
    const stored = await fetch(base + "/object/workboard-media/" + path, {
      method: "POST",
      headers: {
        apikey: String(env.NATIVE_BLOG_SUPABASE_KEY),
        Authorization: "Bearer " + String(env.NATIVE_BLOG_SUPABASE_KEY),
        "Content-Type": image.mimeType,
        "x-upsert": "true",
      },
      body: data,
      signal: AbortSignal.timeout(60000),
    });
    if (!stored.ok)
      throw new HttpError(
        502,
        "생성 이미지 저장 실패: 이미지는 재생성하지 않고 결과 확인이 필요합니다.",
      );
    const photo: StockPhoto = {
      id,
      provider: "Gemini",
      url: base + "/object/public/workboard-media/" + path,
      page: "https://ai.google.dev/gemini-api/docs/image-generation",
      photographer: "Gemini AI",
      photographer_url:
        "https://ai.google.dev/gemini-api/docs/image-generation",
      alt: `South Korean conceptual illustration: ${topic} (${slot + 1})`,
      license_url: "https://ai.google.dev/gemini-api/terms",
    };
    await env.WORKBOARD_DB.prepare(
      "UPDATE creative_requests SET status='complete',result_json=?,updated_at=? WHERE id=?",
    )
      .bind(JSON.stringify(photo), new Date().toISOString(), id)
      .run();
    return photo;
  } catch (e) {
    if (actual === null) await settle(env, run, received ? 0 : null, "failed");
    if (!(e instanceof ProviderWait))
      await env.WORKBOARD_DB.prepare(
        "UPDATE creative_requests SET error=? WHERE id=? AND status='submitting'",
      )
        .bind(
          "Result confirmation required; no automatic duplicate generation",
          id,
        )
        .run();
    throw e;
  }
}
export async function generatedPhoto(env:Env,site:string,slug:string,topic:string,slot:number):Promise<StockPhoto & {fresh:boolean}> {
  if(!generatedImagesReady(env)) throw new HttpError(409,"MEDIA_REVIEW: 자동 이미지 생성 연결이 필요합니다.");
  for(let variant=0;variant<2;variant++) {
    const id=`${site}-${slug}-gemini-image-${slot}-${variant}`;
    const previous=await env.WORKBOARD_DB.prepare("SELECT result_json FROM creative_requests WHERE id=?").bind(id).first<{result_json:string|null}>();
    const hadReview=!!(previous?.result_json && JSON.parse(previous.result_json).visual_review?.policy === VISUAL_POLICY);
    const photo=await createImage(env,site,slug,topic,slot,variant);
    const checked=await reviewPhoto(env,site,slug,topic,photo);
    await env.WORKBOARD_DB.prepare("UPDATE creative_requests SET result_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(checked),new Date().toISOString(),checked.id).run();
    if(checked.visual_review?.approved) return {...checked,fresh:!hadReview};
    if(!hadReview && variant===0) throw new PendingMedia("이미지 후보가 반려됐습니다. 저장된 검토 결과를 유지하고 다음 후보를 준비합니다.");
  }
  throw new HttpError(409,"MEDIA_REVIEW: 이미지 적합성 검토를 통과하지 못했습니다. 최대 2개 후보를 검사했으며 원본 등록이 필요합니다.");
}
