# Blog Agent Workboard

The active product is the Cloudflare Pages Workboard under `workboard/` and the separate `scheduler/` Worker. The user's current operating sites are Korea Buy List (Blogger, independently written English and Japanese), Korea by Local, and Korea Decode. ASTY and Naver are disconnected from the active catalog and scheduler.

The older ASTY CLI and its historical instructions are retained only for reference in `docs/LEGACY-AGENTS.md`. Do not copy ASTY voice, affiliate text, translation settings, pipeline schedules, or URLs into the three active sites. Current user authorization supersedes older advice to keep Aside as Blogger scheduler: the Aside routine was paused for the Cloudflare transition.

The site-specific publishing strategy is stored in D1 `workspace_records` and editable in Workboard. Restore the SEO/AEO/GEO rules from `workboard/skills/seo-aeo-geo/` and respect verified source evidence, visible FAQ/JSON-LD parity, actual dates, raw HTML checks, and two-week measurements. Never assert that rankings or citations improved without measured data.

Before a production change: build and test `workboard`, apply D1 migrations, deploy Pages and the scheduler Worker, and verify the production route. Keep service credentials server-side. Automatic public publishing is explicitly user-authorized for correctly configured workspaces, but publication must pass research, quality, and connection checks and retain duplicate-prevention receipts.
