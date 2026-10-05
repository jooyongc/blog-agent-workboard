/**
 * scripts/_lib/config.ts
 *
 * Shared site-config loader for multi-site support.
 * Backward compatible: if no --site flag or config file is found, falls back
 * to legacy single-site mode (ASTY Cabin defaults).
 */

import * as fs from 'fs';
import { safeId, option } from './runtime.js';
import * as path from 'path';

export type SiteConfig = {
  site_id: string;
  site_url: string;
  env: { api_key: string };
  languages: string[];
  canonical_lang: string;
  categories: string[];
  deepl?: {
    glossary_ids?: Record<string, string>;
    formality?: Record<string, string>;
  };
  paths: {
    glossary_dir: string;
    topic_queue: string;
    voice_guide: string;
    drafts: string;
    published: string;
    affiliate_file?: string;
  };
  budget?: {
    deepl_chars_per_run?: number;
    deepl_chars_monthly?: number;
  };
};

/**
 * Parse --site=<id> or --site <id> from process.argv. Returns null if absent.
 */
export function parseSiteArg(argv: string[]): string | null {
  return option(argv, 'site') ?? null;
}

/**
 * Get the site ID, falling back to env or default.
 * Priority: --site flag > BLOG_SITE env > 'asty-cabin' default
 */
export function resolveSiteId(argv: string[]): string {
  return parseSiteArg(argv) ?? process.env.BLOG_SITE ?? 'asty-cabin';
}

/**
 * Remove --site flag (and its value) from argv, returning positional args only.
 */
export function stripSiteArg(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site') { i++; continue; } // skip flag + value
    if (a.startsWith('--site=')) continue;
    out.push(a);
  }
  return out;
}

/**
 * Load site config. Returns a synthesized legacy config if no file exists,
 * so legacy repo layouts continue to work without changes.
 */
export function loadSiteConfig(siteId?: string): SiteConfig {
  const id = safeId(siteId ?? 'asty-cabin', 'site ID');
  const configPath = path.join('sites', id, 'config.json');

  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SiteConfig;
    validate(raw);
    if (raw.site_id !== id) throw new Error('[config] site_id does not match directory');
    if (id === 'asty-cabin' && process.env.ASTY_SITE_URL) raw.site_url = process.env.ASTY_SITE_URL;
    return raw;
  }

  if (id !== 'asty-cabin') throw new Error(`[config] Unknown site: ${id}`);
  // Legacy fallback: assume single-site repo layout
  return {
    site_id: 'asty-cabin',
    site_url: process.env.ASTY_SITE_URL || 'https://asty-cabin-check.vercel.app',
    env: { api_key: 'ASTY_AGENT_API_KEY' },
    languages: ['en', 'ja', 'zh-hans'],
    canonical_lang: 'en',
    categories: ['medical', 'beauty', 'food', 'leisure', 'transport', 'family', 'corporate', 'culture'],
    deepl: {
      glossary_ids: { ja: 'DEEPL_GLOSSARY_JA_ID', 'zh-hans': 'DEEPL_GLOSSARY_ZH_ID' },
      formality: { ja: 'more', 'zh-hans': 'default' },
    },
    paths: {
      glossary_dir: 'glossary',
      topic_queue: 'topics/manual-queue.md',
      voice_guide: 'CLAUDE.md',
      drafts: 'content/drafts',
      published: 'content/published',
      affiliate_file: 'affiliate/links.json',
    },
    budget: {
      deepl_chars_per_run: Number(process.env.DEEPL_MAX_CHARS_PER_RUN ?? 40000),
      deepl_chars_monthly: Number(process.env.DEEPL_MAX_CHARS_MONTHLY ?? 450000),
    },
  };
}

function validate(cfg: SiteConfig): void {
  const missing: string[] = [];
  safeId(cfg.site_id, 'site ID');
  const url = new URL(cfg.site_url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('[config] Invalid site URL');
  if (!Array.isArray(cfg.languages) || !cfg.languages.includes(cfg.canonical_lang) || new Set(cfg.languages).size !== cfg.languages.length) throw new Error('[config] Invalid languages/canonical_lang');
  for (const value of Object.values(cfg.budget ?? {})) if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw new Error('[config] Invalid budget');
  if (!cfg.site_id) missing.push('site_id');
  if (!cfg.site_url) missing.push('site_url');
  if (!cfg.env?.api_key) missing.push('env.api_key');
  if (!cfg.languages?.length) missing.push('languages');
  if (!cfg.canonical_lang) missing.push('canonical_lang');
  if (!cfg.categories?.length) missing.push('categories');
  if (!cfg.paths?.drafts) missing.push('paths.drafts');
  if (!cfg.paths?.published) missing.push('paths.published');
  if (missing.length) {
    throw new Error(`[config] Invalid site config — missing: ${missing.join(', ')}`);
  }
}

/**
 * Resolve env var name from config and read the actual value.
 * Throws if the referenced env var is not set.
 */
export function requireEnv(name: string, context: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${context}: env var ${name} is not set`);
  return v;
}

/**
 * Convenience: get the draft directory for a slug under a given config.
 */
export function draftDir(cfg: SiteConfig, slug: string): string {
  return path.join(cfg.paths.drafts, safeId(slug));
}

export function publishedDir(cfg: SiteConfig, slug: string): string {
  return path.join(cfg.paths.published, safeId(slug));
}
