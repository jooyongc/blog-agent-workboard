import * as fs from 'node:fs';
import { loadSiteConfig, resolveSiteId } from './_lib/config.js';
import { timedFetch } from './_lib/runtime.js';
import { targetConfig, loadBridgeCredentials, supabaseConnection } from './_lib/bridge.js';
const cfg = loadSiteConfig(resolveSiteId(process.argv.slice(2)));
loadBridgeCredentials();
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) throw new Error('Node 22.12+ required; nvm use');
console.log(`site=${cfg.site_id}, languages=${cfg.languages.join(',')}`);
for (const k of ['ANTHROPIC_API_KEY', cfg.env.api_key]) console.log(`${k}: ${process.env[k] ? 'configured' : 'missing'}`);
console.log(`voice: ${fs.existsSync(cfg.paths.voice_guide) ? 'OK' : 'missing'}`);
if (process.argv.includes('--live')) {
  const res = await timedFetch(cfg.site_url);
  console.log(`public site HTTP ${res.status}`);
  if (!res.ok) process.exitCode = 1;
  const { bridge } = targetConfig(cfg.site_id);
  if (bridge.adapter === 'supabase') {
    const c = supabaseConnection(bridge);
    const res = await timedFetch(`${c.url}/rest/v1/${bridge.table}?select=id,slug,status&limit=1`, { headers: c.headers });
    console.log(`database READ ONLY HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  }
}
