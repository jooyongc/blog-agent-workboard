import type { Env } from "./env";
import type { Workspace, Article } from "../shared/types";
import { HttpError } from "./http";
import library from "../shared/licensed-media.json";
export type StockPhoto = {
  id: string;
  provider: "Pexels" | "Unsplash" | "Adobe Stock" | "Adobe Firefly";
  url: string;
  page: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  license_url: string;
};
async function pexelsPhotos(
  env: Env,
  query: string,
  count = 2,
): Promise<StockPhoto[]> {
  const key = typeof env.PEXELS_API_KEY === "string" ? env.PEXELS_API_KEY : "";
  if (!key)
    throw new HttpError(
      503,
      "무료 사진 검색 연결이 필요합니다. Cloudflare에 PEXELS_API_KEY를 설정하세요.",
    );
  let res = await fetch(
    "https://api.pexels.com/v1/search?" +
      new URLSearchParams({ query, per_page: "15", orientation: "landscape" }),
    { headers: { Authorization: key }, signal: AbortSignal.timeout(30000) },
  );
  if (!res.ok)
    throw new HttpError(502, "무료 사진 검색을 완료하지 못했습니다.");
  let data = (await res.json()) as {
    photos?: {
      id: number;
      url: string;
      photographer: string;
      photographer_url: string;
      alt: string;
      src: { large: string };
    }[];
  };
  if ((data.photos?.length ?? 0) < count) {
    const simple = /food|dining|meal|banchan|restaurant/i.test(query)
      ? "Korean food"
      : /skin|beauty|cosmetic|makeup/i.test(query)
        ? "skincare"
        : /airport|flight/i.test(query)
          ? "Incheon airport"
          : /shopping|tax|duty|refund/i.test(query)
            ? "Seoul shopping"
            : /busan/i.test(query)
              ? "Busan"
              : /korea|seoul/i.test(query)
                ? "Seoul"
                : "Korea travel";
    res = await fetch(
      "https://api.pexels.com/v1/search?" +
        new URLSearchParams({
          query: simple,
          per_page: "15",
          orientation: "landscape",
        }),
      { headers: { Authorization: key }, signal: AbortSignal.timeout(30000) },
    );
    if (!res.ok)
      throw new HttpError(502, "무료 사진 검색을 완료하지 못했습니다.");
    data = (await res.json()) as typeof data;
  }
  const photos = (data.photos ?? [])
    .filter(
      (x) =>
        x.src?.large?.startsWith("https://images.pexels.com/") &&
        x.url.startsWith("https://www.pexels.com/"),
    )
    .slice(0, count)
    .map((x) => ({
      id: String(x.id),
      provider: "Pexels" as const,
      url: x.src.large,
      page: x.url,
      photographer: x.photographer,
      photographer_url: x.photographer_url,
      alt: x.alt || query,
      license_url: "https://www.pexels.com/license/",
    }));
  if (photos.length < count)
    throw new HttpError(
      409,
      "주제에 맞는 무료 사진을 2장 이상 찾지 못했습니다. 검색 방향을 구체화해 주세요.",
    );
  return photos;
}
async function unsplashPhotos(
  env: Env,
  query: string,
  count: number,
): Promise<StockPhoto[]> {
  const key =
    typeof env.UNSPLASH_ACCESS_KEY === "string" ? env.UNSPLASH_ACCESS_KEY : "";
  if (!key) return [];
  const headers = { Authorization: "Client-ID " + key, "Accept-Version": "v1" };
  const response = await fetch(
    "https://api.unsplash.com/search/photos?" +
      new URLSearchParams({
        query,
        per_page: "10",
        orientation: "landscape",
        content_filter: "high",
      }),
    { headers, signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) return [];
  const data = (await response.json()) as {
    results: {
      id: string;
      alt_description: string;
      urls: { regular: string };
      links: { html: string; download_location: string };
      user: { name: string; links: { html: string } };
    }[];
  };
  const selected = data.results
    .filter(
      (x) =>
        x.urls.regular.startsWith("https://images.unsplash.com/") &&
        x.links.download_location.startsWith("https://api.unsplash.com/"),
    )
    .slice(0, count);
  const result: StockPhoto[] = [];
  for (const x of selected) {
    const tracking = await fetch(x.links.download_location, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!tracking.ok) continue;
    const credit = (url: string) =>
      url +
      (url.includes("?") ? "&" : "?") +
      "utm_source=blog_agent_workboard&utm_medium=referral";
    result.push({
      id: x.id,
      provider: "Unsplash",
      url: x.urls.regular,
      page: credit(x.links.html),
      photographer: x.user.name,
      photographer_url: credit(x.user.links.html),
      alt: x.alt_description || query,
      license_url: "https://unsplash.com/license",
    });
  }
  return result;
}
export async function stockPhotos(
  env: Env,
  query: string,
  count = 2,
): Promise<StockPhoto[]> {
  const adobe = library
    .filter(
      (x) =>
        x.type === "photo" &&
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
  const splash = await unsplashPhotos(
    env,
    query,
    Math.max(1, count - adobe.length),
  ).catch(() => []);
  let photos = [...adobe, ...splash].slice(0, count);
  if (photos.length < count) {
    const pexels = await pexelsPhotos(env, query, count - photos.length).catch(
      () => [],
    );
    photos = [...photos, ...pexels].slice(0, count);
  }
  if (photos.length < count)
    throw new HttpError(
      409,
      "주제에 맞는 무료 사진을 2장 이상 확보하지 못했습니다. 검색 연결을 확인하세요.",
    );
  return photos;
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
  if (existing.length >= 2) return article;
  const clean = (s: string) => s.replace(/[\[\]\n]/g, " ");
  const blocks = article.content_md.split(/(?=^## )/m);
  photos.forEach((photo, i) => {
    const target = Math.min(
      blocks.length - 1,
      Math.max(0, Math.floor(((i + 1) * blocks.length) / (photos.length + 1))),
    );
    blocks[target] +=
      `\n\n![${clean(photo.alt)}](${photo.url})\n\n*Photo: [${clean(photo.photographer)} / ${photo.provider}](${photo.page}). Context illustration.*\n\n`;
  });
  return { ...article, content_md: blocks.join(""), images: photos };
}
export async function illustrate(
  env: Env,
  w: Workspace,
  slug: string,
  articles: Record<string, Article>,
) {
  const result = structuredClone(articles);
  const first = result[w.languages[0]];
  const query = first.primary_keyword || first.title;
  const photos = await stockPhotos(
    env,
    query,
    Math.max(2, Math.min(4, w.strategy.required_images)),
  );
  for (const lang of w.languages)
    result[lang] = insertStockPhotos(result[lang], photos);
  const videos = licensedVideos(query);
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
        `\n\n[Video: ${video.alt}](${video.url})\n\n*Video: [Adobe Stock](${video.page}). Licensed stock footage.*`;
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
