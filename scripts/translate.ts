import { budgetedMessage } from './_lib/llm.js';
import { safeId, timedFetch as fetch } from './_lib/runtime.js';
/**
 * scripts/translate.ts
 *
 * Usage: npx tsx scripts/translate.ts <slug>
 *
 * Cost guards (prevents runaway DeepL usage):
 *   1. Pre-flight char count. Aborts if single run > MAX_CHARS_PER_RUN.
 *   2. Local monthly tally in content/.deepl-usage.json. Aborts if over cap.
 *   3. DeepL API authoritative check — if account already exhausted, aborts.
 *   4. No retries — failures bubble up rather than silently re-billing.
 *
 * Required env:
 *   DEEPL_API_KEY
 *
 * Optional:
 *   DEEPL_GLOSSARY_JA_ID, DEEPL_GLOSSARY_ZH_ID
 *   DEEPL_MAX_CHARS_PER_RUN   default 60000
 *   DEEPL_MAX_CHARS_MONTHLY   default 450000   (safely under 500k free cap)
 */

import * as deepl from 'deepl-node';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';
import { loadSiteConfig, resolveSiteId, stripSiteArg } from './_lib/config.js';

const rawArgs = process.argv.slice(2);
const SITE_ID = resolveSiteId(rawArgs);
const cfg = loadSiteConfig(SITE_ID);

const positional = stripSiteArg(rawArgs);
const SLUG = positional[0] ? safeId(positional[0]) : '';
if (!SLUG) {
  console.error('Usage: tsx scripts/translate.ts <slug> [--site <id>]');
  process.exit(1);
}

const MAX_PER_RUN = cfg.budget?.deepl_chars_per_run
  ?? Number(process.env.DEEPL_MAX_CHARS_PER_RUN ?? 60000);
const MAX_MONTHLY = cfg.budget?.deepl_chars_monthly
  ?? Number(process.env.DEEPL_MAX_CHARS_MONTHLY ?? 450000);
const USAGE_FILE = path.join(path.dirname(cfg.paths.drafts), '.deepl-usage.json');

const DRAFT_DIR = path.join(cfg.paths.drafts, SLUG);
const EN_PATH = path.join(DRAFT_DIR, 'en.md');
if (!fs.existsSync(EN_PATH)) {
  console.error(`Source not found: ${EN_PATH}`);
  process.exit(1);
}

// DeepL key is preferred but no longer required — Haiku fallback covers the
// case where DEEPL_API_KEY is unset, exhausted, or rejects requests.
const HAS_DEEPL = !!process.env.DEEPL_API_KEY;
if (!HAS_DEEPL && !process.env.ANTHROPIC_API_KEY) {
  console.error('Neither DEEPL_API_KEY nor ANTHROPIC_API_KEY is set — at least one is required');
  process.exit(1);
}
if (!HAS_DEEPL) {
  console.warn('[translate] DEEPL_API_KEY not set — all translations will use Haiku fallback');
}
// Translator instance is only used when HAS_DEEPL is true. We construct with
// an empty string when missing to keep types simple; the code paths gate on
// HAS_DEEPL / deeplLikelyOk before calling it.
const translator = new deepl.Translator(process.env.DEEPL_API_KEY ?? 'x-deepl-not-configured', { maxRetries: 0 });

// ---- Monthly usage tracking ----
type UsageLog = { month: string; chars: number; runs: number };

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}
function loadUsage(): UsageLog {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) as UsageLog;
    if (raw.month === currentMonth()) return raw;
  } catch { /* fall through */ }
  return { month: currentMonth(), chars: 0, runs: 0 };
}
function saveUsage(u: UsageLog) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}

// ---- Markdown protection ----
type Protected = { placeholder: string; original: string };
function protectMarkdown(text: string): { protectedText: string; restore: Protected[] } {
  const restore: Protected[] = [];
  let i = 0;
  let out = text.replace(/```[\s\S]*?```/g, (m) => {
    const p = `XCODEBLOCKX${i++}X`;
    restore.push({ placeholder: p, original: m });
    return p;
  });
  out = out.replace(/`[^`\n]+`/g, (m) => {
    const p = `XINLINECODEX${i++}X`;
    restore.push({ placeholder: p, original: m });
    return p;
  });
  out = out.replace(/https?:\/\/\S+/g, (m) => {
    const p = `XURLX${i++}X`;
    restore.push({ placeholder: p, original: m });
    return p;
  });
  return { protectedText: out, restore };
}
function restoreMarkdown(text: string, restore: Protected[]): string {
  let out = text;
  for (const { placeholder, original } of restore) out = out.replaceAll(placeholder, original);
  return out;
}

type Target = {
  lang: deepl.TargetLanguageCode;
  outFile: string;
  formality: deepl.Formality;
  glossaryId?: string;
};

// ─── Haiku translator (fallback when DeepL quota is exhausted) ─────────────
// DeepL Free's 500K/mo cap can be exhausted mid-week. Rather than letting the
// weekly pipeline die, we transparently fall back to Anthropic Haiku for
// translation. Cost per article: roughly $0.03 for 2 langs (vs DeepL Free $0
// when available). Quality is slightly below DeepL for short marketing copy
// but excellent for long-form editorial markdown.

const LANG_NAME: Record<string, string> = {
  'ja': 'Japanese (natural conversational style, polite -ます/です forms)',
  'zh-HANS': 'Simplified Chinese (Mainland Mandarin, 简体字 only — never 繁体)',
  'zh-HANT': 'Traditional Chinese',
  'ko': 'Korean',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'it': 'Italian',
}

function loadGlossaryCsv(filepath: string): Array<{ en: string; tgt: string }> {
  if (!fs.existsSync(filepath)) return []
  const rows = fs.readFileSync(filepath, 'utf8').split(/\r?\n/).filter(Boolean)
  const out: Array<{ en: string; tgt: string }> = []
  for (const line of rows) {
    const idx = line.indexOf(',')
    if (idx <= 0) continue
    const en = line.slice(0, idx).trim()
    const tgt = line.slice(idx + 1).trim()
    if (en && tgt) out.push({ en, tgt })
  }
  return out
}

function buildHaikuSystemPrompt(targetLang: string, glossary: Array<{ en: string; tgt: string }>): string {
  const langDesc = LANG_NAME[targetLang] ?? targetLang
  const glossaryBlock = glossary.length > 0
    ? `\n\n## Glossary (REQUIRED — use these exact translations)\n${glossary.map((g) => `- "${g.en}" → "${g.tgt}"`).join('\n')}`
    : ''
  return `You are a professional translator. Translate the user's English text into ${langDesc}.

CRITICAL RULES:
1. Preserve markdown syntax exactly: headings (#, ##, ###), lists (-), blockquotes (>), tables (|), bold (**), italic (*), links [text](url), images, code blocks (\`\`\`).
2. DO NOT translate code blocks, inline code (\`...\`), URLs, or content inside <a href>.
3. DO NOT translate placeholder tokens that match XCODEBLOCKX[0-9]+X, XINLINECODEX[0-9]+X, XURLX[0-9]+X — leave them exactly as-is.
4. Keep the **Q: ... ** / A: ... FAQ structure intact: question text and answer text translated, but the **Q:** marker and "A:" marker stay as-is.
5. ALWAYS preserve brand names exactly as written: "ASTY Cabin" stays "ASTY Cabin" (never "ASTV Cabin", never localized). "iF Design Award" stays in English. Korean place names stay in Latin transliteration (e.g. "Garak Market Station") unless the glossary specifies otherwise.
6. Translate ONLY the actual content. NEVER prepend a label like "Title:", "标题：", "メタ:", "Meta description:" — the user's input is bare content, your output must also be bare content with NO label, NO heading, NO preamble.
7. Output ONLY the translated text. No commentary like "Here's the translation:" or "翻译:" or trailing notes.${glossaryBlock}`
}

// Strip stray prefix labels the model occasionally translates and prepends
// (e.g. "标题：", "Title:", "Meta description:"). Safety net for short outputs.
function stripLabelPrefix(s: string): string {
  return s
    .replace(/^\s*(?:title|タイトル|标题|題目|제목|meta(?:\s*description)?|メタ(?:[\s・]*description|の説明)?|元描述|元描述：|说明|描述|메타\s*설명?)\s*[:：\-—]?\s*/i, '')
    .trim()
}

async function translateWithHaiku(opts: {
  body: string
  title: string
  meta: string
  targetLang: string
  glossary: Array<{ en: string; tgt: string }>
}): Promise<{ body: string; title: string; meta: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('Haiku fallback requires ANTHROPIC_API_KEY')
  }
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120000 })
  const system = buildHaikuSystemPrompt(opts.targetLang, opts.glossary)

  async function call(prompt: string, maxTokens: number): Promise<string> {
    const msg = await budgetedMessage(client, cfg, SLUG, 'translation', {
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    })
    if (msg.stop_reason === 'max_tokens') throw new Error('Translation truncated');
    const block = msg.content[0]
    if (block.type !== 'text') throw new Error('Haiku returned non-text block')
    return block.text.trim()
  }

  // Three separate calls: title, meta, body. Each is bare content (no labels)
  // so the model has nothing to mistakenly translate as a prefix. Cost overhead
  // vs a batched call: ~$0.0001 — negligible.
  const [titleRaw, metaRaw, bodyRaw] = await Promise.all([
    call(opts.title, 400),
    call(opts.meta, 500),
    call(opts.body, 8000),
  ])

  return {
    body: bodyRaw,
    title: stripLabelPrefix(titleRaw) || opts.title,
    meta: stripLabelPrefix(metaRaw) || opts.meta,
  }
}

function isQuotaError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return msg.includes('quota') || msg.includes('billing period') || msg.includes('limit reached') || msg.includes('429')
}

// Map site config language codes to DeepL language codes + output filenames.
// Source of truth: site config `languages` array (excludes canonical_lang).
const DEEPL_LANG_MAP: Record<string, { deepl: deepl.TargetLanguageCode; file: string }> = {
  ja: { deepl: 'ja', file: 'ja.md' },
  'zh-hans': { deepl: 'zh-HANS', file: 'zh.md' },
  'zh-hant': { deepl: 'zh-HANT', file: 'zh.md' },
  ko: { deepl: 'ko', file: 'ko.md' },
  fr: { deepl: 'fr', file: 'fr.md' },
  de: { deepl: 'de', file: 'de.md' },
  es: { deepl: 'es', file: 'es.md' },
  it: { deepl: 'it', file: 'it.md' },
};

const targets: Target[] = cfg.languages
  .filter(l => l !== cfg.canonical_lang)
  .map(l => {
    const map = DEEPL_LANG_MAP[l];
    if (!map) throw new Error(`[translate] Unsupported target language in config: ${l}`);
    const glossaryEnvName = cfg.deepl?.glossary_ids?.[l];
    const formalityRaw = cfg.deepl?.formality?.[l] ?? 'default';
    return {
      lang: map.deepl,
      outFile: map.file,
      formality: formalityRaw as deepl.Formality,
      glossaryId: glossaryEnvName ? process.env[glossaryEnvName] : undefined,
    };
  });

async function run() {
  const source = fs.readFileSync(EN_PATH, 'utf8');
  const parsed = matter(source);
  const { content, data: fm } = parsed;
  const titleEn = fm.title as string;
  const metaEn = fm.meta_description as string;

  // ---- Pre-flight ----
  if (!titleEn || !metaEn || !content.trim()) throw new Error('Source requires title, meta_description and body');
  const sourceLen = content.length + titleEn.length + metaEn.length;
  const totalChars = sourceLen * targets.length;
  console.log(`[budget] source=${sourceLen} chars, × ${targets.length} langs = ${totalChars}`);

  if (![MAX_PER_RUN, MAX_MONTHLY].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid translation budget');
  if (totalChars > MAX_PER_RUN) {
    console.error(`[budget] ABORT — ${totalChars} chars exceeds per-run cap ${MAX_PER_RUN}`);
    process.exit(2);
  }

  const usage = loadUsage();
  // DeepL pre-flight is informational only — failures don't abort. If DeepL
  // is exhausted we route per-target through the Haiku fallback below.
  let deeplLikelyOk = HAS_DEEPL;
  if (HAS_DEEPL && usage.chars + totalChars > MAX_MONTHLY) {
    console.warn(`[budget] DeepL monthly cap reached. Used=${usage.chars}, would add=${totalChars}, cap=${MAX_MONTHLY}. Falling back to Haiku.`);
    deeplLikelyOk = false;
  }
  if (deeplLikelyOk) {
    try {
      const deeplUsage = await translator.getUsage();
      if (deeplUsage.character?.limitReached()) {
        console.warn('[budget] DeepL account limit reached — will fall back to Haiku for all targets');
        deeplLikelyOk = false;
      } else if (deeplUsage.character) {
        const pct = ((deeplUsage.character.count / deeplUsage.character.limit) * 100).toFixed(1);
        console.log(`[budget] DeepL account: ${deeplUsage.character.count}/${deeplUsage.character.limit} (${pct}%)`);
      }
    } catch {
      console.warn('[budget] Could not fetch DeepL account usage — proceeding with local count');
    }
  }

  const { protectedText, restore } = protectMarkdown(content);
  let totalCharsCharged = 0; // chars actually billed to DeepL (excludes Haiku fallbacks)

  for (const t of targets) {
    console.log(`\n→ Translating to ${t.lang}...`);
    let translatedBody: string | null = null;
    let translatedTitle: string | null = null;
    let translatedMeta: string | null = null;
    let translatorUsed: 'deepl' | 'haiku' = 'deepl';

    if (deeplLikelyOk) {
      try {
        usage.chars += sourceLen;
        usage.runs += 1;
        saveUsage(usage); // reserve before request: partial failures may be billable
        const [bodyRes, titleRes, metaRes] = await Promise.all([
          translator.translateText(protectedText, 'en', t.lang, {
            tagHandling: 'html',
            preserveFormatting: true,
            formality: t.formality,
            glossary: t.glossaryId,
          }),
          translator.translateText(titleEn, 'en', t.lang, { glossary: t.glossaryId }),
          translator.translateText(metaEn, 'en', t.lang, { glossary: t.glossaryId }),
        ]);
        translatedBody = restoreMarkdown(
          Array.isArray(bodyRes) ? bodyRes[0].text : bodyRes.text,
          restore,
        );
        translatedTitle = Array.isArray(titleRes) ? titleRes[0].text : titleRes.text;
        translatedMeta = Array.isArray(metaRes) ? metaRes[0].text : metaRes.text;
        totalCharsCharged += sourceLen;
        console.log(`  ✔ DeepL → ${t.lang}`);
      } catch (e) {
        if (isQuotaError(e)) {
          console.warn(`  ⚠ DeepL quota exceeded mid-run for ${t.lang} — falling back to Haiku`);
          deeplLikelyOk = false; // remaining targets go straight to Haiku
        } else {
          console.warn(`  ⚠ DeepL failed for ${t.lang} (${(e as Error).message}) — falling back to Haiku`);
        }
      }
    }

    if (translatedBody == null) {
      // Haiku fallback path. Use the unprotected source body — Haiku is told
      // to leave placeholders alone in the system prompt anyway, so protection
      // still works to keep code/URLs intact, but Haiku can read the source
      // either way; we use the protected one to keep code blocks 100% safe.
      if (process.env.ALLOW_LLM_TRANSLATION_FALLBACK !== 'true') throw new Error('DeepL unavailable. Paid fallback requires ALLOW_LLM_TRANSLATION_FALLBACK=true');
      const langKey = t.lang === 'zh-HANS' ? 'zh' : t.lang === 'zh-HANT' ? 'zh-hant' : t.lang;
      const glossaryPath = path.join(cfg.paths.glossary_dir, `${langKey}.csv`);
      const glossary = loadGlossaryCsv(glossaryPath);
      const out = await translateWithHaiku({
        body: protectedText,
        title: titleEn,
        meta: metaEn,
        targetLang: t.lang,
        glossary,
      });
      translatedBody = restoreMarkdown(out.body, restore);
      translatedTitle = out.title;
      translatedMeta = out.meta;
      translatorUsed = 'haiku';
      console.log(`  ✔ Haiku → ${t.lang} (fallback)`);
    }

    const outFm = {
      ...fm,
      lang: t.lang === 'zh-HANS' ? 'zh-hans' : t.lang === 'zh-HANT' ? 'zh-hant' : t.lang,
      title: translatedTitle,
      meta_description: translatedMeta,
      translation_review: 'pending',
      translated_from: 'en',
      translator: translatorUsed,
    };
    const outPath = path.join(DRAFT_DIR, t.outFile);
    fs.writeFileSync(outPath, matter.stringify(translatedBody, outFm));
    console.log(`  → wrote ${outPath}`);
  }

  if (totalCharsCharged > 0) {
    saveUsage(usage);
    console.log(`\n[budget] Monthly DeepL: ${usage.chars}/${MAX_MONTHLY} chars, ${usage.runs} runs (this run charged ${totalCharsCharged})`);
  } else {
    console.log(`\n[budget] All targets fell back to Haiku — DeepL chars NOT charged`);
  }
  console.log('✓ Translation complete.');
}

run().catch((e) => {
  console.error('[translate] failed:', e.message ?? e);
  process.exit(1);
});
