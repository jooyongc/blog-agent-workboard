import type { Env } from "./env";
import type { Workspace, Article } from "../shared/types";
import { HttpError } from "./http";
export type StockPhoto = {
  id: string;
  provider: "Pexels" | "Unsplash";
  url: string;
  page: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  license_url: string;
};
export async function stockPhotos(
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
