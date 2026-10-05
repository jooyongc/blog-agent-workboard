import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { resolveSiteId } from './_lib/config.js';
import { safeId, option } from './_lib/runtime.js';
import { targetConfig, safeContent } from './_lib/bridge.js';
const args = process.argv.slice(2);
const { cfg, bridge } = targetConfig(resolveSiteId(args));
const input = option(args, 'input');
if (!input) throw new Error('--input <bundle-source.json> required');
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const slug = safeId(data.slug);
if (!cfg.categories.includes(data.category)) throw new Error('Unsupported category');
for (const lang of bridge.languages) {
  const t = data.translations?.[lang];
  if (!t?.title || !(t.content_md || t.content_html)) throw new Error(`Missing ${lang} article`);
  if (cfg.site_id === 'korea-buy-list' && lang === 'ja' && t.authoring_mode !== 'independent') throw new Error('Japanese must be independently researched');
  safeContent(t.content_md ?? t.content_html); // validate HTML/JSON-LD before creating any files
}
const dir = path.join(cfg.paths.drafts, slug);
if (fs.existsSync(dir)) throw new Error('Draft already exists; import does not overwrite');
fs.mkdirSync(dir, { recursive: true });
const meta = { slug, category: data.category, featured_image: data.featured_image, translations: {} as Record<string, unknown> };
for (const lang of bridge.languages) {
  const t = data.translations[lang];
  fs.writeFileSync(path.join(dir, `${lang}.md`), matter.stringify(t.content_md ?? t.content_html, { lang, title: t.title, meta_description: t.meta_description ?? '', authoring_mode: t.authoring_mode ?? 'independent', draft: true }));
  meta.translations[lang] = { title: t.title, meta_description: t.meta_description ?? '', tags: t.tags ?? [] };
}
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ overall_status: 'partial', claims_total: 0, summary: { verified: 0, unsupported: 0, contradicted: 0 }, note: 'Imported draft requires human source review. Import is not fact verification.' }, null, 2));
console.log(`Imported: ${dir}`);
