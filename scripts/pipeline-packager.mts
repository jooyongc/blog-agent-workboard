import { budgetedMessage } from './_lib/llm.js';
import { safeId, scheduleKst } from './_lib/runtime.js';
import { loadSiteConfig, resolveSiteId, stripSiteArg } from './_lib/config.js';
import * as fs from 'node:fs'
import * as path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

const cfg = loadSiteConfig(resolveSiteId(process.argv.slice(2)))
if (cfg.site_id !== 'asty-cabin') throw new Error('This legacy ASTY pipeline is not for bridge sites. Use npm run compose or bridge-import.')
const SLUG = safeId(stripSiteArg(process.argv.slice(2))[0] ?? '')
if (!SLUG) { console.error('Usage: tsx scripts/pipeline-packager.mts <slug>'); process.exit(1) }
const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG)

function loadPrompt(name: string): string {
  const raw = fs.readFileSync(path.join('.claude', 'agents', `${name}.md`), 'utf8')
  return raw.replace(/^---[\s\S]*?---\s*/, '').trim()
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

const enMd = fs.readFileSync(path.join(DRAFT_DIR, 'en.md'), 'utf8')
const jaMd = fs.readFileSync(path.join(DRAFT_DIR, 'ja.md'), 'utf8')
const zhMd = fs.readFileSync(path.join(DRAFT_DIR, 'zh.md'), 'utf8')

const system = loadPrompt('packager') +
  '\n\nCRITICAL: Return ONLY the meta.json content as your reply. No markdown fences, no prose.'
const input = JSON.stringify({ slug: SLUG, en_md: enMd, ja_md: jaMd, zh_md: zhMd })

const client = new Anthropic({ maxRetries: 0, timeout: 120000 })
const t0 = Date.now()
const r = await budgetedMessage(client, cfg, SLUG, 'packager', {
  model: 'claude-haiku-4-5',
  max_tokens: 2000,
  system,
  messages: [{ role: 'user', content: input }],
})
if (r.stop_reason === 'max_tokens') throw new Error('Packager output truncated')
const block = r.content[0]
if (block.type !== 'text') throw new Error('non-text')
const meta = extractJson<Record<string, unknown>>(block.text)
// compute publish date: 2 days ahead at 09:00 KST
meta.publish_at = scheduleKst()
meta.slug = SLUG
fs.writeFileSync(path.join(DRAFT_DIR, 'meta.json'), JSON.stringify(meta, null, 2))
const cost = (r.usage.input_tokens * 1 + r.usage.output_tokens * 5) / 1_000_000
console.log(`✓ meta.json saved — ${r.usage.input_tokens}in/${r.usage.output_tokens}out = $${cost.toFixed(4)} (${Date.now() - t0}ms)`)
console.log(`  publish_at: ${meta.publish_at}`)
