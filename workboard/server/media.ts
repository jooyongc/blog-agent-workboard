import type { Env } from "./env";
import type { Workspace, Article } from "../shared/types";
import {
  VISUAL_POLICY,
  generatedImagesReady,
  generatedPhoto,
  reviewPhoto,
} from "./generated-media";
import { creativeAsset, fireflyReady, PendingMedia } from "./firefly";
import { HttpError } from "./http";
import library from "../shared/licensed-media.json";
export type StockPhoto = {
  id: string;
  provider: "Pexels" | "Unsplash" | "Adobe Stock" | "Adobe Firefly" | "Gemini";
  url: string;
  page: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  license_url: string;
  visual_review?: {
    approved: boolean;
    reason: string;
    model: string;
    run_id: string;
    sha256: string;
    policy?: string;
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
        ["Adobe Stock", "Adobe Firefly", "Gemini"].includes(p.provider) &&
        koreanMedia(p.alt) &&
        !!p.license_url &&
        p.visual_review?.approved === true && p.visual_review.policy === VISUAL_POLICY &&
        /^[a-f0-9]{64}$/.test(p.visual_review.sha256) &&
        article.content_md.includes(p.url),
    ) &&
    inline.every((url) => images.some((p) => p.url === url))
  );
}
export async function stockPhotos(
  env: Env,
  query: string,
  count = 2,
  siteId?: string,
): Promise<StockPhoto[]> {
  const uploaded = siteId
    ? (
        await env.WORKBOARD_DB.prepare(
          "SELECT * FROM reusable_media WHERE site_id=? AND kind='photo' ORDER BY created_at DESC LIMIT 100",
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
            query.toLowerCase().includes(tag),
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
        x.tags.some((tag) => query.toLowerCase().includes(tag)),
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
  return library.filter(
    (x) =>
      x.type === "video" &&
      x.tags.some((tag) => query.toLowerCase().includes(tag)),
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
      `\n\n![${clean(photo.alt)}](${photo.url})\n\n${["Adobe Firefly", "Gemini"].includes(photo.provider) ? `*AI-generated illustration (${photo.provider}). Not documentary evidence.*` : `*Photo: [${clean(photo.photographer)} / ${photo.provider}](${photo.page}). Context illustration.*`}\n\n`;
  });
  return { ...article, content_md: blocks.join(""), images: selected };
}
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
        !["Adobe Stock", "Adobe Firefly", "Gemini"].includes(p.provider) ||
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
  const query = first.primary_keyword || first.title;
  const count = Math.max(2, Math.min(4, w.strategy.required_images));
  const candidates = await stockPhotos(env, query, 0, w.site_id);
  const photos: StockPhoto[] = [];
  for (const candidate of candidates) {
    const checked = await reviewPhoto(
      env,
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
  for (let i = photos.length; i < count; i++) {
    if (generatedImagesReady(env)) {
      const {fresh,...photo}=await generatedPhoto(env, w.site_id, slug, first.title, i);
      photos.push(photo);
      if(fresh && i<count-1) throw new PendingMedia("첫 이미지의 생성·검토를 저장했습니다. 다음 이미지를 이어서 준비합니다.");
    } else if (fireflyReady(env)) {
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
        "MEDIA_REVIEW: 주제에 맞는 Adobe 원본 등록 또는 자동 이미지 생성 연결이 필요합니다.",
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
        query.toLowerCase().includes(tag),
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
