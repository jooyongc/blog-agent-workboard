import { timedFetch as fetch } from './_lib/runtime.js';
/**
 * scripts/budget-guard.ts
 *
 * Usage: npx tsx scripts/budget-guard.ts [--site <id>]
 *
 * Exit codes:
 *   0 — OK to proceed
 *   2 — Approaching limit (≥90%)    — prints warning, still exits 0-like but flagged
 *   3 — Over limit                   — agent orchestrator must halt
 *
 * Reads month-to-date cost from the site via GET /api/admin/queue/export and
 * compares against the ceiling from sites/<id>/config.json:budget.profile.
 */

import { loadSiteConfig, resolveSiteId } from './_lib/config.js'

const SITE_ID = resolveSiteId(process.argv.slice(2))
const cfg = loadSiteConfig(SITE_ID)

const PROFILE_CEILING: Record<string, number> = {
  lean: 5.0,
  standard: 5.5,
  full: 6.5,
}
const WARN_AT = 0.9

type BudgetProfile = { profile?: string }
const profile = (cfg.budget as BudgetProfile | undefined)?.profile ?? 'lean'
const ceiling = PROFILE_CEILING[profile] ?? 5.0
const warn = ceiling * WARN_AT

const key = process.env[cfg.env.api_key]
if (!key) { console.error(`${cfg.env.api_key} missing`); process.exit(1) }

;(async () => {
  const url = `${cfg.site_url}/api/admin/queue/export?site_id=${encodeURIComponent(cfg.site_id)}&_t=${Date.now()}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    console.error(`[budget-guard] HTTP ${res.status} from ${url}`)
    console.error('[budget-guard] Cannot verify spend — stopping.')
    process.exit(1)
  }
  const data = await res.json() as {
    budget: { month_to_date_usd: number; calls_this_month: number }
  }
  const mtd = data.budget?.month_to_date_usd ?? 0
  const calls = data.budget?.calls_this_month ?? 0
  const pct = (mtd / ceiling) * 100

  console.log(`[budget-guard] site=${cfg.site_id} profile=${profile}`)
  console.log(`[budget-guard] month-to-date: $${mtd.toFixed(4)} / $${ceiling.toFixed(2)} (${pct.toFixed(1)}%, ${calls} calls)`)

  if (mtd >= ceiling) {
    console.error(`[budget-guard] OVER LIMIT — halting cycle`)
    process.exit(3)
  }
  if (mtd > warn) {
    console.warn(`[budget-guard] WARN — ≥90% of ceiling reached`)
  }
  process.exit(0)
})().catch(e => {
  console.error(`[budget-guard] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
