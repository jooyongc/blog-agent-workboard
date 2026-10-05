import { budgetedMessage } from './_lib/llm.js';
import { safeId } from './_lib/runtime.js';
import { loadSiteConfig, resolveSiteId } from './_lib/config.js';
/**
 * End-to-end pipeline for a single topic.
 * Usage: tsx scripts/pipeline-run.mts --slug=<slug> --title="..." --category=<cat>
 * Runs: SEO → Writer → Verifier → (saves drafts). Deterministic scripts are run
 * by the caller via shell afterward.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

function arg(name: string): string | null {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.slice(name.length + 3) : null
}

const cfg = loadSiteConfig(resolveSiteId(process.argv.slice(2)))
if (cfg.site_id !== 'asty-cabin') throw new Error('This legacy ASTY pipeline is not for bridge sites. Use npm run compose or bridge-import.')
const SLUG = safeId(arg('slug') ?? '')
const TOPIC = arg('title') ?? ''
const CATEGORY = arg('category') ?? ''
if (!SLUG || !TOPIC || !CATEGORY) {
  console.error('required: --slug --title --category')
  process.exit(1)
}

const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG)
fs.mkdirSync(DRAFT_DIR, { recursive: true })

const client = new Anthropic({ maxRetries: 0, timeout: 120000 })
const totals: Record<string, { in: number; out: number }> = {}

async function callHaiku(label: string, system: string, user: string, max = 4000): Promise<string> {
  const t0 = Date.now()
  const r = await budgetedMessage(client, cfg, SLUG, label, {
    model: 'claude-haiku-4-5', max_tokens: max, system,
    messages: [{ role: 'user', content: user }],
  })
  if (r.stop_reason === 'max_tokens') throw new Error(`${label}: truncated output`);
  const b = r.content[0]
  if (b.type !== 'text') throw new Error(`${label}: non-text`)
  totals[label] = { in: r.usage.input_tokens, out: r.usage.output_tokens }
  const cost = (r.usage.input_tokens + r.usage.output_tokens * 5) / 1_000_000
  console.log(`  ${label}: ${r.usage.input_tokens}in/${r.usage.output_tokens}out = $${cost.toFixed(4)} (${Date.now() - t0}ms)`)
  return b.text
}

function extractJson<T>(raw: string): T {
  let s = raw.trim()
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{')
  let depth = 0, end = -1, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  return JSON.parse(s.slice(start, end + 1)) as T
}

function extractMarkdown(raw: string): string {
  let s = raw.trim()
  // Strip any code fence lines anywhere in the doc
  s = s.replace(/^```(?:yaml|markdown|md)?\s*\n/gm, '').replace(/^```\s*$/gm, '')
  // Collapse two consecutive `---` blocks (empty outer FM before inner FM)
  s = s.replace(/^---\s*\n\s*---\s*\n/, '---\n')
  s = s.trimStart()
  const i = s.search(/(^|\n)---\s*\n/)
  if (i > 0) s = s.slice(i).replace(/^\n/, '')
  return s
}

function loadPrompt(name: string): string {
  const raw = fs.readFileSync(path.join('.claude', 'agents', `${name}.md`), 'utf8')
  return raw.replace(/^---[\s\S]*?---\s*/, '').trim()
}

console.log(`=== Pipeline for ${SLUG} (${CATEGORY}) ===`)

// SEO
console.log('Step 1: SEO')
const seoText = await callHaiku(
  'seo',
  loadPrompt('seo-researcher'),
  JSON.stringify({ topic: TOPIC, category: CATEGORY, target_audience: 'foreign visitors to Seoul', gsc_striking: [], existing_titles: [] }),
  1000,
)
const seoJson = extractJson<{ primary_keyword: string; secondary_keywords: string[] }>(seoText)
console.log(`  primary: ${seoJson.primary_keyword}`)
fs.writeFileSync(path.join(DRAFT_DIR, 'research.json'), JSON.stringify(seoJson, null, 2))

// Writer
console.log('Step 2: Writer')
const writerText = await callHaiku(
  'writer',
  loadPrompt('writer') + '\n\nCRITICAL: No tools. Return ONLY the article markdown with YAML frontmatter. Skip web_search; hedge unverified claims.',
  JSON.stringify({ topic: TOPIC, primary_keyword: seoJson.primary_keyword, secondary_keywords: seoJson.secondary_keywords, slug: SLUG, category: CATEGORY, site_voice_guide: fs.readFileSync(cfg.paths.voice_guide, 'utf8') }),
  8000,
)
let enMd = extractMarkdown(writerText)
if (!enMd.startsWith('---')) { fs.writeFileSync(path.join(DRAFT_DIR, 'writer-raw.txt'), writerText); throw new Error('missing frontmatter') }
// Auto-quote any frontmatter value that contains an unquoted colon (YAML safety)
enMd = enMd.replace(/^(---[\s\S]*?^---)/m, (fm) => {
  return fm.replace(/^(\w[\w-]*:)\s+([^"'\[\n][^\n]*:[^\n]*)$/gm, (_, k, v) => `${k} "${v.replace(/"/g, '\\"')}"`)
})
fs.writeFileSync(path.join(DRAFT_DIR, 'en.md'), enMd)
const enWords = enMd.replace(/---[\s\S]*?---/, '').split(/\s+/).filter(Boolean).length
console.log(`  ${enWords} words`)

// Verifier
console.log('Step 3: Verifier')
const verText = await callHaiku(
  'verifier',
  loadPrompt('verifier') + '\n\nCRITICAL: No tools. Return ONLY JSON. fetches_used=0.',
  JSON.stringify({ slug: SLUG, draft_markdown: enMd, research_brief: seoJson }),
  3000,
)
const verJson = extractJson<{
  overall_status: string
  summary: Record<string, number>
  claims_total: number
  citability_score?: number
  citability_band?: string
}>(verText)
// A tool-free model cannot establish external facts. Human review remains required.
if (verJson.overall_status === 'verified') verJson.overall_status = 'partial'
if (verJson.summary?.contradicted > 0) verJson.overall_status = 'blocked'
// Belt-and-suspenders: enforce 'partial' downgrade when citability is weak,
// in case the LLM forgot to apply the rule itself. 'blocked' (contradicted
// claims) always wins over 'partial'.
if (
  typeof verJson.citability_score === 'number' &&
  verJson.citability_score < 50 &&
  verJson.overall_status === 'verified'
) {
  verJson.overall_status = 'partial'
}
fs.writeFileSync(path.join(DRAFT_DIR, 'verification.json'), JSON.stringify(verJson, null, 2))
const cit = verJson.citability_score != null ? ` citability=${verJson.citability_score}` : ''
console.log(`  ${verJson.overall_status}${cit}`)

const totalIn = Object.values(totals).reduce((n, v) => n + v.in, 0)
const totalOut = Object.values(totals).reduce((n, v) => n + v.out, 0)
console.log(`LLM total: ${totalIn}in/${totalOut}out = $${((totalIn + totalOut * 5) / 1_000_000).toFixed(4)}`)
