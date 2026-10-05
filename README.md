# Blog Agent Workboard

[Workboard](https://blog-agent-workboard.pages.dev/) manages three active publishing workspaces: Korea Buy List on Google Blogger (English and Japanese articles), Korea by Local, and Korea Decode. Operators can add another workspace with its own site URL, article path, audience, topics, source domains, SEO/AEO/GEO strategy, connection variables, and schedule. ASTY and Naver have no active connection.

The active web app is React/Vite on Cloudflare Pages Functions (`workboard/`), with Cloudflare D1 for strategy, articles, jobs, publication receipts, OAuth tokens, media, and measurements. `scheduler/` is a separate Cron Worker that calls the authenticated Pages scheduler endpoint every 15 minutes. A site publishes only when its own KST schedule is due, connection is ready, and each article passes independent research and quality checks. Failed or ambiguous transfers need review before a retry.

The original SEO/AEO/GEO skill and references live in `workboard/skills/seo-aeo-geo/`. The Workboard turns them into site-specific topic proposals, independent source research, direct-answer articles, visible FAQ, matching structured data, and a raw-HTML baseline with a 14-day recheck. Search Console metrics remain empty until an actual measured source is connected.

## Local development

Node 22.12+ is required. From the repository root:

```bash
npm ci
npm ci --prefix workboard
npm run typecheck
npm test
npm run workboard:test
npm run build
cp .dev.vars.example .dev.vars
npx --prefix workboard wrangler d1 migrations apply blog-agent-workboard --local
npm run pages:dev
```

Only server-side Pages bindings and secrets may hold Supabase, Google, or Anthropic credentials. `VITE_` variables are public.

[Deployment and connection settings](docs/CLOUDFLARE-PAGES.md) · [Operator workflow](docs/OPERATIONS.md). The root CLI and `dashboard/` are historical references; the Cloudflare app does not run the legacy ASTY pipeline.
