import {mediaBrief,mediaSearchQuery} from "./media-brief";
import {normalizeMarkdownSpacing} from "../shared/markdown-spacing";
import type { Env } from "./env";
import type { Workspace, Article } from "../shared/types";
import {
  VISUAL_POLICY,
  generatedImagesReady,
  generatedPhoto,
  approvedGeneratedPhoto,
  reviewPhoto,
} from "./generated-media";
import { slotPlan } from "./art-direction";
import { COMMONS_REVIEWS_PER_SLOT, commonsCandidates, storeCommonsPhoto } from "./commons";
import { ImageCandidatesRejected } from "./media-recovery";
import { DEFAULT_MEDIA_SETTINGS } from "../shared/media-policy";
import type { MediaBrief } from "./media-brief";
import { creativeAsset, fireflyReady, PendingMedia } from "./firefly";
import { HttpError } from "./http";
import library from "../shared/licensed-media.json";
export type StockPhoto = {
  id: string;
  provider: "Pexels" | "Unsplash" | "Adobe Stock" | "Adobe Firefly" | "Gemini" | "Wikimedia Commons";
  url: string;
  page: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  license_url: string;
  /** License name shown in the credit, e.g. "CC BY-SA 4.0". */
  license?: string;
  visual_review?: {
    approved: boolean;
    reason: string;
    model: string;
    run_id: string;
    sha256: string;
    policy?: string;
    brief_key?: string;
    slot?: number;
  };
};
export function koreanMedia(description: string) {
  return (
    /korea|korean|seoul|busan|jeju|incheon|한국|서울|부산|제주/i.test(
      description,
    ) && !/japan|tokyo|kyoto|osaka|日本|東京|京都|일본|도쿄/i.test(description)
  );
}
export function approvedMedia(article: Article) {
  const images = article.images || [];
  const inline = [
    ...article.content_md.matchAll(/!\[[^\]]*\]\((https:\/\/[^)]+)\)/g),
  ].map((m) => m[1]);
  return (
    images.length >= 2 &&
    inline.length >= 2 &&
    images.every(
      (p) =>
        ["Adobe Stock", "Adobe Firefly", "Gemini", "Wikimedia Commons"].includes(p.provider) &&
        koreanMedia(p.alt) &&
        !!p.license_url &&
        p.visual_review?.approved === true && p.visual_review.policy === VISUAL_POLICY &&
        (!article.image_brief_key || p.visual_review.brief_key === article.image_brief_key) &&
        /^[a-f0-9]{64}$/.test(p.visual_review.sha256) &&
        article.content_md.includes(p.url),
    ) &&
    inline.every((url) => images.some((p) => p.url === url))
  );
}
const folded=(text:string)=>text.normalize("NFD").replace(/\p{M}/gu,"").toLowerCase();
/** A place name alone matches every article on these sites; a library photo needs a subject tag. */
const PLACE_ONLY_TAGS=new Set(["seoul","korea","south korea","korean"]);
/** Whole-word tag match (plurals allowed), so "bus" does not match "business" nor "food" "seafood". */
export function tagMatches(search:string,tag:string){
  const t=folded(tag).trim();
  if(!t || PLACE_ONLY_TAGS.has(t))return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?:e?s)?(?![\\p{L}\\p{N}])`,"u").test(search);
}
export async function stockPhotos(
  env: Env,
  query: string,
  count = 2,
  siteId?: string,
): Promise<StockPhoto[]> {
  const search=folded(query);
  const uploaded = siteId
    ? (
        await env.WORKBOARD_DB.prepare(
          "SELECT * FROM reusable_media WHERE kind='photo' AND (site_id=? OR (provider='Adobe Stock' AND length(license_reference)>0)) ORDER BY created_at DESC LIMIT 200",
        )
          .bind(siteId)
          .all<{
            id: string;
            provider: StockPhoto["provider"];
            title: string;
            tags_json: string;
            url: string;
            source_url: string;
          }>()
      ).results
        .filter(
          (x) =>
            ["Adobe Stock", "Adobe Firefly", "Gemini"].includes(x.provider) &&
            koreanMedia(x.title + " " + x.tags_json),
        )
        .filter((x) =>
          JSON.parse(x.tags_json).some((tag: string) =>
            tagMatches(search,tag),
          ),
        )
        .map((x) => ({
          id: x.id,
          provider: x.provider,
          url: x.url,
          page: x.source_url,
          photographer: x.provider,
          photographer_url: x.source_url,
          alt: x.title,
          license_url: x.source_url,
        }))
    : [];
  const adobe = library
    .filter(
      (x) =>
        x.type === "photo" &&
        ["purchased", "just_purchased"].includes(x.license_state) &&
        koreanMedia(x.alt) &&
        x.tags.some((tag) => tagMatches(search,tag)),
    )
    .map((x) => ({
      id: x.id,
      provider: "Adobe Stock" as const,
      url: x.url,
      page: x.page,
      photographer: "Adobe Stock contributor",
      photographer_url: x.page,
      alt: x.alt,
      license_url: "https://stock.adobe.com/license-terms",
    }));
  if (count === 0) return [...uploaded, ...adobe];
  if (uploaded.length + adobe.length >= count)
    return [...uploaded, ...adobe].slice(0, count);
  throw new HttpError(
    409,
    "MEDIA_REVIEW: 한국 배경·주제에 맞는 Adobe Stock 또는 직접 생성 이미지를 확보해야 합니다. 공개 사진 API로 대체하지 않습니다.",
  );
}
export function licensedVideos(query: string) {
  const search=folded(query);
  return library.filter(
    (x) =>
      x.type === "video" &&
      x.tags.some((tag) => tagMatches(search,tag)),
  );
}
export function insertStockPhotos(
  article: Article,
  photos: StockPhoto[],
): Article {
  const existing = article.images ?? [];
  if (
    existing.length >= photos.length &&
    existing.every((photo) => article.content_md.includes(photo.url))
  )
    return article;
  const selected = [
    ...new Map(
      [...existing, ...photos].map((photo) => [photo.url, photo]),
    ).values(),
  ].slice(0, Math.max(existing.length, photos.length));
  const missing = selected.filter(
    (photo) => !article.content_md.includes(photo.url),
  );
  const clean = (s: string) => s.replace(/[\[\]\n]/g, " ");
  const blocks = article.content_md.split(/(?=^## )/m);
  let eligible = blocks
    .map((block, index) => ({ block, index }))
    .filter(
      ({ block }) =>
        /^## /m.test(block) &&
        !/^## (?:Quick Answer|クイックアンサー|簡易回答|要点|即答|Frequently Asked|FAQ|よくある|Sources|References)/i.test(
          block.trim(),
        ),
    )
    .map((x) => x.index);
  if (!eligible.length) {
    blocks.push("\n\n## Gallery\n");
    eligible = [blocks.length - 1];
  }
  missing.forEach((photo, i) => {
    const target =
      eligible[
        Math.min(
          eligible.length - 1,
          Math.floor((i * eligible.length) / missing.length),
        )
      ];
    blocks[target] +=
      `\n\n![${clean(photo.alt)}](${photo.url})\n\n${["Adobe Firefly", "Gemini"].includes(photo.provider) ? `*AI-generated illustration (${photo.provider}). Not documentary evidence.*` : photo.provider === "Wikimedia Commons" ? `*Photo: [${clean(photo.photographer)}](${photo.page}) / Wikimedia Commons, [${clean(photo.license || "license")}](${photo.license_url}). Context illustration.*` : `*Photo: [${clean(photo.photographer)} / ${photo.provider}](${photo.page}). Context illustration.*`}\n\n`;
  });
  return { ...article, content_md: normalizeMarkdownSpacing(blocks.join("")), images: selected };
}
/**
 * A real, openly licensed photograph for one slot: Claude plans the search
 * phrases, Wikimedia Commons supplies attributable candidates, and Claude's
 * pixel review decides. At most COMMONS_REVIEWS_PER_SLOT reviews per slot.
 */
async function commonsPhoto(
  env: Env,
  w: Workspace,
  slug: string,
  title: string,
  brief: MediaBrief,
  slot: number,
  photos: StockPhoto[],
): Promise<StockPhoto | null> {
  const plan = await slotPlan(env, w.site_id, slug, brief, slot, 3);
  const heading = (brief.sections[slot % Math.max(1, brief.sections.length)] || brief.title).replace(/[?？!:]/g, "");
  const candidates = (
    await commonsCandidates(env, w.site_id, slug, brief, slot, plan?.search_queries.length ? plan.search_queries : [heading], koreanMedia)
  ).filter((c) => !env.MEDIA_EXCLUDED_IDS?.includes(c.photo.id) && !photos.some((p) => p.id === c.photo.id));
  for (const candidate of candidates.slice(0, COMMONS_REVIEWS_PER_SLOT)) {
    let photo: StockPhoto;
    try {
      photo = await storeCommonsPhoto(env, candidate);
    } catch {
      continue;
    }
    const checked = await reviewPhoto({ ...env, MEDIA_IMAGE_SLOT: slot }, w.site_id, slug, title, photo);
    if (checked.visual_review?.approved) return checked;
  }
  return null;
}
/** Wall time one photo-stage request spends before the next slot moves to a new request. */
export const MEDIA_RUN_MS = 120000;
export async function illustrate(
  env: Env,
  w: Workspace,
  slug: string,
  articles: Record<string, Article>,
) {
  const result = structuredClone(articles);
  for (const article of Object.values(result)) {
    const rejected = (article.images || []).filter(
      (p) =>
        !["Adobe Stock", "Adobe Firefly", "Gemini", "Wikimedia Commons"].includes(p.provider) ||
        !koreanMedia(p.alt),
    );
    for (const photo of rejected) {
      article.content_md = article.content_md.replace(
        /!\[[^\]]*\]\((https:\/\/[^)]+)\)/g,
        (match, url) => (url === photo.url ? "" : match),
      );
      article.content_md = article.content_md
        .split("\n")
        .filter(
          (line) =>
            !(line.includes(photo.page) && /Photo:|写真|Credit/i.test(line)),
        )
        .join("\n");
    }
    article.images = (article.images || []).filter(
      (p) => !rejected.includes(p),
    );
  }
  const first = result[w.languages[0]];
  const brief=await mediaBrief(first,w);
  env={...env,MEDIA_EDITORIAL_BRIEF:brief};
  const query = mediaSearchQuery(first);
  const search=folded(query);
  const count = Math.max(2, Math.min(4, w.strategy.required_images));
  const candidates = (await stockPhotos(env, query, 0, w.site_id)).filter(p=>!env.MEDIA_EXCLUDED_IDS?.includes(p.id));
  const photos: StockPhoto[] = [];
  for (const candidate of candidates) {
    if(photos.length>=count)break;
    const checked = await reviewPhoto(
      {...env,MEDIA_IMAGE_SLOT:photos.length},
      w.site_id,
      slug,
      first.title,
      candidate,
    );
    if (
      checked.visual_review?.approved &&
      !photos.some((p) => p.url === checked.url)
    )
      photos.push(checked);
    if (photos.length >= count) break;
  }
  const sources = (env.MEDIA_SETTINGS ?? DEFAULT_MEDIA_SETTINGS).sources;
  const started = Date.now();
  for (let i = photos.length; i < count; i++) {
    // Planning, search and review are all cached, so a long run hands the next slot to a fresh request.
    if (Date.now() - started > MEDIA_RUN_MS) throw new PendingMedia("사진 자리를 나누어 이어서 준비합니다.");
    if(env.MEDIA_MANUAL_ONLY)throw new HttpError(409,"MEDIA_REVIEW: 사용자 지정 이미지 교체 대기입니다. 글과 검증 기록은 보존하며, 적합한 원본을 등록하면 이어서 검토합니다.");
    // An image already approved for this slot is reused before any source is asked again.
    const kept = generatedImagesReady(env) ? await approvedGeneratedPhoto(env, w.site_id, slug, i) : null;
    if (kept && !env.MEDIA_EXCLUDED_IDS?.includes(kept.id) && !photos.some((p) => p.url === kept.url)) {
      photos.push(kept);
      continue;
    }
    let spent: unknown = null, fresh = false, filled = false;
    for (const source of sources) {
      if (source === "commons") {
        const found = await commonsPhoto(env, w, slug, first.title, brief, i, photos);
        if (found) {
          photos.push(found);
          filled = true;
          break;
        }
        continue;
      }
      if (!generatedImagesReady(env)) continue;
      try {
        const generated = await generatedPhoto(env, w.site_id, slug, first.title, i);
        const {fresh: made, ...photo} = generated;
        photos.push(photo);
        fresh = made;
        filled = true;
        break;
      } catch (e) {
        // A spent generation ladder can still be covered by a later source; it is reported only if nothing fills the slot.
        if (e instanceof ImageCandidatesRejected && sources.indexOf("generate") < sources.length - 1) {
          spent = e;
          continue;
        }
        throw e;
      }
    }
    if (filled) {
      if (fresh && i < count - 1) throw new PendingMedia("첫 이미지의 생성·검토를 저장했습니다. 다음 이미지를 이어서 준비합니다.");
      continue;
    }
    if (spent) throw spent;
    if (sources.includes("generate") && !generatedImagesReady(env) && fireflyReady(env)) {
      const asset = await creativeAsset(
        env,
        `${w.site_id}-${slug}-approved-image-${i}`,
        w.site_id,
        "image",
        `South Korean conceptual editorial illustration for ${first.title}. ${i % 2 ? "Close-up practical detail" : "Wide overview scene"}. No Japanese cultural elements, named real places, logos or readable text.`,
      );
      const checked = await reviewPhoto(env, w.site_id, slug, first.title, {
        id: `${slug}-${i}`,
        provider: "Adobe Firefly",
        url: asset.url,
        page: "https://www.adobe.com/products/firefly.html",
        photographer: "Adobe Firefly",
        photographer_url: "https://www.adobe.com/products/firefly.html",
        alt: `South Korean conceptual illustration: ${first.title}`,
        license_url: "https://www.adobe.com/legal/terms.html",
      });
      if (!checked.visual_review?.approved)
        throw new HttpError(
          409,
          "MEDIA_REVIEW: 생성 이미지가 적합성 검토를 통과하지 못했습니다.",
        );
      photos.push(checked);
    } else
      throw new HttpError(
        409,
        sources.includes("generate")
          ? "MEDIA_REVIEW: 주제에 맞는 Adobe 원본 등록 또는 자동 이미지 생성 연결이 필요합니다."
          : "MEDIA_REVIEW: Wikimedia Commons에서 주제에 맞는 사진을 찾지 못했습니다. 연결 화면에서 이미지 생성을 켜거나 원본을 등록하세요.",
      );
  }
  // Replace former assets as a unit; avoid silently retaining an unrelated image.
  for (const article of Object.values(result)) {
    for (const old of article.images || []) {
      article.content_md = article.content_md.replace(
        /!\[[^\]]*\]\((https:\/\/[^)]+)\)/g,
        (match, url) => (url === old.url ? "" : match),
      );
      article.content_md = article.content_md
        .split("\n")
        .filter(
          (line) =>
            !(
              line.includes(old.page) &&
              /Photo:|AI-generated|写真|Credit/i.test(line)
            ),
        )
        .join("\n");
    }
    article.images = [];
    article.image_brief_key=brief.key;
    article.image_direction={time_of_day:brief.time_of_day,scenes:brief.scenes};
  }
  for (const lang of w.languages)
    result[lang] = insertStockPhotos(result[lang], photos);
  const registered = (
    await env.WORKBOARD_DB.prepare(
      "SELECT * FROM reusable_media WHERE site_id=? AND kind='video' ORDER BY created_at DESC LIMIT 100",
    )
      .bind(w.site_id)
      .all<{
        id: string;
        provider: string;
        title: string;
        tags_json: string;
        url: string;
        source_url: string;
      }>()
  ).results
    .filter((x) =>
      JSON.parse(x.tags_json).some((tag: string) =>
        tagMatches(search,tag),
      ),
    )
    .map((x) => ({
      id: x.id,
      provider: x.provider,
      alt: x.title,
      url: x.url,
      page: x.source_url,
    }));
  const videos = [...registered, ...licensedVideos(query)];
  if (videos.length)
    for (const lang of w.languages) {
      const video = videos[0];
      result[lang].videos = [
        {
          id: video.id,
          provider: "Adobe Stock",
          url: video.url,
          page: video.page,
          alt: video.alt,
        },
      ];
      result[lang].content_md +=
        `\n\n[Video: ${video.alt}](${video.url})\n\n${"provider" in video && video.provider === "Adobe Firefly" ? "*AI-generated with Adobe Firefly. Not documentary evidence.*" : `*Video: [Adobe Stock](${video.page}). Licensed stock footage.*`}`;
    }
  return result;
}
export async function mediaResponse(env: Env, path: string) {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+\/(en|ja|zh-hans)\/[0-3]\.jpg$/.test(path))
    throw new HttpError(404, "이미지를 찾지 못했습니다.");
  const row = await env.WORKBOARD_DB.prepare(
    "SELECT data,mime FROM media_assets WHERE asset_key=? AND data IS NOT NULL",
  )
    .bind(path)
    .first<{ data: number[]; mime: string }>();
  if (!row) throw new HttpError(404, "이미지를 찾지 못했습니다.");
  return new Response(new Uint8Array(row.data), {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": "public,max-age=31536000,immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
