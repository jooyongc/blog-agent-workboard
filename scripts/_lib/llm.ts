import * as fs from 'node:fs';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { SiteConfig } from './config.js';
import { logCost } from './cost-ledger.js';

type Params = { model: string; max_tokens: number; system: string; messages: { role: 'user'; content: string }[] };
// Reserve a conservative upper bound before each paid request; failure does not erase spend.
export async function budgetedMessage(client: Anthropic, cfg: SiteConfig, slug: string, agent: string, params: Params) {
  if (params.model !== 'claude-haiku-4-5') throw new Error('Routine generation only permits Haiku');
  const root = 'content'; fs.mkdirSync(root, { recursive: true });
  const ledger = path.join(root, '.llm-budget.json');
  const lock = ledger + '.lock';
  const fd = fs.openSync(lock, 'wx');
  try {
    const month = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,7);
    const week = new Date(Math.floor((Date.now() + 9 * 3600000 - 4 * 86400000) / (7 * 86400000)) * 7 * 86400000).toISOString().slice(0,10);
    let data: { month: string; total: number; articles: Record<string, number>; weeks: Record<string, number> } = { month, total: 0, articles: {}, weeks: {} };
    if (fs.existsSync(ledger)) { const old = JSON.parse(fs.readFileSync(ledger, 'utf8')); if (old.month === month) data = old; }
    const amount = (Buffer.byteLength(JSON.stringify(params), 'utf8') + 512 + params.max_tokens * 5) / 1000000;
    const id = `${cfg.site_id}/${slug}`;
    if (data.total + amount > 10 || (data.articles[id] ?? 0) + amount > 0.5 || (data.weeks[week] ?? 0) + amount > 2) throw new Error('LLM budget reservation exceeds article/week/month cap');
    data.total += amount; data.articles[id] = (data.articles[id] ?? 0) + amount; data.weeks[week] = (data.weeks[week] ?? 0) + amount;
    fs.writeFileSync(ledger + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(ledger + '.tmp', ledger);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  const response = await client.messages.create(params);
  // Cost telemetry remains best-effort; the local reservation is authoritative for admission.
  if (cfg.site_id === 'asty-cabin') await logCost(cfg, { site_id: cfg.site_id, agent, model: params.model, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });
  if (response.stop_reason === 'max_tokens') throw new Error(`${agent}: output truncated`);
  return response;
}
