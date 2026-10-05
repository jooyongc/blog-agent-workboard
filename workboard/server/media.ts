import type { Env } from "./env";
import type { Workspace, Article } from "../shared/types";
import { HttpError } from "./http";
export async function illustrate(
  env: Env,
  w: Workspace,
  slug: string,
  articles: Record<string, Article>,
) {
  if (!w.strategy.required_images) return articles;
  if (!env.AI)
    throw new HttpError(503, "Cloudflare 이미지 생성 연결이 필요합니다.");
  const result = structuredClone(articles);
  for (const lang of w.languages) {
    const images: string[] = [];
    for (let i = 0; i < Math.min(4, w.strategy.required_images); i++) {
      const key = `${w.site_id}/${slug}/${lang}/${i}.jpg`;
      let asset = await env.WORKBOARD_DB.prepare(
        "SELECT data FROM media_assets WHERE asset_key=?",
      )
        .bind(key)
        .first<{ data: number[] | null }>();
      if (asset && !asset.data)
        throw new HttpError(
          409,
          "이전 이미지 생성 결과를 확인하세요. 자동으로 재생성하지 않습니다.",
        );
      if (!asset) {
        await env.WORKBOARD_DB.prepare(
          "INSERT INTO media_assets(asset_key,site_id,month,mime,created_at) VALUES(?,?,?,?,?)",
        )
          .bind(
            key,
            w.site_id,
            new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7),
            "image/jpeg",
            new Date().toISOString(),
          )
          .run();
        const style =
          w.integration === "blogger" && i < 3
            ? "editorial illustration, soft muted colors, clear shapes"
            : "photorealistic editorial illustration, natural lighting";
        const prompt =
          `${style}. An illustrative concept for this article: ${articles[lang].title}. Focus on ${w.strategy.pillars[i % w.strategy.pillars.length]}. No logos, written text, prices, charts or factual claims. Not documentary evidence. Landscape composition.`.slice(
            0,
            2000,
          );
        const generated = (await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          { prompt, steps: 4 },
        )) as { image: string };
        if (!generated.image)
          throw new HttpError(502, "이미지 생성이 완료되지 않았습니다.");
        const bytes = Uint8Array.from(atob(generated.image), (c) =>
          c.charCodeAt(0),
        );
        if (bytes.byteLength > 1500000)
          throw new HttpError(413, "이미지 크기가 저장 한도를 초과했습니다.");
        await env.WORKBOARD_DB.prepare(
          "UPDATE media_assets SET data=? WHERE asset_key=?",
        )
          .bind(bytes.buffer, key)
          .run();
        asset = { data: Array.from(bytes) };
      }
      const url =
        (env.PUBLIC_WORKBOARD_URL ?? "https://blog-agent-workboard.pages.dev") +
        "/api/media/" +
        key;
      images.push(
        `![${articles[lang].title.replace(/[\[\]\n]/g, "")} — ${i < 3 && w.integration === "blogger" ? "illustration" : "photorealistic illustration"} ${i + 1}](${url})\n\n*AI-generated illustration, not documentary evidence.*`,
      );
    }
    result[lang].content_md += "\n\n" + images.join("\n\n");
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
