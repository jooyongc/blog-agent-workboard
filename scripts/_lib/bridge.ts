import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'dotenv';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import matter from 'gray-matter';
import { loadSiteConfig } from './config.js';
import { timedFetch, safeId } from './runtime.js';

export type Bridge = { adapter: 'blogger' | 'supabase'; languages: string[]; blog_id?: string; owner?: string; url_env?: string; key_env?: string; schema?: string; table?: string };
export function targetConfig(siteId: string) {
  const cfg = loadSiteConfig(siteId);
  const bridge = (cfg as typeof cfg & { bridge?: Bridge }).bridge;
  if (!bridge) throw new Error('Site has no bridge adapter');
  return { cfg, bridge };
}
// Explicitly selected local credentials file, never copied into bundles or output.
export function loadBridgeCredentials(): void {
  const file = process.env.BRIDGE_CREDENTIALS_FILE;
  if (!file) return;
  const selected = parse(fs.readFileSync(file));
  for (const key of ['SUPABASE_SERVICE_ROLE_KEY','ANTHROPIC_API_KEY','BLOGGER_ACCESS_TOKEN','BLOGGER_REFRESH_TOKEN','BLOGGER_CLIENT_ID','BLOGGER_CLIENT_SECRET']) {
    if (!process.env[key] && selected[key]) process.env[key] = selected[key];
  }
  if (!process.env.BRIDGE_SUPABASE_URL && selected.VITE_SUPABASE_URL) process.env.BRIDGE_SUPABASE_URL = selected.VITE_SUPABASE_URL;
}
export function safeContent(markdown: string): string {
  const structured: unknown[] = [];
  const body = markdown.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (_, raw: string) => {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('Invalid JSON-LD');
    structured.push(data);
    return '';
  });
  const html = sanitizeHtml(marked.parse(body, { async: false }) as string, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'figure', 'figcaption'],
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src','alt','width','height','loading'], div: ['lang'], a: ['href','rel','title'] },
    allowedSchemes: ['https','http','mailto'],
    allowProtocolRelative: false,
  });
  return html + structured.map(data => '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g, '\\u003c').replace(/[^\x00-\x7F]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')) + '</script>').join('');
}
export function buildBundle(siteId: string, slug: string) {
  const { cfg, bridge } = targetConfig(siteId);
  safeId(slug);
  const dir = path.join(cfg.paths.drafts, slug);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (meta.slug !== slug || !cfg.categories.includes(meta.category)) throw new Error('Invalid slug/category in metadata');
  const posts = bridge.languages.map(lang => {
    const source = matter(fs.readFileSync(path.join(dir, `${lang}.md`), 'utf8'));
    const t = meta.translations?.[lang];
    if (!t?.title?.trim() || !source.content.trim()) throw new Error(`Missing ${lang} title/body`);
    if (source.data.lang !== lang) throw new Error(`Wrong source language: ${lang}`);
    if (siteId === 'korea-buy-list' && lang === 'ja' && source.data.authoring_mode !== 'independent') throw new Error('Korea Buy List Japanese requires independent research; translation is not accepted');
    const html = safeContent(source.content);
    const labels = [...new Set([lang === 'ja' ? '日本語' : 'English', ...(t.tags ?? [])])];
    if (bridge.adapter === 'blogger') return { lang, payload: { title: t.title, content: html, labels }, slug: `${slug}-${lang}` };
    if (siteId === 'koreabylocal') return { lang, slug, payload: { slug, title: t.title, content: html, category: meta.category, excerpt: t.meta_description ?? '', seo_title: t.title.slice(0,60), seo_description: (t.meta_description ?? '').slice(0,160), author: 'Korea by Local', thumbnail_url: meta.featured_image?.url ?? null, hero_image_url: meta.featured_image?.url ?? null, status: 'draft', published_at: null } };
    return { lang, slug, payload: { slug, title: t.title, content: html, category: meta.category, image: meta.featured_image?.url ?? '', writer_name: 'Korea Decode Editor', status: 'draft' } };
  });
  return { site_id: siteId, slug, site_url: cfg.site_url, adapter: bridge.adapter, delivery_owner: bridge.owner ?? 'bridge', posts };
}
export async function bloggerToken(): Promise<string> {
  if (process.env.BLOGGER_ACCESS_TOKEN) return process.env.BLOGGER_ACCESS_TOKEN;
  const { BLOGGER_CLIENT_ID: client_id, BLOGGER_CLIENT_SECRET: client_secret, BLOGGER_REFRESH_TOKEN: refresh_token } = process.env;
  if (!client_id || !client_secret || !refresh_token) throw new Error('Blogger OAuth credentials are missing');
  const res = await timedFetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }) });
  if (!res.ok) throw new Error(`Blogger OAuth HTTP ${res.status}`);
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error('OAuth response missing access token');
  return data.access_token;
}
export function supabaseConnection(bridge: Bridge) {
  const url = process.env[bridge.url_env!];
  const key = process.env[bridge.key_env!];
  if (!url || !key) throw new Error('Bridge Supabase credentials are missing');
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'agkkvtfwqmzgbrqhvohs.supabase.co' || u.username || u.password) throw new Error('Unexpected Supabase project');
  return { url: u.origin, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept-Profile': bridge.schema!, 'Content-Profile': bridge.schema! } };
}
