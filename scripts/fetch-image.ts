import { safeId, timedFetch as fetch } from './_lib/runtime.js';
/**
 * scripts/fetch-image.ts
 *
 * Usage: npx tsx scripts/fetch-image.ts <slug>
 *
 * Reads content/drafts/<slug>/meta.json, uses its featured_image.query field
 * to search Unsplash, picks the best match, downloads the URL + credit info,
 * and writes back to meta.json.
 *
 * Unsplash API: https://api.unsplash.com/search/photos
 * Free tier: 50 requests/hour (plenty for 3 posts/week).
 * Required: UNSPLASH_ACCESS_KEY env var.
 *
 * Attribution: Unsplash requires you to credit the photographer and link back.
 * The site should render featured_image_credit on the post page.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadSiteConfig, resolveSiteId, stripSiteArg } from './_lib/config.js';

const rawArgs = process.argv.slice(2);
const SITE_ID = resolveSiteId(rawArgs);
const cfg = loadSiteConfig(SITE_ID);
const positional = stripSiteArg(rawArgs);
const SLUG = positional[0] ? safeId(positional[0]) : '';
if (!SLUG) {
  console.error('Usage: tsx scripts/fetch-image.ts <slug> [--site <id>]');
  process.exit(1);
}

const KEY = process.env.UNSPLASH_ACCESS_KEY;
if (!KEY) {
  console.error('UNSPLASH_ACCESS_KEY missing');
  process.exit(1);
}

const META_PATH = path.join(cfg.paths.drafts, SLUG, 'meta.json');
if (!fs.existsSync(META_PATH)) {
  console.error(`meta.json not found: ${META_PATH}`);
  process.exit(1);
}

type Meta = {
  slug: string;
  featured_image?: {
    strategy: 'unsplash' | 'manual' | 'generated';
    query?: string;
    url?: string;
    alt?: string;
    credit?: {
      source: string;
      author: string;
      author_url?: string;
      image_url?: string;
    };
  };
  translations?: Record<string, { title: string }>;
  [k: string]: unknown;
};

type UnsplashPhoto = {
  id: string;
  urls: { raw: string; full: string; regular: string; small: string };
  alt_description: string | null;
  description: string | null;
  width: number;
  height: number;
  likes: number;
  user: { name: string; username: string; links: { html: string } };
  links: { html: string; download_location: string };
};

type UnsplashSearch = {
  total: number;
  results: UnsplashPhoto[];
};

async function searchUnsplash(query: string): Promise<UnsplashPhoto[] | null> {
  const params = new URLSearchParams({
    query,
    per_page: '10',
    orientation: 'landscape',
    content_filter: 'high',
  });
  const res = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    headers: { Authorization: `Client-ID ${KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Unsplash ${res.status}: ${await res.text()}`);
  }
  const json: UnsplashSearch = await res.json();
  return json.results.length > 0 ? json.results : null;
}

function buildFallbackQueries(primary: string): string[] {
  const words = primary.split(/\s+/).filter(Boolean);
  const fallbacks: string[] = [];
  // 2-word prefix
  if (words.length > 2) fallbacks.push(words.slice(0, 2).join(' '));
  // first word only
  if (words.length > 1) fallbacks.push(words[0]);
  // always try "Seoul" as last resort
  if (!primary.toLowerCase().includes('seoul')) fallbacks.push('Seoul');
  else fallbacks.push('Seoul city');
  return [...new Set(fallbacks)];
}

async function run() {
  const meta: Meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const primaryQuery =
    meta.featured_image?.query ??
    meta.translations?.en?.title?.replace(/[^a-zA-Z0-9\s]/g, '').slice(0, 60);

  if (!primaryQuery) {
    throw new Error('No image query — set meta.featured_image.query');
  }

  const queriesToTry = [primaryQuery, ...buildFallbackQueries(primaryQuery)];
  let photos: UnsplashPhoto[] | null = null;
  let usedQuery = primaryQuery;

  for (const q of queriesToTry) {
    console.log(`→ Unsplash search: "${q}"`);
    photos = await searchUnsplash(q);
    if (photos) { usedQuery = q; break; }
    console.log(`  no results for "${q}", trying fallback…`);
  }

  if (!photos) {
    console.warn(`  ⚠ No Unsplash results for any query — skipping image (pipeline continues)`);
    process.exit(0);
  }

  // Scoring: prefer landscape (>1.3 aspect), high likes, descriptive alt text
  const scored = photos.map((p) => {
    const aspect = p.width / p.height;
    const landscapeBonus = aspect > 1.3 ? 50 : 0;
    const likesScore = Math.log(p.likes + 1) * 10;
    const hasAlt = p.alt_description ? 20 : 0;
    return { photo: p, score: landscapeBonus + likesScore + hasAlt };
  }).sort((a, b) => b.score - a.score);

  const chosen = scored[0].photo;
  console.log(`  ✔ ${chosen.id} by ${chosen.user.name} (score ${scored[0].score.toFixed(1)})`);

  // Per Unsplash API guidelines: "trigger" a download event when using a photo
  await fetch(chosen.links.download_location, {
    headers: { Authorization: `Client-ID ${KEY}` },
  }).catch(() => { /* non-fatal */ });

  // Build the featured_image block
  meta.featured_image = {
    strategy: 'unsplash',
    query: usedQuery,
    url: chosen.urls.regular,     // ~1080px wide
    alt: chosen.alt_description || chosen.description || usedQuery,
    credit: {
      source: 'Unsplash',
      author: chosen.user.name,
      author_url: `${chosen.user.links.html}?utm_source=asty_cabin&utm_medium=referral`,
      image_url: `${chosen.links.html}?utm_source=asty_cabin&utm_medium=referral`,
    },
  };

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  console.log(`  ✔ Updated ${META_PATH}`);
}

run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
