import fs from 'fs'
import path from 'path'
import { decrypt } from './crypto'
import { listWorkspaces, type Workspace } from './workspaces-client'

/**
 * Site config used across the dashboard. Either comes from:
 *  1. The `dashboard_workspaces` table (preferred, via workspaces-client),
 *  2. Sibling `sites/<id>/config.json` files (legacy local-dev),
 *  3. `FALLBACK_SITES` (bootstrap — asty-cabin only).
 *
 * `encryptedApiKey` is set for workspaces coming from (1). For the bootstrap
 * site, the bearer is read directly from env via `env.api_key`.
 */

export type SiteConfig = {
  site_id: string
  site_url: string
  env: { api_key: string }
  languages: string[]
  canonical_lang: string
  categories: string[]
  deepl?: {
    glossary_ids?: Record<string, string>
    formality?: Record<string, string>
  }
  paths: {
    glossary_dir: string
    topic_queue: string
    voice_guide: string
    drafts: string
    published: string
    affiliate_file?: string
  }
  budget?: {
    deepl_chars_per_run?: number
    deepl_chars_monthly?: number
    profile?: 'lean' | 'standard' | 'full'
  }
  encryptedApiKey?: string
  active?: boolean
}

function resolveSitesDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), '..', 'sites'),
    path.resolve(process.cwd(), 'sites'),
    path.resolve(process.cwd(), '..', '..', 'sites'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p
  }
  return null
}

// Bootstrap config: asty-cabin always available even if control plane is down.
const FALLBACK_SITES: SiteConfig[] = [
  {
    site_id: 'asty-cabin',
    site_url: 'https://asty-cabin-check.vercel.app',
    env: { api_key: 'ASTY_AGENT_API_KEY' },
    languages: ['en', 'ja', 'zh-hans'],
    canonical_lang: 'en',
    categories: [
      'medical', 'beauty', 'food', 'leisure',
      'transport', 'family', 'corporate', 'culture',
    ],
    deepl: {
      glossary_ids: { ja: 'DEEPL_GLOSSARY_JA_ID', 'zh-hans': 'DEEPL_GLOSSARY_ZH_ID' },
      formality: { ja: 'more', 'zh-hans': 'default' },
    },
    paths: {
      glossary_dir: 'glossary',
      topic_queue: 'topics/manual-queue.md',
      voice_guide: 'sites/asty-cabin/VOICE.md',
      drafts: 'content/drafts',
      published: 'content/published',
      affiliate_file: 'affiliate/links.json',
    },
    budget: { deepl_chars_per_run: 40000, deepl_chars_monthly: 450000, profile: 'lean' },
    active: true,
  },
]

function workspaceToSiteConfig(w: Workspace): SiteConfig {
  return {
    site_id: w.site_id,
    site_url: w.site_url,
    env: { api_key: w.site_id === 'asty-cabin' ? 'ASTY_AGENT_API_KEY' : '' },
    languages: w.languages,
    canonical_lang: w.canonical_lang,
    categories: w.categories,
    paths: {
      glossary_dir: 'glossary',
      topic_queue: 'topics/manual-queue.md',
      voice_guide: `sites/${w.site_id}/VOICE.md`,
      drafts: 'content/drafts',
      published: 'content/published',
    },
    budget: { profile: w.profile },
    encryptedApiKey: w.encrypted_api_key ?? undefined,
    active: w.active,
  }
}

function readFilesystemSites(): SiteConfig[] {
  const dir = resolveSitesDir()
  if (!dir) return []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
    const result: SiteConfig[] = []
    for (const e of entries) {
      const cfgPath = path.join(dir, e.name, 'config.json')
      if (!fs.existsSync(cfgPath)) continue
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as SiteConfig
        // Bridge targets use their native storage adapters, not ASTY admin endpoints.
        if (!('bridge' in cfg)) result.push(cfg)
      } catch {
        // skip invalid configs
      }
    }
    return result
  } catch {
    return []
  }
}

/**
 * Server-side site list. Priority:
 *   1. Control plane (dashboard_workspaces table) — remote HTTP call
 *   2. Local filesystem `sites/<id>/config.json` — legacy dev environment
 *   3. FALLBACK_SITES — bootstrap (asty-cabin only)
 */
export async function listSites(
  options?: { includeInactive?: boolean },
): Promise<SiteConfig[]> {
  const includeInactive = options?.includeInactive ?? false

  const workspaces = await listWorkspaces()
  if (workspaces.length > 0) {
    const filtered = includeInactive ? workspaces : workspaces.filter((w) => w.active)
    return filtered
      .map(workspaceToSiteConfig)
      .sort((a, b) => a.site_id.localeCompare(b.site_id))
  }

  const fsConfigs = readFilesystemSites()
  if (fsConfigs.length > 0) return fsConfigs.sort((a, b) => a.site_id.localeCompare(b.site_id))

  return FALLBACK_SITES
}

export async function getSite(id: string): Promise<SiteConfig | null> {
  const all = await listSites({ includeInactive: true })
  return all.find((s) => s.site_id === id) ?? null
}

/**
 * Resolves the Bearer token for any workspace.
 *  - Bootstrap site (`asty-cabin` or any config where env.api_key=ASTY_AGENT_API_KEY):
 *    read directly from process.env.
 *  - All other workspaces: decrypt their AES-256-GCM ciphertext (AAD=site_id).
 *
 * Throws on any failure — callers should convert to HTTP errors with
 * narrow, non-sensitive messages.
 */
export async function getSiteBearer(site: SiteConfig): Promise<string> {
  if (site.site_id === 'asty-cabin' || site.env.api_key === 'ASTY_AGENT_API_KEY') {
    const key = process.env.ASTY_AGENT_API_KEY
    if (!key) throw new Error('ASTY_AGENT_API_KEY not set on dashboard')
    return key
  }
  if (!site.encryptedApiKey) {
    throw new Error(`workspace ${site.site_id} has no encrypted_api_key — cannot authenticate`)
  }
  try {
    return decrypt(site.encryptedApiKey, site.site_id)
  } catch (e) {
    throw new Error(`decrypt failed for ${site.site_id}: ${(e as Error).message}`)
  }
}

/**
 * Reads the local DeepL usage JSON (if dashboard is deployed alongside agent repo).
 */
export function readDeeplUsage(): { month: string; chars: number; runs: number } | null {
  const candidates = [
    path.resolve(process.cwd(), '..', 'content', '.deepl-usage.json'),
    path.resolve(process.cwd(), 'content', '.deepl-usage.json'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
      catch { return null }
    }
  }
  return null
}

/**
 * Lists report files generated by agent scripts. Accepts `.md` (human-readable
 * summaries from score-posts.ts) AND `.json` (machine-readable outputs from
 * check-freshness.ts and future report writers). The /reports page classifies
 * each by filename prefix for display.
 *
 * Returns latest first.
 */
export function listReports(): Array<{ name: string; path: string; mtime: number }> {
  const candidates = [
    path.resolve(process.cwd(), '..', 'reports'),
    path.resolve(process.cwd(), 'reports'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md') || f.endsWith('.json'))
        .map((f) => {
          const full = path.join(dir, f)
          return { name: f, path: full, mtime: fs.statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
    }
  }
  return []
}
