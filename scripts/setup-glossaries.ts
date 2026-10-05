/**
 * scripts/setup-glossaries.ts
 *
 * Usage: npx tsx scripts/setup-glossaries.ts [--site <id>]
 *
 * Run ONCE per site to upload glossary CSVs to DeepL and print resulting
 * glossary IDs. Save those IDs to .env as per the config's glossary_ids map.
 *
 * CSV format: source_term,target_term (no header)
 * Location: {cfg.paths.glossary_dir}/<lang>.csv
 */

import * as deepl from 'deepl-node';
import * as fs from 'fs';
import * as path from 'path';
import { loadSiteConfig, resolveSiteId } from './_lib/config.js';

const SITE_ID = resolveSiteId(process.argv.slice(2));
const cfg = loadSiteConfig(SITE_ID);

const translator = new deepl.Translator(process.env.DEEPL_API_KEY!);

// DeepL code map — site config uses 'zh-hans', DeepL wants 'zh'.
const DEEPL_SRC_MAP: Record<string, deepl.SourceLanguageCode> = {
  en: 'en', ja: 'ja', 'zh-hans': 'zh', 'zh-hant': 'zh',
  ko: 'ko', fr: 'fr', de: 'de', es: 'es', it: 'it',
};
const DEEPL_TGT_MAP: Record<string, deepl.TargetLanguageCode> = {
  en: 'en-US', ja: 'ja', 'zh-hans': 'zh-HANS', 'zh-hant': 'zh-HANT',
  ko: 'ko', fr: 'fr', de: 'de', es: 'es', it: 'it',
};

const source = DEEPL_SRC_MAP[cfg.canonical_lang];
if (!source) throw new Error(`Unsupported canonical lang: ${cfg.canonical_lang}`);

async function uploadGlossary(targetLang: string) {
  const csvPath = path.join(cfg.paths.glossary_dir, `${targetLang === 'zh-hans' ? 'zh' : targetLang}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.log(`skip ${targetLang} — no CSV at ${csvPath}`);
    return;
  }
  const target = DEEPL_TGT_MAP[targetLang];
  if (!target) {
    console.log(`skip ${targetLang} — unsupported in DeepL map`);
    return;
  }
  const name = `${cfg.site_id}-${targetLang}-v1`;
  const glossary = await translator.createGlossaryWithCsv(name, source, target, csvPath);
  const envName = cfg.deepl?.glossary_ids?.[targetLang] ?? '(not mapped)';
  console.log(`Created ${name} for ${targetLang}: ${glossary.glossaryId} (${glossary.entryCount} entries) → set env ${envName}`);
}

(async () => {
  console.log(`Setting up glossaries for site "${cfg.site_id}"...`);
  for (const lang of cfg.languages) {
    if (lang === cfg.canonical_lang) continue;
    await uploadGlossary(lang);
  }
  console.log('\nAdd the IDs above to your .env file.');
})().catch((e) => { console.error(e); process.exit(1); });
