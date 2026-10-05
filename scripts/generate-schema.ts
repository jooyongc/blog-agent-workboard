import { safeId, timedFetch as fetch } from './_lib/runtime.js';
/**
 * scripts/generate-schema.ts
 *
 * Usage: npx tsx scripts/generate-schema.ts <slug>
 *
 * Reads content/drafts/<slug>/en.md + meta.json,
 * generates JSON-LD schema objects (Article, BreadcrumbList, FAQPage),
 * and writes them into meta.json under the `schema` key.
 *
 * No API calls — pure text processing.
 */

import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { loadSiteConfig, resolveSiteId, stripSiteArg } from './_lib/config.js';

const rawArgs = process.argv.slice(2);
const SITE_ID = resolveSiteId(rawArgs);
const cfg = loadSiteConfig(SITE_ID);
const positional = stripSiteArg(rawArgs);
const SLUG = positional[0] ? safeId(positional[0]) : '';
if (!SLUG) {
  console.error('Usage: tsx scripts/generate-schema.ts <slug> [--site <id>]');
  process.exit(1);
}

const SITE_URL = cfg.site_url;
const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG);
const EN_PATH = path.join(DRAFT_DIR, `${cfg.canonical_lang}.md`);
const META_PATH = path.join(DRAFT_DIR, 'meta.json');

if (!fs.existsSync(EN_PATH)) {
  console.error(`Not found: ${EN_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(META_PATH)) {
  console.error(`Not found: ${META_PATH}`);
  process.exit(1);
}

// ---- Parse FAQ section from markdown body ----
type FaqItem = { question: string; answer: string };

function parseFaq(body: string): FaqItem[] {
  const faqMatch = body.match(/##\s+Frequently Asked Questions([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (!faqMatch) return [];

  const section = faqMatch[1];
  const items: FaqItem[] = [];
  // Match **Q: ...** \n A: ...
  const pairs = section.matchAll(/\*\*Q:\s*(.+?)\*\*\s*\nA:\s*(.+?)(?=\n\n|\n\*\*Q:|\s*$)/gs);
  for (const match of pairs) {
    items.push({
      question: match[1].trim(),
      answer: match[2].trim(),
    });
  }
  return items;
}

// ---- Build schema objects ----

function buildArticleSchema(fm: Record<string, unknown>, meta: Record<string, unknown>): object {
  const translations = meta.translations as Record<string, { title: string; meta_description: string }>;
  const featuredImage = meta.featured_image as { url?: string; alt?: string } | undefined;
  // GEO/AEO: dateModified is a strong freshness signal for AI engines. If the
  // pipeline (or affiliate insertion) updated the post, prefer that timestamp;
  // otherwise fall back to publish_at.
  const datePublished = (meta.publish_at as string | null) ?? new Date().toISOString();
  const dateModified =
    (meta.updated_at as string | null) ??
    (meta.last_modified as string | null) ??
    datePublished;

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: translations?.en?.title ?? fm.title,
    description: translations?.en?.meta_description ?? fm.meta_description,
    author: {
      '@type': 'Organization',
      name: 'ASTY Cabin Editorial',
      url: SITE_URL,
    },
    publisher: {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#lodging`, // links to the LodgingBusiness entity emitted in layout
      name: 'ASTY Cabin',
      url: SITE_URL,
      logo: {
        '@type': 'ImageObject',
        url: `${SITE_URL}/images/logo.png`,
      },
    },
    datePublished,
    dateModified,
    inLanguage: 'en',
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${SITE_URL}/en/blog/${SLUG}`,
    },
    ...(featuredImage?.url ? {
      image: {
        '@type': 'ImageObject',
        url: featuredImage.url,
        description: featuredImage.alt ?? '',
      },
    } : {}),
  };
}

function buildBreadcrumbSchema(meta: Record<string, unknown>): object {
  const translations = meta.translations as Record<string, { title: string }>;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: `${SITE_URL}/en`,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Blog',
        item: `${SITE_URL}/en/blog`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: translations?.en?.title ?? SLUG,
        item: `${SITE_URL}/en/blog/${SLUG}`,
      },
    ],
  };
}

function buildFaqSchema(faqs: FaqItem[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: answer,
      },
    })),
  };
}

// ---- HowTo detection ----
type HowToStep = { name: string; text: string };

/**
 * Detect a HowTo pattern by locating a numbered-step list under an H2
 * whose title contains a "how to / step / getting there" keyword.
 * Returns [] if no plausible HowTo is found.
 */
function parseHowTo(body: string): { name: string | null; steps: HowToStep[] } {
  const headingRegex = /##\s+(.+?)\n([\s\S]*?)(?=\n##\s|$)/g;
  const triggers = /(how to|how\s+do|step[-\s]?by[-\s]?step|getting there|directions|walk\s+from|route|itinerary)/i;
  for (const match of body.matchAll(headingRegex)) {
    const heading = match[1].trim();
    const section = match[2];
    if (!triggers.test(heading)) continue;

    // Collect numbered steps ("1. ...", "2. ..."). Must have at least 3 consecutive.
    const stepLines = section
      .split(/\n/)
      .filter((l) => /^\s*\d+\.\s+/.test(l))
      .map((l) => l.replace(/^\s*\d+\.\s+/, '').trim())
      .filter((l) => l.length >= 10);
    if (stepLines.length < 3) continue;

    const steps: HowToStep[] = stepLines.slice(0, 8).map((text, i) => ({
      name: `Step ${i + 1}`,
      text,
    }));
    return { name: heading, steps };
  }
  return { name: null, steps: [] };
}

function buildHowToSchema(name: string, steps: HowToStep[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    step: steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  };
}

// ---- Mentions from graph entities ----

async function fetchMentions(body: string): Promise<object[]> {
  const apiBase = process.env.ASTY_SITE_URL || SITE_URL;
  const apiKeyName = process.env.BLOG_SITE_API_KEY_VAR || 'ASTY_AGENT_API_KEY';
  const key = process.env[apiKeyName];
  if (!key) return [];
  try {
    const haystack = body.toLowerCase();
    // Pull hot entities (global + site) to match against body text.
    const res = await fetch(`${apiBase}/api/admin/graph/suggest-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ site_id: cfg.site_id, draft_text: body, limit: 1 }),
    });
    if (!res.ok) return [];
    // suggest-links returns anchor_candidates; re-request the entities directly.
    // Instead, use the cheap entity list from the response's matched_entities hint
    // by querying the graph/export?entity= for each top candidate is expensive —
    // we'll just do a simple name match against the draft body using a secondary
    // endpoint: /api/admin/graph/entities?q=... is not defined, so we stick with
    // anchor_candidates from suggest-links for the `mentions` field.
    const data = (await res.json()) as {
      suggestions?: Array<{ anchor_candidates: string[] }>;
    };
    const names = new Set<string>();
    for (const s of data.suggestions ?? []) {
      for (const a of s.anchor_candidates) {
        if (a && a.length >= 3 && haystack.includes(a.toLowerCase())) names.add(a);
      }
    }
    return Array.from(names).slice(0, 12).map((n) => ({
      '@type': 'Thing',
      name: n,
    }));
  } catch {
    return [];
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const source = fs.readFileSync(EN_PATH, 'utf8');
  const { data: fm, content: body } = matter(source);
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as Record<string, unknown>;

  const article = buildArticleSchema(fm, meta) as Record<string, unknown>;

  // Inject `mentions` when graph-backed entity names are found in the draft.
  const mentions = await fetchMentions(body);
  if (mentions.length > 0) {
    article.mentions = mentions;
  }

  const schemas: object[] = [article, buildBreadcrumbSchema(meta)];
  const extras: string[] = [];

  // Prefer FAQ entries from meta.json (extracted by packager — canonical, cleaned).
  // Fall back to parsing the en.md body directly so schemas still emit if the
  // packager step was skipped.
  let faqs: FaqItem[] = []
  const metaFaq = (meta as { faq?: Array<{ question: string; answer: string }> }).faq
  if (Array.isArray(metaFaq) && metaFaq.length >= 3) {
    faqs = metaFaq
      .filter((f) => f && typeof f.question === 'string' && typeof f.answer === 'string')
      .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
  } else {
    faqs = parseFaq(body)
  }
  if (faqs.length >= 3) {
    schemas.push(buildFaqSchema(faqs));
    extras.push(`FAQPage(${faqs.length})`);
  } else if (faqs.length > 0) {
    // Under 3 = below FAQPage spec recommendation. Skip emission to avoid weak schema.
    extras.push(`FAQPage skipped (${faqs.length}<3)`);
  }

  const howTo = parseHowTo(body);
  if (howTo.steps.length > 0 && howTo.name) {
    schemas.push(buildHowToSchema(howTo.name, howTo.steps));
    extras.push(`HowTo(${howTo.steps.length} steps)`);
  }

  if (mentions.length > 0) extras.push(`mentions(${mentions.length})`);

  meta.schema = schemas;
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

  console.log(`✓ Schema generated for ${SLUG}`);
  console.log(`  Article + BreadcrumbList${extras.length ? ' + ' + extras.join(' + ') : ''}`);
  console.log(`  Updated: ${META_PATH}`);
}

main().catch((e) => {
  console.error(`[generate-schema] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
