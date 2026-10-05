import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export function safeId(value: string, label = 'slug'): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 100)
    throw new Error(`Invalid ${label}: use lowercase letters, digits and hyphens`);
  return value;
}
export function option(args: string[], name: string): string | undefined {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i];
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`--${name} requires a value`);
  return v;
}
export function scheduleKst(now = Date.now()): string {
  const kst = new Date(now + 9 * 3600000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 2)).toISOString();
}
export async function timedFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000), redirect: 'error' });
}
export function reviewHash(dir: string): string {
  const h = createHash('sha256');
  for (const name of ['en.md','ja.md','zh.md','ko.md','meta.json','verification.json']) {
    h.update(name);
    const p = path.join(dir, name);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest('hex');
}
export function requireReview(dir: string): void {
  const p = path.join(dir, 'approval.json');
  if (!fs.existsSync(p)) throw new Error('Human review required: npm run approve-draft -- <slug> --reviewed');
  const a = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (a.hash !== reviewHash(dir)) throw new Error('Draft changed after approval; review again');
}
export function requireVerification(dir: string): void {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'verification.json'), 'utf8'));
  if (!['verified','partial'].includes(report.overall_status) || !report.summary ||
      !Number.isFinite(report.summary.contradicted) || report.summary.contradicted !== 0)
    throw new Error('Missing, invalid or blocked verification report');
}
