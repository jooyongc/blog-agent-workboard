import { timedFetch as fetch } from './runtime.js';
/**
 * scripts/_lib/cost-ledger.ts
 *
 * Lightweight wrapper that logs a single LLM call's cost into the site DB
 * via POST /api/admin/costs/log. The site's budget-guard endpoint reads
 * this table to enforce $5/month/site ceilings.
 *
 * All writes are best-effort; a network failure never aborts the agent run.
 */

import type { SiteConfig } from './config.js'

/** Per-1M-token pricing (USD) for the models we use. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
}

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model]
  if (!p) throw new Error(`Unknown model pricing: ${model}`)
  return (inputTokens * p.input) / 1_000_000 + (outputTokens * p.output) / 1_000_000
}

export type CostLogEntry = {
  site_id: string
  agent: string
  phase?: string
  model: string
  input_tokens: number
  output_tokens: number
  run_id?: string
}

/**
 * Logs a single cost entry to the site DB. Non-fatal on failure.
 */
export async function logCost(cfg: SiteConfig, entry: CostLogEntry): Promise<void> {
  const key = process.env[cfg.env.api_key]
  if (!key) {
    console.warn(`[cost-ledger] ${cfg.env.api_key} missing — skipping log`)
    return
  }
  const cost = computeCostUsd(entry.model, entry.input_tokens, entry.output_tokens)
  try {
    const res = await fetch(`${cfg.site_url}/api/admin/costs/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ ...entry, cost_usd: cost }),
    })
    if (!res.ok) {
      console.warn(`[cost-ledger] HTTP ${res.status} — ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    console.warn(`[cost-ledger] network error: ${err instanceof Error ? err.message : err}`)
  }
}
