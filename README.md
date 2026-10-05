# Blog Agent Workboard

[Workboard](https://blog-agent-workboard.pages.dev/) manages three active publishing workspaces: Korea Buy List on Google Blogger (English and Japanese articles), Korea by Local, and Korea Decode. Operators can add another workspace with its own site URL, article path, audience, topics, source domains, SEO/AEO/GEO strategy, connection variables, and schedule. ASTY and Naver have no active connection.

The active web app is React/Vite on Cloudflare Pages Functions (`workboard/`), with Cloudflare D1 for strategy, articles, jobs, publication receipts, OAuth tokens, media, and measurements. `scheduler/` is a separate Worker with Cloudflare Queues and a 15-minute recovery cron. The operator approves an idea; separate research, writing, photo, verification and delivery agents create a remote private draft. D1 stores every stage checkpoint, and queue messages carry execution independently of the browser. Only approved ideas enter the harness. Failed quality checks get one bounded revision; ambiguous transfers cannot be blindly retried.

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

## Media and agents

Free commercial-use photos come from configured Pexels and Unsplash APIs or licensed Adobe Stock originals. Each article includes at least two photos, source credits and retained license metadata. Adobe web-created imagery/video can be registered in Workspaces for tagged reuse. Firefly API generation is optional and currently requires an API entitlement that the existing organization does not have; ordinary web credentials are insufficient.

[Agent harness architecture](docs/AGENT-HARNESS.md) records queue execution, failure recovery, media provenance, and the optional Firefly API adapter.
