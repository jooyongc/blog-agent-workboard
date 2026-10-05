import { safeId, timedFetch as fetch } from './_lib/runtime.js';
/**
 * scripts/enforce-glossary.ts
 *
 * Usage: npx tsx scripts/enforce-glossary.ts <slug>
 *
 * Replaces the "translator-reviewer" agent. This is deterministic — no LLM calls,
 * no API cost. Catches 90% of DeepL's common mistakes via simple regex rules.
 *
 * Checks performed:
 *   Japanese (ja.md):
 *     - Glossary substitution (forced replacements from glossary/ja.csv)
 *     - Detect plain-form sentence endings → warn (not auto-fix)
 *     - Detect raw hangul → warn
 *
 *   Chinese (zh.md):
 *     - Glossary substitution
 *     - Replace 汉城 → 首尔 (outdated Seoul name)
 *     - Detect traditional characters → warn
 *
 * Failures are logged but do not block publishing. Warnings are reported for
 * human review. Forced replacements happen silently.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import matter from 'gray-matter';
import { loadSiteConfig, resolveSiteId, stripSiteArg } from './_lib/config.js';

const rawArgs = process.argv.slice(2);
const SITE_ID = resolveSiteId(rawArgs);
const cfg = loadSiteConfig(SITE_ID);
const positional = stripSiteArg(rawArgs);
const SLUG = positional[0] ? safeId(positional[0]) : '';
if (!SLUG) {
  console.error('Usage: tsx scripts/enforce-glossary.ts <slug> [--site <id>]');
  process.exit(1);
}

const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG);

function loadGlossary(csvPath: string): Array<[string, string]> {
  if (!fs.existsSync(csvPath)) return [];
  const csv = fs.readFileSync(csvPath, 'utf8');
  return parse(csv, { skip_empty_lines: true }) as Array<[string, string]>;
}

// Sort longest-first so "Songpa-gu" is replaced before "Songpa"
function sortGlossary(entries: Array<[string, string]>): Array<[string, string]> {
  return [...entries].sort((a, b) => b[0].length - a[0].length);
}

// Escape regex special chars
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Report = {
  replacements: number;
  warnings: string[];
};

function enforceJa(body: string, gloss: Array<[string, string]>): { body: string; report: Report } {
  const report: Report = { replacements: 0, warnings: [] };
  let out = body;

  // 1. Apply glossary substitutions.
  //    DeepL may have rendered source terms inconsistently; force our preferred form.
  for (const [src, tgt] of sortGlossary(gloss)) {
    // Skip if source and target are identical (e.g. "ASTY Cabin")
    if (src === tgt) continue;
    // Only replace when the SOURCE English term leaked through
    const re = new RegExp(`\\b${escRe(src)}\\b`, 'g');
    const matches = out.match(re);
    if (matches) {
      out = out.replace(re, tgt);
      report.replacements += matches.length;
    }
  }

  // 2. Detect raw hangul — DeepL sometimes leaves these in ja output
  const hangulMatches = out.match(/[\uAC00-\uD7A3]+/g);
  if (hangulMatches && hangulMatches.length > 0) {
    const unique = [...new Set(hangulMatches)];
    report.warnings.push(
      `Raw hangul found (${unique.length} unique terms): ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? '...' : ''}`
    );
  }

  // 3. Detect plain-form endings (だ。 / である。) — we want ですます
  const plainEndings = out.match(/[^くし]だ。|である。/g);
  if (plainEndings && plainEndings.length > 0) {
    report.warnings.push(
      `Plain-form sentence endings detected (${plainEndings.length}). Expected ですます体.`
    );
  }

  return { body: out, report };
}

function enforceZh(body: string, gloss: Array<[string, string]>): { body: string; report: Report } {
  const report: Report = { replacements: 0, warnings: [] };
  let out = body;

  // 1. Glossary substitutions
  for (const [src, tgt] of sortGlossary(gloss)) {
    if (src === tgt) continue;
    const re = new RegExp(`\\b${escRe(src)}\\b`, 'g');
    const matches = out.match(re);
    if (matches) {
      out = out.replace(re, tgt);
      report.replacements += matches.length;
    }
  }

  // 2. Force 首尔 for Seoul (DeepL sometimes outputs outdated 汉城)
  const hanCheng = out.match(/汉城/g);
  if (hanCheng) {
    out = out.replace(/汉城/g, '首尔');
    report.replacements += hanCheng.length;
  }

  // 3. Detect common traditional characters that leaked through
  //    (not exhaustive — just the most common ones)
  const tradChars = /[繁體臺灣這會國學實現樣發點]/g;
  const tradMatches = out.match(tradChars);
  if (tradMatches && tradMatches.length > 0) {
    const unique = [...new Set(tradMatches)];
    report.warnings.push(
      `Traditional characters detected: ${unique.join('')} — should be 简体.`
    );
  }

  return { body: out, report };
}

function processFile(
  file: string,
  glossaryPath: string,
  enforcer: (b: string, g: Array<[string, string]>) => { body: string; report: Report },
  lang: string
) {
  const fullPath = path.join(DRAFT_DIR, file);
  if (!fs.existsSync(fullPath)) {
    console.log(`  skip ${file} (not found)`);
    return;
  }

  const gloss = loadGlossary(glossaryPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const parsed = matter(raw);
  const { body, report } = enforcer(parsed.content, gloss);

  // Update frontmatter with review status
  const fm = {
    ...parsed.data,
    translation_review: report.warnings.length === 0 ? 'passed' : 'passed-with-warnings',
    glossary_replacements: report.replacements,
    review_warnings: report.warnings,
  };

  fs.writeFileSync(fullPath, matter.stringify(body, fm));

  console.log(`[${lang}] ${report.replacements} glossary replacements, ${report.warnings.length} warnings`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
}

console.log(`→ Enforcing glossary for ${SLUG}...`);
processFile('ja.md', path.join(cfg.paths.glossary_dir, 'ja.csv'), enforceJa, 'JA');
processFile('zh.md', path.join(cfg.paths.glossary_dir, 'zh.csv'), enforceZh, 'ZH');
console.log('✓ Done. Review any warnings before publishing.');
