import type { Env } from "./env";
import type { StockPhoto } from "./media";
import type { MediaBrief } from "./media-brief";
import { HttpError } from "./http";
const API = "https://commons.wikimedia.org/w/api.php";
/** Wikimedia requires an identifying User-Agent for API and media requests. */
const USER_AGENT = "BlogAgentWorkboard/1.0 (https://blog-agent-workboard.pages.dev)";
/** Real photographs reviewed per slot; each review is a metered vision call. */
export const COMMONS_REVIEWS_PER_SLOT = 3;
/** Licenses that allow commercial reuse with attribution only: public domain, CC0, CC BY and CC BY-SA. */
const FREE_LICENSE = /^(?:cc0|pd|cc-by(?:-sa)?-[1-4]\.[05](?:-[a-z]{2,})?)$/;
const PLACES = ["Seoul", "Busan", "Jeju", "Incheon", "Gyeongju", "Daegu", "Daejeon", "Gwangju", "Jeonju", "Suwon", "Gangneung", "Sokcho", "Andong", "Yeosu"];
export type CommonsCandidate = { photo: StockPhoto; source: string };
type CommonsPage = {
  pageid: number;
  title: string;
  index?: number;
  imageinfo?: {
    descriptionurl?: string;
    thumburl?: string;
    width: number;
    height: number;
    mime: string;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }[];
};
const plain = (html = "") =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/**
 * One search hit as an attributable, freely licensed, landscape Korean
 * photograph, or null. Anything with a usage restriction, a non-free or
 * share-nothing license, a missing author or no Korean context is skipped.
 */
export function commonsCandidate(page: CommonsPage, korean: (text: string) => boolean): CommonsCandidate | null {
  const info = page.imageinfo?.[0];
  const meta = info?.extmetadata || {};
  if (!info || !["image/jpeg", "image/png"].includes(info.mime) || info.width < 1200 || info.width / info.height < 1.2) return null;
  const license = (meta.License?.value || "").toLowerCase();
  if (!FREE_LICENSE.test(license) || plain(meta.Restrictions?.value) || meta.NonFree?.value === "true") return null;
  const author = plain(meta.Artist?.value).slice(0, 100);
  if (!author && !["pd", "cc0"].includes(license)) return null;
  const name = page.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const context = `${name} ${plain(meta.ImageDescription?.value)} ${meta.Categories?.value || ""}`;
  if (!korean(context)) return null;
  let source: URL;
  try {
    source = new URL(info.thumburl || "");
  } catch {
    return null;
  }
  if (source.protocol !== "https:" || !/(^|\.)wikimedia\.org$/.test(source.hostname)) return null;
  const page_url = info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;
  const place = PLACES.find((p) => new RegExp(`\\b${p}\\b`, "i").test(context));
  return {
    source: source.toString(),
    photo: {
      id: `commons-${page.pageid}`,
      provider: "Wikimedia Commons",
      url: "",
      page: page_url,
      photographer: author || "Unknown author",
      photographer_url: page_url,
      alt: /korea/i.test(name) ? name : `${name} (${place && !name.includes(place) ? place + ", " : ""}South Korea)`,
      license_url: (meta.LicenseUrl?.value || (license === "cc0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : page_url)).replace(/^http:/, "https:"),
      license: license === "pd" ? "Public domain" : license === "cc0" ? "CC0 1.0" : plain(meta.LicenseShortName?.value) || license.toUpperCase(),
    },
  };
}
async function search(query: string, korean: (text: string) => boolean) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "10",
    gsrsearch: `${query} filetype:bitmap`,
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1280",
    iiextmetadatafilter: "ImageDescription|Artist|LicenseShortName|LicenseUrl|License|Restrictions|Categories|NonFree",
  });
  const r = await fetch(`${API}?${params}`, {
    headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Commons HTTP ${r.status}`);
  const data: any = await r.json();
  return ((data.query?.pages || []) as CommonsPage[])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((page) => commonsCandidate(page, korean))
    .filter((c): c is CommonsCandidate => !!c);
}
/**
 * Freely licensed Korean photographs for one slot, found with the search
 * phrases Claude planned for it. The list is kept per brief and slot, so later
 * runs reuse it; a search the API did not answer is not cached.
 */
export async function commonsCandidates(
  env: Env,
  site: string,
  slug: string,
  brief: MediaBrief,
  slot: number,
  queries: string[],
  korean: (text: string) => boolean,
): Promise<CommonsCandidate[]> {
  const id = `${site}-${slug}-commons-b${brief.key.slice(0, 16)}-s${slot}`;
  const prior = await env.WORKBOARD_DB.prepare("SELECT result_json FROM creative_requests WHERE id=?")
    .bind(id)
    .first<{ result_json: string | null }>();
  if (prior?.result_json) return JSON.parse(prior.result_json);
  const found = new Map<string, CommonsCandidate>();
  let answered = false;
  for (const query of queries.slice(0, 3)) {
    try {
      for (const candidate of await search(query, korean)) if (!found.has(candidate.photo.id)) found.set(candidate.photo.id, candidate);
      answered = true;
    } catch {
      // An unanswered search is retried on a later run; generation can still fill the slot now.
    }
  }
  const list = [...found.values()].slice(0, 8);
  if (answered) {
    const now = new Date().toISOString();
    await env.WORKBOARD_DB.prepare(
      "INSERT OR IGNORE INTO creative_requests(id,site_id,kind,prompt,status,result_json,created_at,updated_at) VALUES(?,?,'commons',?,'complete',?,?,?)",
    )
      .bind(id, site, queries.join(" | ").slice(0, 300), JSON.stringify(list), now, now)
      .run();
  }
  return list;
}
/**
 * A self-hosted copy of the Commons thumbnail, so review, hashing and
 * delivery all read the same owned bytes rather than a third-party URL.
 */
export async function storeCommonsPhoto(env: Env, candidate: CommonsCandidate): Promise<StockPhoto> {
  const base = String(env.NATIVE_BLOG_SUPABASE_URL) + "/storage/v1";
  const ext = /\.png$/i.test(new URL(candidate.source).pathname) ? "png" : "jpg";
  const path = `commons/${candidate.photo.id.replace(/^commons-/, "")}-1280.${ext}`;
  const url = `${base}/object/public/workboard-media/${path}`;
  const stored = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!stored?.ok) {
    const r = await fetch(candidate.source, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
    const mime = r.headers.get("Content-Type")?.split(";")[0] || "";
    if (!r.ok || !["image/jpeg", "image/png"].includes(mime)) throw new HttpError(502, "Commons 사진을 내려받지 못했습니다.");
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > 7_500_000) throw new HttpError(413, "Commons 사진이 검토 한도보다 큽니다.");
    const upload = await fetch(`${base}/object/workboard-media/${path}`, {
      method: "POST",
      headers: {
        apikey: String(env.NATIVE_BLOG_SUPABASE_KEY),
        Authorization: "Bearer " + String(env.NATIVE_BLOG_SUPABASE_KEY),
        "Content-Type": mime,
        "x-upsert": "true",
      },
      body: bytes,
      signal: AbortSignal.timeout(60000),
    });
    if (!upload.ok) throw new HttpError(502, "Commons 사진을 보관하지 못했습니다.");
  }
  return { ...candidate.photo, url };
}
