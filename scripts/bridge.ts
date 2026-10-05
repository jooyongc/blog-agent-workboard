import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSiteId, stripSiteArg } from './_lib/config.js';
import { safeId, requireReview, timedFetch, reviewHash } from './_lib/runtime.js';
import { targetConfig, buildBundle, bloggerToken, loadBridgeCredentials, supabaseConnection } from './_lib/bridge.js';
const args = process.argv.slice(2);
const siteId = resolveSiteId(args);
const slug = safeId(stripSiteArg(args)[0] ?? '');
const { cfg, bridge } = targetConfig(siteId);
const dir = path.join(cfg.paths.drafts, slug);
const bundle = buildBundle(siteId, slug); // validates all languages before any network write
const out = path.join('outbox', siteId, slug);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'bundle.json'), JSON.stringify(bundle, null, 2));
for (const p of bundle.posts) fs.writeFileSync(path.join(out, `${p.lang}.html`), p.payload.content);
console.log(`Prepared: ${out}/bundle.json (${bundle.posts.map(p => p.lang).join(', ')})`);
if (!args.includes('--send')) process.exit(0);
if (bridge.owner === 'aside-browser' && !args.includes('--api-mode')) throw new Error('Existing aside-browser owns this schedule. Use the bundle with that routine; --api-mode is an explicit manual draft-only override.');
requireReview(dir);
loadBridgeCredentials();
const token = bridge.adapter === 'blogger' ? await bloggerToken() : '';
const connection = bridge.adapter === 'supabase' ? supabaseConnection(bridge) : null;
for (const p of bundle.posts) {
  const receipt = path.join(out, `${p.lang}.receipt.json`);
  const attempt = path.join(out, `${p.lang}.attempt.json`);
  const fingerprint = reviewHash(dir);
  if (fs.existsSync(receipt)) {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (previous.hash !== fingerprint) throw new Error('Previously delivered content changed; reconcile remote draft before retry');
    console.log(`Already delivered ${p.lang}`); continue;
  }
  if (fs.existsSync(attempt)) throw new Error(`Ambiguous previous ${p.lang} attempt — check remote drafts before retry; do not delete blindly`);
  if (connection) {
    const q = new URLSearchParams({ slug: `eq.${slug}`, select: 'id,slug,status', limit: '1' });
    const res = await timedFetch(`${connection.url}/rest/v1/${bridge.table}?${q}`, { headers: connection.headers });
    if (!res.ok) throw new Error(`Duplicate preflight HTTP ${res.status}`);
    if ((await res.json() as unknown[]).length) throw new Error('Slug already exists remotely; existing article will not be overwritten');
  }
  fs.writeFileSync(attempt, JSON.stringify({ started_at: new Date().toISOString(), hash: fingerprint }), { flag: 'wx' });
  const url = bridge.adapter === 'blogger' ? `https://www.googleapis.com/blogger/v3/blogs/${bridge.blog_id}/posts?isDraft=true` : `${connection!.url}/rest/v1/${bridge.table}`;
  const headers = bridge.adapter === 'blogger' ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { ...connection!.headers, Prefer: 'return=representation' };
  const res = await timedFetch(url, { method: 'POST', headers, body: JSON.stringify(p.payload) });
  if (!res.ok) throw new Error(`Draft creation HTTP ${res.status}; inspect remote state before retry`);
  const result = await res.json();
  fs.writeFileSync(receipt, JSON.stringify({ hash: fingerprint, created_at: new Date().toISOString(), result }, null, 2));
  console.log(`Saved remote draft: ${p.lang}`);
}
