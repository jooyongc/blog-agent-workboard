# Cloudflare deployment and connections

Pages project `blog-agent-workboard` serves https://blog-agent-workboard.pages.dev/. The D1 database `blog-agent-workboard` is bound as `WORKBOARD_DB` (ID `9c2cbd5f-fd44-46a8-9ceb-f007ca2a1759`). `main` builds the repository root with `npm ci && npm ci --prefix workboard && npm run build`; output is `workboard/dist`. Preview deployments do not receive production secrets.

Apply new D1 migrations before deploying new server code:

```bash
npx --prefix workboard wrangler d1 migrations apply blog-agent-workboard --remote
npm run build
npm run pages:deploy
```

Deploy the scheduler Worker separately from `scheduler/` with `wrangler deploy --config scheduler/wrangler.toml`. It needs `SCHEDULER_TOKEN`, identical to the Pages secret. It calls the latest Pages endpoint with `WORKBOARD_URL=https://blog-agent-workboard.pages.dev`. A failed run is recorded; the Worker does not infer success from a failed HTTP status.

Pages server variables:

| Variable | Purpose |
|---|---|
| `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_SECRET` | Operator login and signed session |
| `ANTHROPIC_API_KEY`, `AI_ENABLED=true` | Research, writing, and review under D1 dollar caps |
| `NATIVE_BLOG_SUPABASE_URL`, `NATIVE_BLOG_SUPABASE_KEY` | Server-side native site adapter |
| `BLOGGER_SITE_URL`, `KOREABYLOCAL_SITE_URL`, `KOREADECODE_SITE_URL` | Published site URLs, used by workspace profiles |
| `BLOGGER_CLIENT_ID`, `BLOGGER_CLIENT_SECRET` | Google OAuth web client |
| `CONNECTION_SECRET` | Encrypts the Blogger refresh token in D1; at least 32 characters |
| `SCHEDULER_TOKEN` | Private Cron endpoint token |
| `PUBLIC_WORKBOARD_URL` | Absolute generated-media URLs |

Cloudflare Workers AI is bound as `AI`; Blogger needs Google authorization via Workboard **Connections** using the exact redirect `https://blog-agent-workboard.pages.dev/api/blogger/oauth/callback`. A Blogger site is not enabled until the connection status is ready. The two native sites use their corresponding Supabase schema/table. Future sites may use the generic publishing webhook; that endpoint must return a confirmed `{id,status,url}` acknowledgment for publication. Workspace editor stores names of CF variables, never their secret values.

Each schedule is disabled by default and can be enabled after its connection is ready. Times are KST, interval is per workspace. The site profile determines published article URLs (`/guidebook/{slug}` for Korea by Local; `/blog/{slug}` for Korea Decode). New site paths can be edited. Cron checks every 15 minutes and acts only on due sites or ready jobs. Review the queue after an uncertain transfer rather than resending blindly.

Verify `GET /api/health` is 200, unauthenticated `GET /api/workspaces` is 401, the private connections screen shows expected readiness, and `/api/automation/check` is read-only. Check GitHub build status and a Pages production deployment. Do not confuse completed deployment with a confirmed public article.
