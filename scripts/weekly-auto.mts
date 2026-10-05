import { option, timedFetch as fetch } from './_lib/runtime.js';
import { loadSiteConfig, resolveSiteId } from './_lib/config.js';
/**
 * scripts/weekly-auto.mts
 *
 * Full automation: reads topic_queue (status='approved') from site, runs the
 * pipeline for top N topics, publishes each, marks topic_queue row 'published'.
 *
 * Designed to run under GitHub Actions cron. Safe to re-invoke — already-
 * published slugs are skipped.
 *
 * Env required:
 *   ANTHROPIC_API_KEY
 *   ASTY_AGENT_API_KEY (or whatever cfg.env.api_key points to)
 *   DEEPL_API_KEY
 *   UNSPLASH_ACCESS_KEY
 *   ASTY_SITE_URL (optional, defaults to production)
 *
 * CLI:
 *   --site=asty-cabin    (default)
 *   --limit=3            (default)
 *   --dry-run            (don't publish; stop after schema)
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const SITE_ID = resolveSiteId(args)
const cfg = loadSiteConfig(SITE_ID)
if (cfg.site_id !== 'asty-cabin') throw new Error('This legacy ASTY pipeline is not for bridge sites. Use npm run compose or bridge-import.')
const LIMIT = Number(option(args, 'limit') ?? 3)
if (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 5) throw new Error('--limit must be an integer from 1 to 5')
const DRY = args.includes('--dry-run')
const SITE_URL = cfg.site_url
const KEY = process.env[cfg.env.api_key]
if (!KEY) throw new Error(`${cfg.env.api_key} missing`)

function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function run(cmd: string, args: string[]): { ok: boolean; code: number } {
  const r = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8' })
  return { ok: r.status === 0, code: r.status ?? -1 }
}

async function fetchTopics(): Promise<Array<{ id: string; title: string; category: string; seo_score: number | null }>> {
  const res = await fetch(`${SITE_URL}/api/admin/queue/topic?site_id=${SITE_ID}&status=approved&limit=20`, {
    headers: { Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`fetchTopics ${res.status}`)
  const j = (await res.json()) as { rows: Array<{ id: string; title: string; category: string | null; seo_score: number | null }> }
  return j.rows
    .filter((r) => r.title && r.category)
    .map((r) => ({ id: r.id, title: r.title, category: r.category!, seo_score: r.seo_score }))
    .sort((a, b) => (b.seo_score ?? 0) - (a.seo_score ?? 0))
}

/**
 * Recover topics stuck in 'in_progress' from previous runs that crashed before
 * reaching the success/fail branch (most often: GitHub Actions timeout). A
 * topic older than `staleMinutes` is reverted to 'approved' so the current run
 * can pick it up.
 */
async function recoverStaleInProgress(staleMinutes = 90): Promise<number> {
  try {
    const res = await fetch(`${SITE_URL}/api/admin/queue/topic?site_id=${SITE_ID}&status=in_progress&limit=50`, {
      headers: { Authorization: `Bearer ${KEY}` },
    })
    if (!res.ok) return 0
    const j = (await res.json()) as { rows: Array<{ id: string; title: string; updated_at?: string; created_at?: string }> }
    const cutoff = Date.now() - staleMinutes * 60 * 1000
    let recovered = 0
    for (const r of j.rows) {
      const ts = new Date(r.updated_at ?? r.created_at ?? '').getTime()
      if (!Number.isFinite(ts) || ts <= 0 || ts > cutoff) continue // still recent — leave alone
      await patchTopicStatus(r.id, 'approved')
      console.log(`[weekly-auto] recovered stale in_progress → approved: ${r.title?.slice(0, 60) ?? r.id}`)
      recovered++
    }
    return recovered
  } catch {
    return 0
  }
}

async function fetchPublishedSlugs(): Promise<Set<string>> {
  const res = await fetch(`${SITE_URL}/api/admin/posts/export?limit=1000`, {
    headers: { Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`Cannot check published slugs: HTTP ${res.status}`)
  const j = (await res.json()) as { posts: Array<{ slug: string }> }
  return new Set(j.posts.map((p) => p.slug))
}

async function patchTopicStatus(id: string, status: string): Promise<void> {
  const res = await fetch(`${SITE_URL}/api/admin/queue/topic/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(`Topic status update failed: HTTP ${res.status}`)

}

async function main(): Promise<void> {
  console.log(`[weekly-auto] site=${SITE_ID} limit=${LIMIT} dry=${DRY}`)

  // Recover stale in_progress topics first — these were stuck from prior crashes
  // (GitHub Actions timeout, OOM, etc.) and would otherwise never run again.
  const recovered = DRY ? 0 : await recoverStaleInProgress(90)
  if (recovered > 0) console.log(`[weekly-auto] recovered ${recovered} stale in_progress topics`)

  const topics = await fetchTopics()
  const published = await fetchPublishedSlugs()
  console.log(`[weekly-auto] ${topics.length} approved topics in queue, ${published.size} posts already published`)

  const candidates = topics.filter((t) => !published.has(slugify(t.title))).slice(0, LIMIT)
  if (candidates.length === 0) {
    console.log('[weekly-auto] nothing to do — all approved topics already published')
    return
  }

  const results: Array<{ slug: string; title: string; status: 'success' | 'skipped' | 'failed'; detail?: string }> = []

  for (const t of candidates) {
    const slug = slugify(t.title)
    console.log(`\n========== ${slug} ==========`)
    console.log(`  title: ${t.title}`)
    console.log(`  category: ${t.category}`)

    if (DRY) { console.log(`[dry-run] would process ${slug}`); continue }
    if (fs.existsSync(path.join(cfg.paths.drafts, slug))) { console.log(`[review] draft already exists: ${slug}`); continue }
    await patchTopicStatus(t.id, 'in_progress')

    try {
      // Stage 1: SEO + Writer + Verifier via pipeline-run.mts
      const r1 = run('npx', [
        'tsx', 'scripts/pipeline-run.mts',
        `--slug=${slug}`,
        `--title=${t.title}`,
        `--category=${t.category}`,
        `--site=${SITE_ID}`,
      ])
      if (!r1.ok) throw new Error(`pipeline-run exit ${r1.code}`)

      if (DRY) {
        results.push({ slug, title: t.title, status: 'success', detail: 'stopped at writer (dry-run)' })
        continue
      }

      // Stage 2: translate → glossary → packager → image → schema → enqueue → publish
      const r2 = run('npx', ['tsx', 'scripts/pipeline-chain.mts', slug, `--site=${SITE_ID}`])
      if (!r2.ok) throw new Error(`pipeline-chain exit ${r2.code}`)

      await patchTopicStatus(t.id, 'approved') // draft remains for human review
      results.push({ slug, title: t.title, status: 'success' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[weekly-auto] ${slug} failed: ${msg}`)
      await patchTopicStatus(t.id, 'approved') // revert so next run retries
      results.push({ slug, title: t.title, status: 'failed', detail: msg })
    }
  }

  console.log('\n========== REPORT ==========')
  for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.slug}${r.detail ? ` — ${r.detail}` : ''}`)

  // Exit non-zero only if EVERYTHING failed. One failure doesn't fail the cron.
  const allFailed = results.length > 0 && results.some((r) => r.status === 'failed')
  process.exit(allFailed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
