# Workboard agent harness

The user approves an idea in /topics. Only approved topic_ideas become workflows. D1 agent_workflows has a unique topic_id, stage payload checkpoints and leases; agent_steps stores individual agent execution records. The scheduler Worker is woken immediately by the authenticated approval route and periodically recovers pending work. Each Pages request executes one role, persists its output, then releases the next role.

1. Researcher: primary-source web search independently for every audience language.
2. Writer: site strategy and research become an independently authored article, with bounded structural repair.
3. Photo editor: Pexels commercial-use licensed photos, minimum two (four for Blogger), distributed through body sections. Photographer credit and license/source metadata retained. Photos are contextual illustrations, never factual proof.
4. Verifier: all claims against research plus SEO/AEO/GEO quality gate, no transmission on failure.
5. Publisher: duplicate-prevention receipts and remote private draft creation. Blogger requires Google OAuth; blocked delivery retains completed writing.

Completed roles are not regenerated on retry. Expired running leases require reconciliation. Ambiguous publisher receipts cannot be blindly replayed. Public publication is separate from this approval-to-private-draft harness. No automatic topic approval.

PEXELS_API_KEY is a Cloudflare Pages secret. Keys are not bundled into browser code. Pexels terms: https://www.pexels.com/license/ . Adobe preview assets are never treated as licensed downloads. Unsplash needs its own authorized API key and API attribution/download-event integration before becoming an active provider.
