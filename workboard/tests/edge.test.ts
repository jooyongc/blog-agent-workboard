import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { makeSession, verifySession } from "../server/auth";
import { onRequest } from "../server/router";
import { renderMarkdown, draftPayload, validateDraft } from "../server/content";
import { CATALOG, getWorkspace } from "../shared/catalog";
import type { Env } from "../server/env";
import type { DraftInput } from "../shared/types";
import { articleUrl, workspace } from "../server/registry";
import { quality, extractFaq, schema } from "../server/seo";
import { publishJob } from "../server/publication";
import { enqueueApproved } from "../server/harness";
import { insertStockPhotos } from "../server/media";
import { creativeAsset, PendingMedia } from "../server/firefly";
import { verifyGenerated } from "../server/automation";
import { plainEvidence, reconcileSources } from "../server/strategy";
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(
    fs.readFileSync(
      new URL("../migrations/0001_workboard.sql", import.meta.url),
      "utf8",
    ),
  );
  d.exec(
    fs.readFileSync(
      new URL(
        "../migrations/0002_workspaces_and_automation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  d.exec(
    fs.readFileSync(
      new URL(
        "../migrations/0003_oauth_media_measurement.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  d.exec(
    fs.readFileSync(
      new URL("../migrations/0004_direction_assistant.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const name of [
    "0005_stock_images.sql",
    "0006_agent_harness.sql",
    "0007_firefly_jobs.sql",
    "0008_media_library.sql",
  ])
    d.exec(
      fs.readFileSync(
        new URL("../migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  return {
    sqlite: d,
    binding: {
      prepare(sql: string) {
        let args: SQLInputValue[] = [];
        const s = d.prepare(sql);
        return {
          bind(...a: SQLInputValue[]) {
            args = a;
            return this;
          },
          async first() {
            return s.get(...args) ?? null;
          },
          async all() {
            return { results: s.all(...args) };
          },
          async run() {
            const r = s.run(...args);
            return { success: true, meta: { changes: Number(r.changes) } };
          },
        };
      },
    } as unknown as D1Database,
  };
}
function environment() {
  const d = db();
  const env: Env = {
    WORKBOARD_DB: d.binding,
    DASHBOARD_PASSWORD: "test-password",
    DASHBOARD_SESSION_SECRET: "test-session-secret-at-least-32-chars",
    AI_ENABLED: "true",
    NATIVE_BLOG_SUPABASE_URL: "https://agkkvtfwqmzgbrqhvohs.supabase.co",
  };
  return { d, env };
}
async function request(
  path: string,
  env: Env,
  options: RequestInit = {},
  logged = true,
) {
  const session = logged ? await makeSession(env.DASHBOARD_SESSION_SECRET) : "";
  return onRequest({
    request: new Request("https://test.pages.dev/api/" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Cookie: "workboard_session=" + session } : {}),
        ...options.headers,
      },
    }),
    env,
    waitUntil: () => {},
  });
}
test("catalog excludes retired ASTY and preserves independently authored Blogger languages", () => {
  assert.deepEqual(
    CATALOG.map((w) => w.site_id),
    ["korea-buy-list", "koreabylocal", "koreadecode"],
  );
  assert.deepEqual(getWorkspace("korea-buy-list").languages, ["en", "ja"]);
  assert.throws(() => getWorkspace("../asty-cabin"));
});
test("session is signed, expires and rejects tampering", async () => {
  const secret = "test-session-secret-at-least-32-chars";
  const token = await makeSession(secret, 100000);
  assert.ok(!token.includes(secret));
  assert.equal(await verifySession(token, secret, 100001), true);
  assert.equal(await verifySession(token, secret, 700000000), false);
  assert.equal(await verifySession(token + "x", secret, 100001), false);
  assert.equal(await verifySession(secret, secret), false);
});
test("workspace API and active selection use the same complete catalog", async () => {
  const { env } = environment();
  const res = await request("workspaces", env);
  const j = (await res.json()) as { workspaces: unknown[] };
  assert.equal(j.workspaces.length, 3);
  const select = await request("workspaces/active", env, {
    method: "POST",
    body: JSON.stringify({ site_id: "koreadecode" }),
  });
  assert.equal(select.status, 200);
  assert.match(
    select.headers.get("set-cookie") ?? "",
    /active_workspace_id=koreadecode/,
  );
  const invalid = await request("workspaces/active", env, {
    method: "POST",
    body: JSON.stringify({ site_id: "not-registered" }),
  });
  assert.equal(invalid.status, 404);
});
test("custom workspace persists and native article URLs follow each site's route", async () => {
  const { env } = environment();
  const next = structuredClone(getWorkspace("koreabylocal"));
  next.site_id = "my-new-site";
  next.name = "My New Site";
  next.site_url = "https://new.example.com";
  next.admin_url = "https://new.example.com/admin";
  next.site_url_env = "MY_NEW_SITE_URL";
  next.article_path = "/stories/{slug}";
  const created = await request("workspaces", env, {
    method: "POST",
    body: JSON.stringify(next),
  });
  assert.equal(created.status, 201);
  assert.equal(
    articleUrl(await workspace(env, "my-new-site"), "a-guide"),
    "https://new.example.com/stories/a-guide",
  );
  assert.equal(
    articleUrl(await workspace(env, "koreabylocal"), "a-guide"),
    "https://koreabylocal.com/guidebook/a-guide",
  );
  assert.equal(
    articleUrl(await workspace(env, "koreadecode"), "a-guide"),
    "https://koreadecode.com/blog/a-guide",
  );
  assert.equal(
    articleUrl(await workspace(env, "koreadecode"), "-legacy-slug-"),
    "https://koreadecode.com/blog/-legacy-slug-",
  );
  next.article_path = "https://other.example.com/{slug}";
  assert.equal(
    (
      await request("workspaces", env, {
        method: "PUT",
        body: JSON.stringify(next),
      })
    ).status,
    400,
  );
});
test("scheduler requires its own bearer token and its check never advances schedules", async () => {
  const { env, d } = environment();
  env.SCHEDULER_TOKEN = "a-long-secret-for-scheduler";
  const w = structuredClone(getWorkspace("koreabylocal"));
  w.schedule.enabled = true;
  w.schedule.next_run = "2020-01-01T00:00:00.000Z";
  d.sqlite
    .prepare("UPDATE workspace_records SET config_json=? WHERE site_id=?")
    .run(JSON.stringify(w), w.site_id);
  const before = d.sqlite
    .prepare("SELECT config_json FROM workspace_records WHERE site_id=?")
    .get(w.site_id);
  assert.equal(
    (
      await request(
        "internal/scheduler",
        env,
        { method: "POST", body: "{}" },
        false,
      )
    ).status,
    401,
  );
  const res = await request(
    "internal/scheduler",
    env,
    {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SCHEDULER_TOKEN },
      body: '{"dry_run":true}',
    },
    false,
  );
  assert.equal(res.status, 200);
  const data = (await res.json()) as { due: { site_id: string }[] };
  assert.ok(data.due.some((x) => x.site_id === w.site_id));
  assert.deepEqual(
    d.sqlite
      .prepare("SELECT config_json FROM workspace_records WHERE site_id=?")
      .get(w.site_id),
    before,
  );
});
test("FAQ schema reflects visible answers and images do not count as cited sources", () => {
  const w = getWorkspace("koreabylocal");
  const a = {
    title: "What is Seoul local culture?",
    meta_description: "A practical answer.",
    tags: [],
    primary_keyword: "Seoul local culture",
    content_md:
      "## Quick Answer\n" +
      Array(45).fill("Seoul culture is shared through daily walks.").join(" ") +
      "\n\n## What is local culture?\nIt is everyday life in Seoul.\n\n## How can visitors plan?\nUse official guides.\n\n## Where can travelers start?\nRead local maps.\n\n**Q: What is culture?**\nA: Everyday shared practice.\n\n**Q: How can I learn?**\nA: Read local guides.\n\n**Q: Where can I go?**\nA: Seoul.\n\nLast updated: 2026-10-05\n\n![Picture](https://example.com/image.jpg)",
  };
  const result = quality(a, w, "en");
  assert.ok(result.issues.some((i) => i.includes("출처")));
  const faq = extractFaq(a.content_md);
  const data = schema(
    w,
    a,
    "en",
    "https://koreabylocal.com/guidebook/test",
    "2026-10-05T00:00:00Z",
  );
  const faqSchema = data.find((x) => x["@type"] === "FAQPage") as {
    mainEntity: { name: string }[];
  };
  assert.deepEqual(
    faqSchema.mainEntity.map((x) => x.name),
    faq.map((x) => x.question),
  );
});
test("plain Q/A paragraphs from a generated article remain visible FAQ data", () => {
  const text =
    "## FAQs\n\nQ: What is banchan?\n\nA: Shared side dishes.\n\nQ: Can I ask for more?\n\nA: Ask the restaurant politely.\n\nQ: Where are chopsticks placed?\n\nA: Beside the spoon.\n\nLast updated: 2026-10-05";
  assert.deepEqual(extractFaq(text), [
    { question: "What is banchan?", answer: "Shared side dishes." },
    { question: "Can I ask for more?", answer: "Ask the restaurant politely." },
    { question: "Where are chopsticks placed?", answer: "Beside the spoon." },
  ]);
});
test("private APIs require a session and block cross-origin mutation", async () => {
  const { env } = environment();
  assert.equal((await request("workspaces", env, {}, false)).status, 401);
  assert.equal(
    (
      await request("workspaces/active", env, {
        method: "POST",
        headers: { Origin: "https://attacker.test" },
        body: JSON.stringify({ site_id: "koreadecode" }),
      })
    ).status,
    403,
  );
});
test("login succeeds with valid credentials and rejects wrong password", async () => {
  const { env } = environment();
  const wrong = await request(
    "auth/login",
    env,
    { method: "POST", body: JSON.stringify({ password: "wrong" }) },
    false,
  );
  assert.equal(wrong.status, 401);
  const good = await request(
    "auth/login",
    env,
    { method: "POST", body: JSON.stringify({ password: "test-password" }) },
    false,
  );
  assert.equal(good.status, 200);
  assert.match(good.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(good.headers.get("set-cookie") ?? "", /Secure/);
});
test("login attempts are rate limited", async () => {
  const { env } = environment();
  for (let i = 0; i < 10; i++)
    await request(
      "auth/login",
      env,
      { method: "POST", body: '{"password":"wrong"}' },
      false,
    );
  assert.equal(
    (
      await request(
        "auth/login",
        env,
        { method: "POST", body: '{"password":"wrong"}' },
        false,
      )
    ).status,
    429,
  );
});
test("untrusted markdown cannot produce executable HTML or unsafe links", () => {
  const html = renderMarkdown(
    "<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![bad](javascript:test)\n\n[safe](https://example.com)",
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('src="javascript:'));
  assert.ok(html.includes('href="https://example.com"'));
});
function draft(site_id = "koreabylocal"): DraftInput {
  return {
    request_id: "test-id",
    site_id,
    slug: "test-article",
    category:
      site_id === "koreabylocal"
        ? "NEWS"
        : site_id === "koreadecode"
          ? "News"
          : "practical",
    reviewed: true,
    translations: {
      en: {
        title: "Test Article",
        meta_description: "Test description",
        tags: [],
        content_md:
          "A reviewed draft article with a sufficiently detailed paragraph for the integration test.",
      },
    },
  };
}
test("draft payloads target the actual native schemas and stay private", () => {
  const input = draft();
  const w = validateDraft(input, getWorkspace(input.site_id));
  const payload = draftPayload(w, input);
  assert.equal(payload.status, "draft");
  assert.equal(
    "published_at" in payload ? payload.published_at : "missing",
    null,
  );
  const other = draft("koreadecode");
  assert.equal(
    draftPayload(validateDraft(other, getWorkspace(other.site_id)), other)
      .status,
    "draft",
  );
  assert.ok("writer_name" in draftPayload(getWorkspace("koreadecode"), other));
  assert.throws(() =>
    validateDraft({ ...input, reviewed: false }, getWorkspace(input.site_id)),
  );
  assert.throws(() =>
    validateDraft({ ...input, slug: "../bad" }, getWorkspace(input.site_id)),
  );
});
test("Blogger requires both independently written language drafts", async () => {
  const { env } = environment();
  const input = draft("korea-buy-list");
  const r = await request("content/draft", env, {
    method: "POST",
    body: JSON.stringify(input),
  });
  assert.equal(r.status, 400);
  input.translations.ja = {
    ...input.translations.en,
    title: "日本語の別記事",
    content_md:
      "日本語の読者に向けて独立した調査から書いた文章です。単純な英語からの機械翻訳ではありません。資料を確認してから読者に役立つ情報を記述します。",
  };
  const res = await request("content/draft", env, {
    method: "POST",
    body: JSON.stringify(input),
  });
  assert.equal(res.status, 200);
  const j = (await res.json()) as {
    mode: string;
    bundle: { translations: Record<string, unknown> };
  };
  assert.equal(j.mode, "export");
  assert.deepEqual(Object.keys(j.bundle.translations), ["en", "ja"]);
});
test("D1 transaction guard enforces article, week and month caps", () => {
  const { sqlite } = db();
  const insert = sqlite.prepare(
    "INSERT INTO ai_runs(id,article_key,month,week,reserved,status,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  insert.run("a", "article", "2026-10", "week", 0.4, "running", "date");
  assert.throws(
    () => insert.run("b", "article", "2026-10", "week", 0.2, "running", "date"),
    /article_budget/,
  );
  for (let i = 0; i < 3; i++)
    insert.run(
      "week-" + i,
      "other-" + i,
      "2026-10",
      "week",
      0.5,
      "running",
      "date",
    );
  assert.throws(
    () =>
      insert.run(
        "week-over",
        "other-last",
        "2026-10",
        "week",
        0.2,
        "running",
        "date",
      ),
    /weekly_budget/,
  );
  for (let i = 0; i < 16; i++)
    insert.run(
      "month-" + i,
      "m-" + i,
      "2026-10",
      "other-week-" + i,
      0.5,
      "running",
      "date",
    );
  assert.throws(
    () =>
      insert.run(
        "month-over",
        "fresh",
        "2026-10",
        "fresh-week",
        0.2,
        "running",
        "date",
      ),
    /monthly_budget/,
  );
});
test("retired ASTY cannot be reconnected or dispatched", async () => {
  const { env } = environment();
  const r = await request("workspaces/active", env, {
    method: "POST",
    body: JSON.stringify({ site_id: "asty-cabin" }),
  });
  assert.equal(r.status, 404);
  const old = await request("pipeline", env, { method: "POST", body: "{}" });
  assert.equal(old.status, 404);
});
test("repeat draft submission cannot duplicate remote content", async () => {
  const { env } = environment();
  env.NATIVE_BLOG_SUPABASE_KEY = "mock";
  const old = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      writes++;
      return new Response('[{"id":12,"slug":"test-article"}]', { status: 201 });
    }
    return new Response("[]");
  };
  try {
    const input = draft();
    assert.equal(
      (
        await request("content/draft", env, {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("content/draft", env, {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).status,
      200,
    );
    assert.equal(writes, 1);
    input.translations.en.title = "Changed";
    assert.equal(
      (
        await request("content/draft", env, {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).status,
      409,
    );
  } finally {
    globalThis.fetch = old;
  }
});

test("ASTY content endpoints reject removed workspaces", async () => {
  const { env } = environment();
  const r = await request("content/generate", env, {
    method: "POST",
    body: JSON.stringify({ site_id: "asty-cabin" }),
  });
  assert.equal(r.status, 404);
});
test("native publication creates a draft, then publishes at its real canonical path", async () => {
  const { env } = environment();
  env.NATIVE_BLOG_SUPABASE_KEY = "mock-secret";
  const old = globalThis.fetch;
  const calls: { method: string; url: string; body: string }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: String(init?.body ?? ""),
    });
    if (init?.method === "POST")
      return Response.json(
        [{ id: 42, slug: "test-article", status: "draft" }],
        { status: 201 },
      );
    if (init?.method === "PATCH")
      return Response.json([
        { id: 42, slug: "test-article", status: "published" },
      ]);
    return Response.json([]);
  };
  try {
    const result = await publishJob(
      env,
      getWorkspace("koreabylocal"),
      "native-job-1",
      draft(),
      "publish",
    );
    assert.equal(result.mode, "publish");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch);
    assert.match(
      patch.body,
      /https:\/\/koreabylocal\.com\/guidebook\/test-article/,
    );
    assert.equal(JSON.parse(patch.body).status, "published");
    assert.ok(patch.url.includes("status=eq.draft"));
  } finally {
    globalThis.fetch = old;
  }
});
test("uncertain Blogger second-draft response does not create duplicate posts on replay", async () => {
  const { env } = environment();
  env.BLOGGER_ACCESS_TOKEN = "mock-token";
  const input = draft("korea-buy-list");
  input.translations.ja = {
    ...input.translations.en,
    title: "日本語の記事",
    content_md:
      "日本語で書いた独立した記事の本文です。読者が日本から韓国を訪れる場合の情報を明確に説明します。",
  };
  const old = globalThis.fetch;
  let creates = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      creates++;
      if (creates === 2) return new Response("temporary", { status: 502 });
      return Response.json({
        id: "post-en",
        url: "https://koreabuylist.blogspot.com/2026/10/test.html",
      });
    }
    throw Error("No other remote call expected");
  };
  try {
    await assert.rejects(
      publishJob(
        env,
        getWorkspace("korea-buy-list"),
        "blogger-job-1",
        input,
        "publish",
      ),
    );
    await assert.rejects(
      publishJob(
        env,
        getWorkspace("korea-buy-list"),
        "blogger-job-1",
        input,
        "publish",
      ),
      /이전 전송 결과가 불명확/,
    );
    assert.equal(creates, 2);
  } finally {
    globalThis.fetch = old;
  }
});

test("director feedback is persisted separately for each workspace", async () => {
  const { env, d } = environment();
  const result = await request("topics/feedback", env, {
    method: "POST",
    body: JSON.stringify({
      site_id: "koreadecode",
      title: "Culture explained",
      rating: -1,
      context: { category: "Culture" },
    }),
  });
  assert.equal(result.status, 201);
  const rows = d.sqlite
    .prepare("SELECT site_id,rating FROM topic_feedback")
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].site_id, "koreadecode");
  assert.equal(rows[0].rating, -1);
  const invalid = await request("topics/feedback", env, {
    method: "POST",
    body: JSON.stringify({ site_id: "koreadecode", title: "test", rating: 0 }),
  });
  assert.equal(invalid.status, 400);
});

test("approval creates one durable agent workflow and no unapproved workflows", async () => {
  const { env, d } = environment();
  d.sqlite
    .prepare(
      "INSERT INTO topic_ideas(id,site_id,title,category,note,status,brief_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "approval-id",
      "koreadecode",
      "Korean food customs",
      "K-Food",
      "",
      "approved",
      "{}",
      new Date().toISOString(),
    );
  await Promise.all([enqueueApproved(env), enqueueApproved(env)]);
  assert.equal(
    d.sqlite.prepare("SELECT COUNT(*) n FROM agent_workflows").get()?.n,
    1,
  );
  assert.equal(
    d.sqlite.prepare("SELECT COUNT(*) n FROM content_jobs").get()?.n,
    1,
  );
  assert.equal(
    d.sqlite.prepare("SELECT stage FROM agent_workflows").get()?.stage,
    "researcher",
  );
});
test("stock photos retain license evidence and are distributed without repeat insertion", () => {
  const article = {
    title: "Korean food",
    meta_description: "A food guide",
    tags: [],
    content_md:
      "## Quick Answer\nIntro\n## What is it?\nFirst\n## How does it work?\nSecond\n## Why?\nThird",
  };
  const photos = [1, 2].map((i) => ({
    id: String(i),
    provider: "Pexels" as const,
    url: `https://images.pexels.com/photos/${i}/photo.jpeg`,
    page: `https://www.pexels.com/photo/${i}/`,
    photographer: "Photo author",
    photographer_url: "https://www.pexels.com/@author/",
    alt: "Food photograph",
    license_url: "https://www.pexels.com/license/",
  }));
  const result = insertStockPhotos(article, photos);
  assert.equal(result.images?.length, 2);
  assert.equal((result.content_md.match(/!\[/g) || []).length, 2);
  assert.ok(result.content_md.includes("Photo author / Pexels"));
  assert.equal(insertStockPhotos(result, photos).content_md, result.content_md);
});

test("Firefly persists async job IDs and does not submit generation twice", async () => {
  const { env } = environment();
  env.FIREFLY_SERVICES_CLIENT_ID = "test-id";
  env.FIREFLY_SERVICES_CLIENT_SECRET = "test-secret";
  env.NATIVE_BLOG_SUPABASE_KEY = "test-storage";
  const original = globalThis.fetch;
  let submissions = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("adobelogin.com"))
      return Response.json({ access_token: "mock-token" });
    if (url.endsWith("/images/generate-async")) {
      submissions++;
      return Response.json({
        statusUrl: "https://firefly-api.adobe.io/v3/status/mock-job",
      });
    }
    if (url.endsWith("/status/mock-job"))
      return Response.json({
        status: "succeeded",
        outputs: [
          { image: { url: "https://generated.s3.amazonaws.com/example.png" } },
        ],
      });
    if (url.includes("s3.amazonaws.com"))
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png" },
      });
    if (url.includes("/storage/v1/object/"))
      return Response.json({ Key: "test" });
    throw Error("Unexpected request");
  };
  try {
    await assert.rejects(
      creativeAsset(
        env,
        "workflow-image",
        "koreadecode",
        "image",
        "Concept scene",
      ),
      PendingMedia,
    );
    const result = await creativeAsset(
      env,
      "workflow-image",
      "koreadecode",
      "image",
      "Concept scene",
    );
    assert.equal(result.generated, true);
    assert.ok(result.url.includes("/object/public/workboard-media/firefly/"));
    await creativeAsset(
      env,
      "workflow-image",
      "koreadecode",
      "image",
      "Concept scene",
    );
    assert.equal(submissions, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("only licensed hosted videos become safe embedded players", () => {
  const html = renderMarkdown(
    "[Video: Seoul night](https://agkkvtfwqmzgbrqhvohs.supabase.co/storage/v1/object/public/workboard-media/adobe-stock/309209961.mov)",
  );
  assert.ok(html.includes("<video controls"));
  assert.ok(
    !renderMarkdown("[Video: bad](javascript:alert(1))").includes("<video"),
  );
});

test("queue consumer persists the successor instead of relying on request lifetime", async () => {
  const worker = (await import("../../scheduler/index")).default;
  const original = globalThis.fetch;
  let acked = 0,
    retried = 0;
  const sent: any[] = [];
  globalThis.fetch = async () => Response.json({ worked: true, waiting: true });
  try {
    await worker.queue(
      {
        messages: [
          {
            ack() {
              acked++;
            },
            retry() {
              retried++;
            },
          },
        ],
      } as any,
      {
        WORKBOARD_URL: "https://test.pages.dev",
        SCHEDULER_TOKEN: "test",
        AGENT_QUEUE: {
          async send(body: any, options: any) {
            sent.push({ body, options });
          },
        },
      } as any,
    );
    assert.equal(acked, 1);
    assert.equal(retried, 0);
    assert.equal(sent[0].options.delaySeconds, 10);
  } finally {
    globalThis.fetch = original;
  }
});

test("verifier reports the unsupported claims instead of a bare failure", async () => {
  const { env } = environment();
  env.ANTHROPIC_API_KEY = "test-key";
  const w = await workspace(env, "koreadecode");
  const evidence = {
    en: {
      sources: [
        {
          url: "https://english.visitseoul.net/a",
          claim: "residential",
          evidence: "It is a residential space.",
        },
        {
          url: "https://english.visitseoul.net/b",
          claim: "hours",
          evidence: "Hours of Operation: 10:00 ~ 17:00",
        },
      ],
    },
  };
  const draft = (md: string) =>
    ({
      request_id: "verify-test",
      site_id: "koreadecode",
      slug: "bukchon-verify-test",
      category: "Travel",
      reviewed: true,
      translations: {
        en: {
          title: "Bukchon",
          meta_description: "Bukchon rules",
          tags: [],
          content_md: md,
          images: [],
        },
      },
    }) as DraftInput;
  const original = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls++;
    return Response.json({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            passed: false,
            reason: "600 years is not in the evidence",
            claims: [
              {
                lang: "en",
                claim: "The village dates back 600 years",
                status: "unsupported",
              },
              {
                lang: "en",
                claim: "Bukchon is a residential space",
                status: "verified",
                source_url: "https://english.visitseoul.net/a",
              },
            ],
          }),
        },
      ],
    });
  };
  try {
    const foreign = await verifyGenerated(
      env,
      w,
      draft(
        "[a](https://english.visitseoul.net/a) [b](https://english.visitseoul.net/b) [x](https://example.com/x)",
      ),
      evidence,
    );
    assert.equal(foreign.passed, false);
    assert.ok(foreign.reason.includes("https://example.com/x"));
    assert.equal(modelCalls, 0);
    const report = await verifyGenerated(
      env,
      w,
      draft(
        "[a](https://english.visitseoul.net/a) [b](https://english.visitseoul.net/b)",
      ),
      evidence,
    );
    assert.equal(modelCalls, 1);
    assert.equal(report.passed, false);
    assert.equal(report.verified, 1);
    assert.deepEqual(
      report.claims.map((c) => c.claim),
      ["The village dates back 600 years"],
    );
    assert.ok(report.reason.includes("600 years"));
  } finally {
    globalThis.fetch = original;
  }
});

test("research citation markup is stripped at the source and blocked in articles", async () => {
  const cleaned = plainEvidence({
    brief: "Bukchon is residential.",
    sources: [
      {
        url: "https://english.visitseoul.net/a",
        claim: "residential",
        evidence:
          '<cite index="1-1">It is important to remember that Bukchon is still a residential space.</cite>',
      },
    ],
    unsupported: ['(cite index="2-3">600 years</cite> is not sourced'],
  });
  assert.equal(
    cleaned.sources[0].evidence,
    "It is important to remember that Bukchon is still a residential space.",
  );
  assert.equal(cleaned.unsupported[0], "600 years is not sourced");
  const { env } = environment();
  const w = await workspace(env, "koreadecode");
  const base = {
    title: "What is Bukchon?",
    meta_description: "Bukchon explained",
    tags: [],
    primary_keyword: "Bukchon",
    images: [],
  };
  const body =
    "## Quick Answer\n\n" +
    Array(45).fill("word").join(" ") +
    "\n\n## What is Bukchon?\n\nBukchon is a neighborhood. [a](https://english.visitseoul.net/a) [b](https://english.visitseoul.net/b)\n\n## Why does it matter?\n\nIt is residential.\n\n## How do visitors behave?\n\nQuietly.\n\nLast updated: 2026-10-05\n\n## FAQ\n\nQ: One?\nA: Yes.\n\nQ: Two?\nA: Yes.\n\nQ: Three?\nA: Yes.\n";
  const clean = quality({ ...base, content_md: body }, w, "en");
  const leaked = quality(
    {
      ...base,
      content_md: body.replace(
        "It is residential.",
        '<cite index="1-1">It is residential.</cite>',
      ),
    },
    w,
    "en",
  );
  assert.ok(!clean.issues.some((i) => i.includes("<cite>")));
  assert.ok(leaked.issues.some((i) => i.includes("<cite>")));
  assert.equal(leaked.passed, false);
});

test("research sources are reconciled against actual search results deterministically", () => {
  const evidence = [
    "https://english.visitseoul.net/attractions/Bukchon-Hanok-Village_/263",
    "https://english.visitkorea.or.kr/svc/contents/contentsView.do?vcontsId=215658&menuSn=351",
    "http://www.english.visitseoul.net/tours/Bukchon/ENN000855/",
  ];
  const out = reconcileSources(
    [
      {
        url: "https://english.visitseoul.net/attractions/Bukchon-Hanok-Village_/263/",
        claim: "a",
        evidence: "x",
      },
      {
        url: "https://english.visitkorea.or.kr/svc/contents/contentsView.do?menuSn=351&vcontsId=215658",
        claim: "b",
        evidence: "y",
      },
      {
        url: "https://english.visitseoul.net/tours/Bukchon/ENN000855",
        claim: "c",
        evidence: "z",
      },
      {
        url: "https://english.visitseoul.net/made-up/page",
        claim: "d",
        evidence: "w",
      },
      { url: "https://example.com/x", claim: "e", evidence: "v" },
      {
        url: "https://english.visitseoul.net/attractions/Bukchon-Hanok-Village_/263",
        claim: "f",
        evidence: "",
      },
    ],
    evidence,
    ["english.visitkorea.or.kr", "english.visitseoul.net"],
  );
  assert.equal(out.accepted.length, 3);
  assert.equal(out.distinct, 3);
  assert.equal(out.searched, 3);
  assert.equal(
    out.accepted[2].url,
    "http://www.english.visitseoul.net/tours/Bukchon/ENN000855/",
  );
  assert.deepEqual(
    out.rejected.map((r) => r.reason),
    ["검색 결과에 없음", "검색 결과에 없음", "근거 인용 없음"],
  );
  assert.equal(reconcileSources([], [], []).distinct, 0);
  assert.equal(
    reconcileSources(
      [{ url: "https://english.visitseoul.net/x", claim: "a", evidence: "e" }],
      [
        "https://english.visitseoul.net/x",
        "https://english.visitseoul.net/x#top",
      ],
      ["english.visitseoul.net"],
    ).searched,
    1,
  );
});

test("a title cannot be approved twice while its agent run is active", async () => {
  const { env } = environment();
  const body = JSON.stringify({
    site_id: "koreadecode",
    title: "Korean tea houses in Seoul",
    category: "Culture",
    status: "approved",
  });
  const first = await request("topics", env, { method: "POST", body });
  assert.equal(first.status, 201);
  const second = await request("topics", env, { method: "POST", body });
  assert.equal(second.status, 409);
  const proposed = await request("topics", env, {
    method: "POST",
    body: JSON.stringify({
      site_id: "koreadecode",
      title: "Korean tea houses in Seoul",
      category: "Culture",
    }),
  });
  assert.equal(proposed.status, 201);
});
