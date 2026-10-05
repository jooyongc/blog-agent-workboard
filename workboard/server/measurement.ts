import type { Env } from "./env";
import type { Workspace } from "../shared/types";
import { remote } from "./http";
import { getPosts } from "./content";
export async function measure(env: Env, w: Workspace) {
  const pages = await getPosts(w, env).catch(() => ({ posts: [] }));
  const article = pages.posts.find(
    (p) => p.status === "published" && p.url,
  )?.url;
  const checks: Record<string, unknown> = {};
  const targets: Array<[string, string | undefined]> = [
    ["home", w.site_url],
    ["article", article],
    ["robots", w.site_url + "/robots.txt"],
    ["sitemap", w.site_url + "/sitemap.xml"],
    ["llms", w.site_url + "/llms.txt"],
    ["missing", w.site_url + "/workboard-nonexistent-page-991d7"],
  ];
  for (const [label, url] of targets) {
    if (!url) continue;
    try {
      const r = await remote(url);
      const text = (await r.text()).slice(0, 1000000);
      checks[label] = {
        url,
        status: r.status,
        h1: /<h1[\s>]/i.test(text),
        jsonld: text.includes("application/ld+json"),
        canonical: /rel=["']canonical/.test(text),
        noindex:
          /<meta[^>]+(?:name=["']robots["'][^>]*content=["'][^"']*noindex|content=["'][^"']*noindex[^>]*name=["']robots)/i.test(
            text,
          ) || /noindex/i.test(r.headers.get("x-robots-tag") ?? ""),
        ...(label === "robots"
          ? {
              ai_search_allowed:
                !/User-agent:\s*(OAI-SearchBot|PerplexityBot|Claude-SearchBot)[\s\S]{0,80}Disallow:\s*\//i.test(
                  text,
                ),
              sitemap_declared: /Sitemap:/i.test(text),
            }
          : {}),
        bytes: text.length,
      };
    } catch {
      checks[label] = { url, error: "원본 응답을 확인하지 못했습니다." };
    }
  }
  const now = new Date(),
    next = new Date(now.getTime() + 14 * 86400000);
  const value = {
    checks,
    gsc: {
      status: w.strategy.gsc_url ? "configured" : "not_connected",
      impressions: null,
      clicks: null,
    },
    citations: { status: "manual_measurement_needed", count: null },
    measured_at: now.toISOString(),
    next_measure_at: next.toISOString(),
  };
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO site_measurements(id,site_id,metrics_json,created_at,next_measure_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      w.site_id,
      JSON.stringify(value),
      now.toISOString(),
      next.toISOString(),
    )
    .run();
  return value;
}
export async function measurementDue(
  env: Env,
  workspaces: Workspace[],
  now: number,
) {
  for (const w of workspaces) {
    const last = await env.WORKBOARD_DB.prepare(
      "SELECT next_measure_at FROM site_measurements WHERE site_id=? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(w.site_id)
      .first<{ next_measure_at: string }>();
    if (!last || Date.parse(last.next_measure_at) <= now) {
      try {
        await measure(env, w);
      } catch {
        /* A fetch failure is recorded in the next scheduled pass, never interpreted as a zero metric. */
      }
    }
  }
}
