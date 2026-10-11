# Workboard agent harness

The user approves an idea in /topics. Only approved topic_ideas become workflows. D1 agent_workflows has a unique topic_id, stage payload checkpoints and leases; agent_steps stores individual agent execution records. The scheduler Worker is woken immediately by the authenticated approval route and periodically recovers pending work. Each Pages request executes one role, persists its output, then releases the next role.

1. Researcher: primary-source web search independently for every audience language.
2. Writer: site strategy and research become an independently authored article, with bounded structural repair.
3. Photo editor: Pexels commercial-use licensed photos, minimum two (four for Blogger), distributed through body sections. Photographer credit and license/source metadata retained. Photos are contextual illustrations, never factual proof.
4. Verifier: all claims against research plus SEO/AEO/GEO quality gate, no transmission on failure.
5. Publisher: duplicate-prevention receipts and remote private draft creation. Blogger requires Google OAuth; blocked delivery retains completed writing.

Completed roles are not regenerated on retry. Expired running leases require reconciliation. Ambiguous publisher receipts cannot be blindly replayed. Public publication is separate from this approval-to-private-draft harness. No automatic topic approval.

PEXELS_API_KEY is a Cloudflare Pages secret. Keys are not bundled into browser code. Pexels terms: https://www.pexels.com/license/ . Adobe preview assets are never treated as licensed downloads. Unsplash needs its own authorized API key and API attribution/download-event integration before becoming an active provider.

## Additional media providers

UNSPLASH_ACCESS_KEY enables official API search with mandatory photographer attribution, hotlinked returned CDN URLs and download tracking. Licensed Adobe Stock originals are listed in workboard/shared/licensed-media.json; never use expiring preview URLs as publication assets. Two photos are hosted in Pages, the licensed video is permanently stored in the existing Supabase workboard-media bucket. Only matching subjects are selected.

Set strategy.media_mode=hybrid to add Adobe Firefly conceptual imagery; strategy.generate_video also requests video. FIREFLY_SERVICES_CLIENT_ID and FIREFLY_SERVICES_CLIENT_SECRET are server secrets, FIREFLY_SERVICES_SCOPE comes from Developer Console. Firefly web login does not replace API credentials. Async status URLs and completed outputs persist in creative_requests; uncertain submissions are not repeated. Outputs are retained in workboard-media and disclosed as generated. This API adapter is tested with simulated Adobe responses; real generation remains pending API credentials. The stock-only flow stays active while credentials are absent.

## Existing Adobe web account without Firefly API entitlement

The existing organization's Developer Console shows Firefly API disabled with License required. An OAuth credential with only AdobeID/openid and Event registration does not grant generation permission. Keep API generation inactive until real Firefly API scopes are provisioned. Workspaces offers an authenticated Adobe media upload form; Adobe web-generated images and videos are persisted in workboard-media with generated provenance, topic tags and workspace isolation. Media agents reuse matching entries automatically. Stock uploads require a license reference.

## Durable execution transport

Approvals POST to the scheduler Worker's authenticated /run route, which persists a Cloudflare Queues message before returning 202. A single-concurrency queue consumer executes one persisted role per message and enqueues its successor. Long operations therefore do not depend on the browser request or a 30-second waitUntil window. Pending Firefly jobs schedule a delayed queue message; network delivery retries are bounded and a separate dead letter queue retains unresolved transport failures. The 15-minute cron checks pending work and measurements.

## Failure recovery policy

Every stop is classified when it happens and the class is persisted as `payload.last_failure` (`incomplete`, `malformed`, `evidence`, `transient`, `review`, `provider`, `media`, `connection`, `other`). Recovery reads the class, not the human-readable message; `classifyMessage` only covers checkpoints written before the class existed.

- **Automatic repeat.** `incomplete` (truncated or empty answer), `malformed` (billed answer that was not the promised JSON) and `evidence` (research found fewer than two confirmed sources) get exactly one automatic repeat per role and review round (`payload.retries["<role>/<round>"]`). The repeat runs with twice the normal output ceiling (at most 16k tokens), so a truncated answer is not simply reproduced. Safety or refusal stops are `provider` and are not repeated.
- **Unknown charges stay gated.** A repeat happens only when every `ai_runs` row made for the article since the role started has a known charge; a newer settled recheck cannot hide an earlier unknown one. Timeouts and lost connections are classified `unknown`, keep `actual = NULL` and wait for a person.
- **People win.** Recovery never repeats a role whose stopped draft an operator has since edited, checkpoints written before this policy keep the retries they already spent (`response_retries`, `format_retries`, the research transition flags), and every automatic repeat leaves a `waiting` step row that reads "자동 복구 1/1".
- **Never repeated here.** `photo_editor` keeps its own media receipts and `media_wait` flow; `publisher` keeps its delivery receipts. Neither is repeated by this policy.
- **Senior research.** The supervisor may order one research pass, and none in the last ordinary round. A request beyond that which names unverified claims becomes a deletion assignment for the editor (`converted_from: "research"`): remove those claims, add nothing new, keep two exact research URLs. A request that names no claim still stops for a person. The usual round limit and the one senior correction still apply, and unverified content still cannot be delivered.
- **Expired leases.** `expireLeases` marks the workflow, its running step row, any still-running cost reservation (which stays counted) and the content job as interrupted. Every update is limited to rows created before the expired lease ended. Interrupted roles are not replayed automatically; the Automation screen offers "중단 단계부터 재개".
- **Aside-owned workspaces** are excluded from Cloudflare recovery as well as from execution.
