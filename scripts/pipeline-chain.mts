import { safeId, timedFetch as fetch, requireVerification } from './_lib/runtime.js';
import { loadSiteConfig, resolveSiteId, stripSiteArg } from './_lib/config.js';
/**
 * Given an existing draft dir with en.md only, run the rest of the pipeline:
 * translate → glossary → packager → fetch-image → schema → enqueue → publish.
 *
 * Usage: tsx scripts/pipeline-chain.mts <slug>
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'

const rawArgs = process.argv.slice(2)
const SITE_ID = resolveSiteId(rawArgs)
const cfg = loadSiteConfig(SITE_ID)
if (cfg.site_id !== 'asty-cabin') throw new Error('This legacy ASTY pipeline is not for bridge sites. Use npm run compose or bridge-import.')
const SLUG = safeId(stripSiteArg(rawArgs)[0] ?? '')
if (!SLUG) { console.error('slug required'); process.exit(1) }
const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG)
const SITE_URL = cfg.site_url

function run(cmd: string, args: string[]): void {
  args.push('--site', SITE_ID)
  const r = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exit ${r.status}`)
}

function extractFieldFromRaw(fmBlock: string, key: string): string | null {
  const lines = fmBlock.split('\n')
  for (const line of lines) {
    const m = line.match(new RegExp(`^${key}:\\s*(.*)$`))
    if (!m) continue
    let v = m[1].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"')
    }
    return v
  }
  return null
}

function defensiveFixFrontmatter(): void {
  const p = path.join(DRAFT_DIR, 'en.md')
  let s = fs.readFileSync(p, 'utf8')
  // 1. Strip code fences anywhere
  s = s.replace(/^```(?:yaml|markdown|md)?\s*\n/gm, '').replace(/^```\s*$/gm, '')
  // 2. Collapse double frontmatter markers
  s = s.replace(/^---\s*\n\s*\n?---\s*\n/, '---\n')
  // 3. Strip mangled escape quotes
  s = s.replace(/\\"/g, '"')
  s = s.trimStart()

  // 4. Try parsing as-is
  let parsed: ReturnType<typeof matter> | null = null
  try { parsed = matter(s) } catch { parsed = null }

  const hasTitle = parsed && typeof parsed.data.title === 'string' && parsed.data.title.length > 0
  const hasMeta = parsed && typeof parsed.data.meta_description === 'string' && parsed.data.meta_description.length > 0

  if (parsed && hasTitle && hasMeta) {
    // Valid — normalize via matter.stringify to guarantee safe YAML for translate.ts
    const rebuilt = matter.stringify(parsed.content, parsed.data)
    fs.writeFileSync(p, rebuilt)
    return
  }

  // 5. Parse failed — manually extract critical fields & rewrite safely
  const fmMatch = s.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!fmMatch) throw new Error(`[chain] en.md has no parseable frontmatter`)
  const fmBlock = fmMatch[1]
  const body = fmMatch[2]

  const title = extractFieldFromRaw(fmBlock, 'title') ?? SLUG.replace(/-/g, ' ')
  const metaDesc = extractFieldFromRaw(fmBlock, 'meta_description') ?? title
  const slugField = extractFieldFromRaw(fmBlock, 'slug') ?? SLUG
  const lang = extractFieldFromRaw(fmBlock, 'lang') ?? 'en'
  const category = extractFieldFromRaw(fmBlock, 'category') ?? 'culture'
  const author = extractFieldFromRaw(fmBlock, 'author') ?? 'ASTY Cabin Editorial'

  let tags: string[] = []
  const tagsInline = fmBlock.match(/^tags:\s*\[([^\]]*)\]/m)
  if (tagsInline) {
    tags = tagsInline[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }

  const safeData: Record<string, unknown> = {
    slug: slugField,
    lang,
    title,
    meta_description: metaDesc,
    category,
    tags: tags.length > 0 ? tags : ['seoul', 'long-stay'],
    author,
    draft: true,
  }
  const rebuilt = matter.stringify(body.trim(), safeData)
  fs.writeFileSync(p, rebuilt)
  console.log(`[chain] frontmatter rewritten (title: "${title.slice(0, 60)}")`)
}

function stripBoldMarkers(): void {
  // AI writers often produce **bold** despite prompt rules. Strip them from the body
  // (not frontmatter) so published articles don't carry the AI-content tell.
  const p = path.join(DRAFT_DIR, 'en.md')
  const s = fs.readFileSync(p, 'utf8')
  const m = s.match(/^(---\s*\n[\s\S]*?\n---\s*\n)([\s\S]*)$/)
  if (!m) return
  const fm = m[1]
  const body = m[2].replace(/\*\*([^*]+)\*\*/g, '$1')
  if (body !== m[2]) {
    fs.writeFileSync(p, fm + body)
    console.log('[chain] stripped **bold** markers from body')
  }
}

console.log(`=== chain pipeline for ${SLUG} ===`)
defensiveFixFrontmatter()
stripBoldMarkers()

run('npx', ['tsx', 'scripts/verify-draft.ts', SLUG])
requireVerification(DRAFT_DIR)
console.log('1/7 translate')
run('npx', ['tsx', 'scripts/translate.ts', SLUG])

console.log('2/7 glossary')
run('npx', ['tsx', 'scripts/enforce-glossary.ts', SLUG])

console.log('3/7 packager')
run('npx', ['tsx', 'scripts/pipeline-packager.mts', SLUG])

console.log('4/7 fetch-image')
run('npx', ['tsx', 'scripts/fetch-image.ts', SLUG])

console.log('5/7 schema')
run('npx', ['tsx', 'scripts/generate-schema.ts', SLUG])

// --- Defensive: ensure meta_description ≥ 60 chars for all langs
console.log('6/7 meta_description check')
const metaPath = path.join(DRAFT_DIR, 'meta.json')
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
  category?: string
  publish_at?: string
  translations: Record<string, { title: string; meta_description: string; tags: string[] }>
}
const padByLang: Record<string, string> = {
  en: ' Plan your stay with our curated guide.',
  ja: ' 詳細な情報はASTYキャビン公式サイトをご覧ください。',
  'zh-hans': ' 请参阅ASTY Cabin官方网站获取详细信息,享受首尔之旅。',
}
let changed = false
for (const lang of ['en', 'ja', 'zh-hans']) {
  const t = meta.translations[lang]
  if (!t) continue
  while (t.meta_description.length < 60) {
    t.meta_description = (t.meta_description + (padByLang[lang] || '')).slice(0, 200)
    changed = true
  }
}
if (changed) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))

// --- Enqueue + publish ---
if (!rawArgs.includes('--publish')) { console.log('✓ Draft ready for human review; no external writes'); process.exit(0) }
const { requireReview } = await import('./_lib/runtime.js')
requireReview(DRAFT_DIR)
console.log('7/7 enqueue + publish')
const enMd = fs.readFileSync(path.join(DRAFT_DIR, 'en.md'), 'utf8').replace(/^---[\s\S]*?---/, '').trim()
const jaMd = fs.readFileSync(path.join(DRAFT_DIR, 'ja.md'), 'utf8').replace(/^---[\s\S]*?---/, '').trim()
const zhMd = fs.readFileSync(path.join(DRAFT_DIR, 'zh.md'), 'utf8').replace(/^---[\s\S]*?---/, '').trim()
const ver = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, 'verification.json'), 'utf8'))
// Quality score = 60% fact-verification + 40% AEO citability.
// AI engines won't cite us if claims are wrong (fact accuracy), but they also
// won't cite us if the structure is unscannable (citability). Both matter.
const factPct = ver.claims_total > 0 ? (ver.summary.verified / ver.claims_total) * 100 : 80
const citability = typeof ver.citability_score === 'number' ? ver.citability_score : 60
const qs = Math.round(factPct * 0.6 + citability * 0.4)

const key = process.env[cfg.env.api_key]
if (!key) throw new Error('ASTY_AGENT_API_KEY missing')

const enqueueRes = await fetch(`${SITE_URL}/api/admin/queue/enqueue`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    site_id: SITE_ID,
    slug: SLUG,
    draft_path: DRAFT_DIR,
    category: meta.category ?? 'culture',
    quality_score: qs,
    verification_status: ver.overall_status,
    verification_report: ver.summary,
    translations_preview: {
      en: { title: meta.translations.en.title, excerpt: enMd.slice(0, 240) },
      ja: { title: meta.translations.ja.title, excerpt: jaMd.slice(0, 160) },
      'zh-hans': { title: meta.translations['zh-hans'].title, excerpt: zhMd.slice(0, 160) },
    },
    scheduled_at: meta.publish_at,
    initial_status: 'approved',
  }),
})
if (!enqueueRes.ok) throw new Error(`enqueue failed HTTP ${enqueueRes.status}`)
console.log(`  enqueue: HTTP ${enqueueRes.status}`)

run('npx', ['tsx', 'scripts/publish.ts', SLUG])
console.log(`✓ ${SLUG} published`)
