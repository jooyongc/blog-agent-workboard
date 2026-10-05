# Blog Agent — Multi-site Bridge

2026-10-05 복구 버전. 운영 대상은 Korea Buy List(Blogger, EN/JA), Korea by Local(EN), Korea Decode(EN)입니다. 기존 ASTY 파이프라인은 별도 유지합니다.

[운영 가이드](docs/OPERATIONS.md) · [전체 점검 기록](docs/AUDIT-2026-10-05.md) · [aside 연결](docs/ASIDE-BRIDGE-HANDOFF.md)

Node 22.12+에서 `nvm use`, `npm ci`, `npm run typecheck`, `npm test`로 시작합니다. 실제 생성 및 전송 절차는 운영 가이드를 따릅니다. 새 브릿지는 기본적으로 bundle 생성 또는 원격 초안 저장이며 공개 게시는 기존 관리 화면에서 진행합니다.

아래는 기존 ASTY 설계 기록입니다. 비용 예상·자동화·예전 quick-start 설명은 현재 운영 가이드를 우선합니다.

---

# ASTY Cabin Blog Agent — Lean Edition

**Monthly budget: under $10.** Actual expected spend: **$3–$5/month** for 12 posts.

Trilingual (EN / JA / ZH-hans) blog automation for ASTY Cabin using Claude Haiku 4.5.

---

## Cost breakdown

| Component | Cost |
|---|---|
| Claude API (Haiku 4.5) | ~$0.10–$0.15 per article × 12 = **$1.20–$1.80/mo** |
| DeepL | Free tier (500k chars/mo, we use ~180k) = **$0** |
| Unsplash | Free (50 req/hr, we use 3) = **$0** |
| Supabase | Free tier = **$0** |
| Cloudflare Workers | Free tier = **$0** |
| GitHub Actions | Free for public repos = **$0** |
| Optional `/polish` with Sonnet | $0.20–$0.30 per use. If used 10×/month: **$2.00–$3.00** |
| **TOTAL** | **$1.20–$5/month** |

Hard guardrails prevent spend above $10 even in worst-case.

---

## Architecture (lean)

**2 subagents instead of 5**:
- `writer` — researches, drafts, self-edits, saves (1 call, Haiku)
- `packager` — generates multi-lang SEO metadata (1 call, Haiku)

**3 deterministic scripts** (no LLM cost):
- `translate.ts` — DeepL with glossary
- `enforce-glossary.ts` — replaces "translator-reviewer" agent via regex rules
- `fetch-image.ts` — Unsplash search
- `publish.ts` — POST to site API

**1 weekly batch run** instead of 4× per week separate cron jobs.

---

## Flow

```
Sunday 21:00 KST (GitHub Actions)
  │
  ├─ Read topics/manual-queue.md, select 3
  │
  ├─ For each topic:
  │    writer (Haiku, 1 call) → en.md
  │    translate.ts (DeepL, free) → ja.md, zh.md
  │    enforce-glossary.ts (local, free) → cleanup + warnings
  │    packager (Haiku, 1 call) → meta.json
  │    fetch-image.ts (Unsplash, free) → image URL
  │
  └─ Commit drafts to repo

Monday morning (Human)
  │
  ├─ Review drafts/ folder
  ├─ Optional: /polish <slug> for high-stakes articles (costs $0.30)
  └─ Run /publish <slug> for each → site
```

---

## Quick start

```bash
# 1. Install
npm install
npm install -g @anthropic-ai/claude-code

# 2. Configure
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY, DEEPL_API_KEY, UNSPLASH_ACCESS_KEY,
#         ASTY_SITE_URL, ASTY_AGENT_API_KEY

# 3. One-time glossary setup
npx tsx scripts/setup-glossaries.ts
# Paste printed IDs into .env as DEEPL_GLOSSARY_JA_ID / DEEPL_GLOSSARY_ZH_ID

# 4. Test locally
claude --model claude-haiku-4-5
> /weekly
# Wait for 3 drafts to be created

# 5. Review and publish
> /publish first-slug
> /publish second-slug
> /publish third-slug
```

---

## Cost guardrails

### 1. Model selection (CLAUDE.md enforced)
- Default: Haiku 4.5 ($1/$5 per MTok)
- Sonnet 4.6 only via explicit `/polish` command
- Never Opus

### 2. Subagent call limits
- `writer`: 1 call per article, max 3 web searches
- `packager`: 1 call per article, no web searches
- Total per article: 2 LLM calls × ~20K input / ~4K output tokens = ~$0.10

### 3. Deterministic replacements for expensive agents
- Translation review → `enforce-glossary.ts` (regex, not LLM)
- Fact-checking → integrated into writer (3 searches max)
- Curation → inline in `/weekly`, no separate agent

### 4. Anthropic Console spend limits (recommended)
Set a hard monthly cap at https://console.anthropic.com/settings/limits
- Suggested: $15/month hard limit
- Gives you margin above expected $5 actual spend

### 5. DeepL script caps
- Per-run: 40,000 chars (enforced in translate.ts)
- Monthly: 450,000 chars (enforced in translate.ts)
- Free tier: 500,000 chars/month (DeepL's limit)

### 6. GitHub Actions caps
- `timeout-minutes: 20`
- `concurrency: blog-agent-lean` prevents duplicate runs
- Only 1 scheduled run per week (Sunday)

---

## Project structure

```
.
├── CLAUDE.md                        # Voice + budget rules (lean)
├── .claude/
│   ├── agents/
│   │   ├── writer.md                # Haiku, integrated research+draft+edit
│   │   └── packager.md              # Haiku, metadata generation
│   └── commands/
│       ├── weekly.md                # Full weekly pipeline (main command)
│       ├── publish.md               # Manual publish trigger
│       └── polish.md                # Optional Sonnet upgrade
├── content/
│   ├── drafts/<slug>/
│   └── published/<slug>/
├── topics/manual-queue.md
├── glossary/
│   ├── ja.csv
│   └── zh.csv
├── scripts/
│   ├── setup-glossaries.ts
│   ├── translate.ts                 # DeepL with cost guards
│   ├── enforce-glossary.ts          # Replaces translator-reviewer agent
│   ├── fetch-image.ts               # Unsplash
│   └── publish.ts                   # Site API
├── site-files/                      # For ASTY Cabin Next.js repo
│   ├── drizzle-schema-blog.ts
│   ├── api-route-multilang.ts
│   └── APPLY-TO-SITE.md
└── .github/workflows/
    └── blog-agent.yml               # Weekly only
```

---

## What I cut to save money

| Removed | Why it's OK |
|---|---|
| `editor` subagent | Writer self-edits in-prompt; costs zero extra |
| `translator-reviewer` subagent | `enforce-glossary.ts` catches 90% via regex |
| `curator` subagent | Simple queue picking fits inline in `/weekly` |
| `seo` subagent | Merged into `packager` (was redundant) |
| Separate cron for curate/publish | Weekly batch + manual publish is simpler and cheaper |
| Opus usage | Haiku 4.5 is good enough for this voice and length |

---

## Troubleshooting

**"Monthly spend approaching $10"** — Check Anthropic Console dashboard. Common cause:
- Running `/polish` too often (budget $0.30 × N)
- Running `/weekly` multiple times (each run ≈ $1.50 if full 3 articles)
- Writer making more than 3 searches per article (should be blocked by CLAUDE.md but verify)

**"Translation quality dropped"** — Check `review_warnings` in ja.md/zh.md frontmatter.
- If hangul leaking to ja: add entries to glossary/ja.csv
- If 繁体 in zh: add entries to glossary/zh.csv
- Re-run `enforce-glossary.ts <slug>`

**"Writer produces thin articles"** — Haiku 4.5 can produce shorter content.
- Try `/polish <slug>` for the specific article (Sonnet upgrade, $0.30)
- If consistently too short, switch `model` in `.claude/agents/writer.md` to `claude-sonnet-4-6` (×3 cost but still <$10/mo)

---

## When to upgrade to Sonnet

Switch `writer.md` model field to `claude-sonnet-4-6` only if:
- Haiku quality is consistently unacceptable after 2 weeks of trials
- You can afford ~$5–$8/month instead of $2
- High-stakes categories (medical, corporate) dominate your content

Cost: ~$0.30/article × 12 = ~$3.60/month for writer. Still under $10.
