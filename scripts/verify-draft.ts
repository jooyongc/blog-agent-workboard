import { safeId, timedFetch as fetch } from './_lib/runtime.js';
/**
 * scripts/verify-draft.ts
 *
 * Usage: npx tsx scripts/verify-draft.ts <slug> [--site <id>]
 *
 * Post-writer, pre-packager step that reads verification.json (produced by
 * the `verifier` subagent in the /weekly command flow) and updates the
 * draft frontmatter so publish.ts can gate on verification status.
 *
 * This script does NOT invoke the LLM itself — the /weekly orchestrator does
 * that via the verifier subagent. This script is a deterministic finisher:
 * - Reads verification.json (written by verifier)
 * - Writes verification_status into en.md frontmatter
 * - Prints a concise summary
 * - Exits non-zero if overall_status = "blocked"
 *
 * Env: none (pure file IO)
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
  console.error('Usage: tsx scripts/verify-draft.ts <slug> [--site <id>]');
  process.exit(1);
}

const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG);
const EN_PATH = path.join(DRAFT_DIR, `${cfg.canonical_lang}.md`);
const VERIFICATION_PATH = path.join(DRAFT_DIR, 'verification.json');

if (!fs.existsSync(EN_PATH)) {
  console.error(`Draft not found: ${EN_PATH}`);
  process.exit(1);
}

if (!fs.existsSync(VERIFICATION_PATH)) {
  console.error('[verify] Missing verification.json — run verification before continuing');
  process.exit(2);
}

type VerificationReport = {
  slug: string;
  generated_at: string;
  claims_total: number;
  summary: { verified: number; unsupported: number; contradicted: number };
  overall_status: 'verified' | 'partial' | 'blocked';
  fetches_used: number;
  claims: Array<{
    text: string;
    status: 'verified' | 'unsupported' | 'contradicted';
    source: string | null;
    confidence: number;
    note?: string;
  }>;
};

let report: VerificationReport;
try {
  report = JSON.parse(fs.readFileSync(VERIFICATION_PATH, 'utf8')) as VerificationReport;
} catch (e) {
  console.error(`[verify] Malformed verification.json: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}

// Normalize status (defensive against agent output variance)
const ALLOWED = ['verified', 'partial', 'blocked'] as const;
const status = report.summary?.contradicted > 0 ? 'blocked' : ALLOWED.includes(report.overall_status as typeof ALLOWED[number])
  ? report.overall_status
  : 'partial';

// Update draft frontmatter
const raw = fs.readFileSync(EN_PATH, 'utf8');
const parsed = matter(raw);
const fm = {
  ...parsed.data,
  verification_status: status,
  verification_summary: {
    total: report.claims_total,
    verified: report.summary.verified,
    unsupported: report.summary.unsupported,
    contradicted: report.summary.contradicted,
    generated_at: report.generated_at,
  },
};
fs.writeFileSync(EN_PATH, matter.stringify(parsed.content, fm));

// Report
const { verified, unsupported, contradicted } = report.summary;
console.log(`[verify] ${SLUG}: ${status}`);
console.log(`  claims: ${report.claims_total} (verified=${verified}, unsupported=${unsupported}, contradicted=${contradicted})`);
console.log(`  fetches used: ${report.fetches_used}/3`);

if (contradicted > 0) {
  console.log('[verify] Contradicted claims:');
  for (const c of report.claims.filter(c => c.status === 'contradicted')) {
    console.log(`    - "${c.text.slice(0, 80)}..."`);
    if (c.note) console.log(`      note: ${c.note}`);
  }
}

if (status === 'blocked') {
  console.error('[verify] BLOCKED — draft has contradicted claims. Writer should rewrite.');
  process.exit(3);
}

console.log(`[verify] ✓ Draft verification status written to frontmatter`);
