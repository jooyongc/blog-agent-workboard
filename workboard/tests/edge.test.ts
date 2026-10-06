import { test } from "node:test";
import { getPosts } from "../server/content";
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
import { googleCredentials } from "../server/oauth";
import { publishJob } from "../server/publication";
import { prepareForReview, validateSupervision, articleFingerprint, SUPERVISOR_MODEL } from "../server/supervisor";
import { modelJson, BudgetWait, budgetReset } from "../server/model";
import {
  advanceHarness,
  enqueueApproved,
  canRepairAgain,
  planRepair,
  recoverWorkflows,
} from "../server/harness";
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
    "0009_budget_settings.sql",
    "0010_workspace_budgets.sql",
    "0011_supervisor_model.sql",
  ])
    d.exec(
      fs.readFileSync(
        new URL("../migrations/" + name, import.meta.url),
        "utf8",
      ),
    );
  d.exec("UPDATE workspace_budget_settings SET monthly=10,weekly=2,article=0.5,revision=1 WHERE site_id<>'workboard-diagnostic'");
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
  insert.run("a", "koreabylocal/article", "2026-10", "week", 0.4, "running", "date");
  assert.throws(
    () => insert.run("b", "koreabylocal/article", "2026-10", "week", 0.2, "running", "date"),
    /article_budget/,
  );
  for (let i = 0; i < 3; i++)
    insert.run(
      "week-" + i,
      "koreabylocal/other-" + i,
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
        "koreabylocal/other-last",
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
      "koreabylocal/m-" + i,
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
        "koreabylocal/fresh",
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
  let row:any=null;
  globalThis.fetch = async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: String(init?.body ?? ""),
    });
    if(init?.method==="POST") {row={...JSON.parse(String(init.body)),id:42,updated_at:"2026-10-06T00:00:00Z"};return Response.json([row],{status:201});}
    if(init?.method==="PATCH") {row={...row,...JSON.parse(String(init.body))};return Response.json([row]);}
    return Response.json(row?[row]:[]);
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
      calls.find(c=>c.method==="POST")!.body,
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

test("verification repair is bounded: one rewrite, a second only when claims decreased", () => {
  assert.equal(canRepairAgain(0, undefined, 3), true);
  assert.equal(canRepairAgain(1, 3, 1), true);
  assert.equal(canRepairAgain(1, 3, 3), false);
  assert.equal(canRepairAgain(1, 1, 2), false);
  assert.equal(canRepairAgain(1, undefined, 1), false);
  assert.equal(canRepairAgain(2, 3, 1), false);
});

test("research reconciliation never substitutes a different article query ID", () => {
  const out = reconcileSources(
    [
      {
        url: "https://english.visitkorea.or.kr/svc/contents/contentsView.do?vcontsId=999",
        claim: "wrong story",
        evidence: "text",
      },
    ],
    [
      "https://english.visitkorea.or.kr/svc/contents/contentsView.do?vcontsId=123",
    ],
    ["english.visitkorea.or.kr"],
  );
  assert.equal(out.accepted.length, 0);
});
test("Google OAuth rejects wrong identifiers and trims credential whitespace", () => {
  const { env } = environment();
  const w = structuredClone(CATALOG[0]);
  env.BLOGGER_CLIENT_ID = "wrong-provider-key";
  env.BLOGGER_CLIENT_SECRET = "secret";
  assert.throws(() => googleCredentials(env, w), /Google OAuth/);
  env.BLOGGER_CLIENT_ID = " 12345-valid_web_client.apps.googleusercontent.com ";
  env.BLOGGER_CLIENT_SECRET = " secret ";
  assert.deepEqual(googleCredentials(env, w), {
    client: "12345-valid_web_client.apps.googleusercontent.com",
    secret: "secret",
  });
});

test("confirmed rejected model requests release reservations without inventing paid usage", async () => {
  const { env, d } = environment();
  env.ANTHROPIC_API_KEY = "test-key";
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: "bad request" }, { status: 400 });
  try {
    await assert.rejects(modelJson(env, "koreabylocal/test-budget", "system", {}));
    const row = d.sqlite
      .prepare(
        "SELECT reserved,actual,status FROM ai_runs WHERE article_key='koreabylocal/test-budget'",
      )
      .get();
    assert.equal(row?.reserved, 0);
    assert.equal(row?.actual, 0);
    assert.equal(row?.status, "failed");
  } finally {
    globalThis.fetch = original;
  }
});
test("publisher checks current article quality before any remote delivery", async () => {
  const { env, d } = environment();
  const now = new Date().toISOString();
  const input = {
    site_id: "koreadecode",
    slug: "test-publisher",
    category: "Culture",
    request_id: "publisher-check",
    reviewed: true,
    translations: {
      en: {
        title: "test",
        meta_description: "test",
        tags: [],
        content_md: "too short",
      },
    },
  };
  d.sqlite
    .prepare(
      "INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES(?,?,?,'publisher','pending',?,?,?)",
    )
    .run(
      "publisher-check",
      "test-topic",
      "koreadecode",
      JSON.stringify({ input, quality: { factual: true } }),
      now,
      now,
    );
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("Remote delivery should not happen");
  };
  try {
    const result = await advanceHarness(env);
    assert.ok("error" in result);
    assert.equal(
      d.sqlite
        .prepare(
          "SELECT status FROM agent_workflows WHERE job_id='publisher-check'",
        )
        .get()?.status,
      "failed",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("connected Blogger lists draft and live posts with ADMIN view", async () => {
  const { env } = environment();
  env.BLOGGER_ACCESS_TOKEN = "test-token";
  const w = structuredClone(CATALOG[0]);
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    assert.equal(u.searchParams.get("view"), "ADMIN");
    assert.deepEqual(u.searchParams.getAll("status"), [
      "draft",
      "live",
      "scheduled",
    ]);
    return Response.json({
      items: [
        {
          id: "draft-id",
          title: "日本語 draft",
          labels: ["日本語"],
          status: "DRAFT",
          published: "2026-10-06",
          updated: "2026-10-06",
          url: "https://example.blogspot.com/draft",
        },
        {
          id: "live-id",
          title: "English live",
          labels: ["English"],
          status: "LIVE",
          published: "2026-10-06",
          updated: "2026-10-06",
          url: "https://example.blogspot.com/live",
        },
      ],
    });
  };
  try {
    const result = await getPosts(w, env);
    assert.equal(result.posts[0].status, "draft");
    assert.equal(result.posts[0].canonicalLang, "ja");
    assert.ok(result.posts[0].url?.includes("blogger.com/blog/post/edit"));
    assert.equal(result.posts[1].status, "published");
  } finally {
    globalThis.fetch = original;
  }
});
test("Blogger private draft packaging verifies ADMIN view and replay keeps IDs", async () => {
  const { env } = environment();
  env.BLOGGER_ACCESS_TOKEN = "test-token";
  const w = structuredClone(CATALOG[0]);
  const original = globalThis.fetch;
  let creations = 0;
  const rows = new Map<string, any>();
  const input = {
    site_id: w.site_id,
    slug: "bilingual-draft",
    category: w.categories[0],
    request_id: "admin-draft",
    reviewed: true,
    translations: Object.fromEntries(
      w.languages.map((lang) => [
        lang,
        {
          title: lang + " article",
          meta_description: "description",
          tags: [],
          content_md: "## Quick Answer\nA short introductory answer.",
        },
      ]),
    ),
  } as DraftInput;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = String(++creations);
      const row = {
        ...body,
        id,
        url: "https://example.blogspot.com/" + id,
        status: "DRAFT",
      };
      rows.set(id, row);
      return Response.json(row);
    }
    const id = u.pathname.split("/").pop()!;
    if (init?.method === "PUT") {
      rows.set(id, { ...rows.get(id), ...JSON.parse(String(init.body)) });
      return Response.json(rows.get(id));
    }
    assert.equal(u.searchParams.get("view"), "ADMIN");
    return Response.json(rows.get(id));
  };
  try {
    const first = await publishJob(env, w, "admin-draft", input, "draft");
    const second = await publishJob(env, w, "admin-draft", input, "draft");
    assert.equal(creations, 2);
    assert.deepEqual(first.posts, second.posts);
  } finally {
    globalThis.fetch = original;
  }
});

test("Japanese labels never make an English article pass Japanese quality", async () => {
  const { env } = environment();
  const w = await workspace(env, "korea-buy-list");
  const article = {
    title: "Korea Duty-Free Shopping",
    meta_description: "English description of Korean tax refunds",
    tags: [],
    content_md:
      "## Quick Answer\n" +
      Array(50).fill("English").join(" ") +
      "\n## What is it?\nDefinition\n## How?\nSteps\n## Why?\nReasons\nQ: One?\nA: Yes.\nQ: Two?\nA: Yes.\nQ: Three?\nA: Yes.\nLast updated: 2026-10-06",
  };
  const result = quality(article, w, "ja");
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((x) => x.includes("일본어 본문")));
  assert.ok(result.issues.some((x) => x.includes("일본어 제목")));
});


test("legacy verifier recovery uses the previous failed claims and preserves correct languages", () => {
  const payload: any = {repair_attempts:1, repair:{unsupported_claims:[{claim:"a"},{claim:"b"}],issues:[]}, input:{translations:{en:{},ja:{}}}, research:{briefs:{en:{sources:[{url:"https://example.com/hours",evidence:"weekends 24:00"}]} }}, quality:{languages:{en:{passed:true,issues:[]},ja:{passed:true,issues:[]}}, verification:{passed:false,reason:"wrong weekend",claims:[{lang:"en",claim:"weekends 01:00",status:"contradicted",source_url:"https://example.com/hours"}]}}};
  assert.equal(planRepair(payload,{languages:["en","ja"]}),true);
  assert.equal(payload.repair_attempts,2);
  assert.deepEqual(payload.repair.target_languages,["en"]);
  assert.equal(payload.repair.unsupported_claims[0].evidence[0].evidence,"weekends 24:00");
  assert.equal(planRepair(payload,{languages:["en","ja"]}),false);
});

test("budget reset matches the enforced Korean week and month boundaries", () => {
  const now=Date.parse("2026-10-06T01:00:00Z");
  assert.equal(budgetReset("weekly",now),"2026-10-11T15:00:00.000Z");
  assert.equal(budgetReset("monthly",now),"2026-10-31T15:00:00.000Z");
  assert.equal(budgetReset("article",now),budgetReset("monthly",now));
});

test("budget-blocked research waits without a model call then automatically resumes its checkpoint", async () => {
  const {d,env}=environment();env.ANTHROPIC_API_KEY="test-key";
  const now=Date.now(), month=new Date(now+9*3600000).toISOString().slice(0,7), week=String(Math.floor((now+9*3600000-4*86400000)/(7*86400000)));
  for(let i=0;i<5;i++) d.sqlite.prepare("INSERT INTO ai_runs(id,article_key,month,week,reserved,status,created_at) VALUES(?,?,?,?,0.398,'complete',?)").run("budget"+i,"koreabylocal/other"+i,month,week,new Date(now).toISOString());
  d.sqlite.prepare("INSERT INTO topic_ideas(id,site_id,title,category,status,created_at) VALUES('recover-budget','koreabylocal','Korean greetings','culture','approved',?)").run(new Date(now).toISOString());
  const original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error("Must not call paid model");}) as typeof fetch;
  try {
    await advanceHarness(env);
    const task=d.sqlite.prepare("SELECT * FROM agent_workflows WHERE topic_id='recover-budget'").get() as any;
    assert.equal(task.status,"budget_wait");assert.equal(task.stage,"researcher");assert.equal(calls,0);
    const retry=JSON.parse(task.payload_json).recovery.retry_at;
    await recoverWorkflows(env,Date.parse(retry)-1);
    assert.equal((d.sqlite.prepare("SELECT status FROM agent_workflows WHERE job_id=?").get(task.job_id) as any).status,"budget_wait");
    await recoverWorkflows(env,Date.parse(retry));
    const resumed=d.sqlite.prepare("SELECT status,stage FROM agent_workflows WHERE job_id=?").get(task.job_id) as any;
    assert.equal(resumed.status,"pending");assert.equal(resumed.stage,"researcher");
    assert.equal((d.sqlite.prepare("SELECT status FROM content_jobs WHERE id=?").get(task.job_id) as any).status,"agent_pending");
  } finally {globalThis.fetch=original;}
});

test("known factual errors are prepared for rewrite while the budget wait remains in force", async () => {
  const {d,env}=environment();
  const payload={repair_attempts:1,repair:{unsupported_claims:[{claim:"a"},{claim:"b"}],issues:[]},input:{translations:{en:{}}},research:{briefs:{en:{sources:[]}}},quality:{languages:{en:{passed:true,issues:[]}},verification:{passed:false,claims:[{lang:"en",claim:"wrong weekend",status:"contradicted"}]}},recovery:{scope:"weekly",retry_at:"2026-10-11T15:00:00Z"}};
  d.sqlite.prepare("INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES('waiting-repair','koreabylocal','waiting-repair','Subway','culture','{}','budget_wait','now','now')").run();
  d.sqlite.prepare("INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES('waiting-repair','topic','koreabylocal','verifier','budget_wait',?,'now','now')").run(JSON.stringify(payload));
  await recoverWorkflows(env,Date.parse("2026-10-06T01:00:00Z"));
  await recoverWorkflows(env,Date.parse("2026-10-06T01:00:01Z"));
  const result=d.sqlite.prepare("SELECT stage,status,payload_json FROM agent_workflows WHERE job_id='waiting-repair'").get() as any;
  assert.equal(result.stage,"supervisor");assert.equal(result.status,"budget_wait");
  const saved=JSON.parse(result.payload_json);
  assert.equal(saved.repair_attempts,1);
  assert.equal(saved.recovery.retry_at,payload.recovery.retry_at);
});

test("budget settings require login and reject invalid limits without changing the guard", async () => {
  const {d,env}=environment();
  assert.equal((await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:"koreabylocal",monthly:20,weekly:3,article:1})},false)).status,401);
  for(const input of [{monthly:10,weekly:11,article:0.5},{monthly:10,weekly:2,article:3},{monthly:-1,weekly:2,article:0.5},{monthly:10,weekly:2.001,article:0.5},{monthly:10,weekly:"3",article:0.5}])
    assert.equal((await request("budget",env,{method:"PUT",body:JSON.stringify({...input,site_id:"koreabylocal"})})).status,400);
  const settings=d.sqlite.prepare("SELECT monthly,weekly,article,revision FROM workspace_budget_settings WHERE site_id='koreabylocal'").get() as any;
  assert.deepEqual({...settings},{monthly:10,weekly:2,article:0.5,revision:1});
});

test("saved budgets drive the DB spending guard and unchanged saves do not reset usage or retry revisions", async () => {
  const {d,env}=environment();
  const period={month:"2026-10",week:"2961"};
  const insert=d.sqlite.prepare("INSERT INTO ai_runs(id,article_key,month,week,reserved,status,created_at) VALUES(?,?,?,?,?,'complete','now')");
  assert.throws(()=>insert.run("too-high","koreabylocal/one",period.month,period.week,0.7),/article_budget/);
  const response=await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:"koreabylocal",monthly:20,weekly:3,article:1})});
  assert.equal(response.status,200);assert.equal((await response.json() as any).revision,2);
  insert.run("allowed","koreabylocal/one",period.month,period.week,0.7);
  assert.throws(()=>insert.run("blocked","koreabylocal/one",period.month,period.week,0.4),/article_budget/);
  const same=await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:"koreabylocal",monthly:20,weekly:3,article:1})});
  assert.equal((await same.json() as any).revision,2);
  assert.equal((d.sqlite.prepare("SELECT SUM(reserved) AS used FROM ai_runs").get() as any).used,0.7);
});

test("a budget increase resumes waiting jobs before the calendar reset without executing a paid call", async () => {
  const {d,env}=environment();
  const payload={recovery:{scope:"weekly",retry_at:"2026-10-11T15:00:00Z",budget_revision:1}};
  d.sqlite.prepare("INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES('increased-budget','koreabylocal','increased-budget','Greetings','culture','{}','budget_wait','now','now')").run();
  d.sqlite.prepare("INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES('increased-budget','topic','koreabylocal','researcher','budget_wait',?,'now','now')").run(JSON.stringify(payload));
  await recoverWorkflows(env,Date.parse("2026-10-06T01:00:00Z"));
  assert.equal((d.sqlite.prepare("SELECT status FROM agent_workflows").get() as any).status,"budget_wait");
  await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:"koreabylocal",monthly:10,weekly:3,article:0.5})});
  await recoverWorkflows(env,Date.parse("2026-10-06T01:00:01Z"));
  const result=d.sqlite.prepare("SELECT status,stage,payload_json FROM agent_workflows").get() as any;
  assert.equal(result.status,"pending");assert.equal(result.stage,"researcher");assert.equal(JSON.parse(result.payload_json).recovery,undefined);
});

test("workspace budgets isolate spending guards, reports and saves", async () => {
  const {d,env}=environment();
  const now=Date.now(),month=new Date(now+9*3600000).toISOString().slice(0,7),week=String(Math.floor((now+9*3600000-4*86400000)/(7*86400000)));
  const insert=d.sqlite.prepare("INSERT INTO ai_runs(id,article_key,month,week,reserved,actual,status,created_at) VALUES(?,?,?,?,?,?,'complete',?)");
  for(let i=0;i<4;i++) insert.run("local"+i,"koreabylocal/topic-"+i,month,week,0.5,0.5,new Date(now).toISOString());
  assert.throws(()=>insert.run("local-over","koreabylocal/fresh",month,week,0.1,0.1,"now"),/weekly_budget/);
  insert.run("decode","koreadecode/fresh",month,week,0.4,0.3,new Date(now).toISOString());
  const local=await (await request("reports?site_id=koreabylocal",env)).json() as any;
  const decode=await (await request("reports?site_id=koreadecode",env)).json() as any;
  assert.equal(local.budget.reserved,2);assert.equal(local.weekly.reserved,2);
  assert.equal(decode.budget.reserved,0.4);assert.equal(decode.budget.actual,0.3);
  assert.equal(decode.runs.length,1);assert.equal(decode.limits.site_id,"koreadecode");
  await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:"koreabylocal",monthly:20,weekly:3,article:1})});
  const unchanged=await (await request("reports?site_id=koreadecode",env)).json() as any;
  assert.equal(unchanged.limits.monthly,10);assert.equal(unchanged.limits.weekly,2);assert.equal(unchanged.limits.revision,1);
  assert.equal((await request("reports?site_id=unknown",env)).status,404);
  assert.equal((await request("budget",env,{method:"PUT",body:JSON.stringify({monthly:10,weekly:2,article:0.5})})).status,400);
});

test("new workspaces start with zero budgets and similarly named sites cannot consume each other's allowance", async () => {
  const {d,env}=environment();
  const w=structuredClone(CATALOG[2]);w.site_id="koreabylocal-extra";w.schedule.enabled=false;
  assert.equal((await request("workspaces",env,{method:"POST",body:JSON.stringify(w)})).status,201);
  const created=await (await request("reports?site_id=koreabylocal-extra",env)).json() as any;
  assert.equal(created.limits.monthly,0);assert.equal(created.limits.weekly,0);assert.equal(created.limits.article,0);
  const insert=d.sqlite.prepare("INSERT INTO ai_runs(id,article_key,month,week,reserved,status,created_at) VALUES(?,?,?,?,?,'running','now')");
  assert.throws(()=>insert.run("paused","koreabylocal-extra/topic","2026-10","week",0.01),/monthly_budget/);
  assert.throws(()=>insert.run("unknown","missing/topic","2026-10","week",0.01),/workspace_budget_missing/);
  await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:w.site_id,monthly:10,weekly:2,article:0.5})});
  insert.run("extra","koreabylocal-extra/topic","2026-10","week",0.4);
  insert.run("local","koreabylocal/topic","2026-10","week",0.4);
  assert.throws(()=>insert.run("extra-over","koreabylocal-extra/topic","2026-10","week",0.2),/article_budget/);
});

test("changing a workspace budget resumes only its own waiting agents", async () => {
  const {d,env}=environment();
  for(const site of ["koreabylocal","koreadecode"]) {
    d.sqlite.prepare("INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES(?,?,?,'Topic','culture','{}','budget_wait','now','now')").run(site,site,site);
    d.sqlite.prepare("INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES(?,?,?,'researcher','budget_wait',?,'now','now')").run(site,site,site,JSON.stringify({recovery:{retry_at:"2026-10-11T15:00:00Z",budget_revision:1}}));
  }
  await request("budget",env,{method:"PUT",body:JSON.stringify({site_id:"koreabylocal",monthly:10,weekly:3,article:0.5})});
  await recoverWorkflows(env,Date.parse("2026-10-06T01:00:00Z"));
  assert.equal((d.sqlite.prepare("SELECT status FROM agent_workflows WHERE site_id='koreabylocal'").get() as any).status,"pending");
  assert.equal((d.sqlite.prepare("SELECT status FROM agent_workflows WHERE site_id='koreadecode'").get() as any).status,"budget_wait");
});

function supervisorFixture() {
  const w=structuredClone(CATALOG[2]);
  const urls=["https://english.visitseoul.net/miscellaneous","https://english.visitseoul.net/subway"];
  const photos=[1,2].map(i=>({id:String(i),provider:"Pexels" as const,url:`https://images.pexels.com/${i}.jpg`,page:`https://www.pexels.com/photo/${i}`,photographer:"Author",photographer_url:"https://www.pexels.com/@author",alt:"Seoul context",license_url:"https://www.pexels.com/license"}));
  const article={title:"Seoul subway night guide",meta_description:"A sourced Seoul subway guide.",tags:["Seoul"],format:"guide",content_md:`## Quick Answer\n${"Seoul subway is a useful travel option for visitors who want to understand the city and plan a reliable journey with official information before they leave their hotel. Check the station timetable and remember that different days can have different operating hours."}\n\n## What are the hours?\nWeekdays 05:00 to 25:00 means 01:00 next day. Weekends close at 24:00.\n\n## How do visitors plan?\nUse the official timetable.\n\n## Why check the day?\nThe service is different on weekdays and weekends.\n\n## FAQ\nQ: What does 25:00 mean?\nA: It means 01:00 the next day.\nQ: What does 24:00 mean?\nA: It means midnight.\nQ: Where do I check?\nA: Use official information.\n\nLast updated: 2026-10-06\n\nSources: [Official hours](${urls[0]}), [Subway information](${urls[1]})`,images:photos};
  const prepared=prepareForReview(article,{sources:urls.map(url=>({url,claim:"Weekday hours",evidence:"Transportation Subway: 05:00 - 25:00 (Weekdays) / 05:00 – 24:00 (Weekends & Holidays)",checked_at:"2026-10-05"}))},"en");
  const input:DraftInput={site_id:w.site_id,slug:"review-fixture",category:"Travel",request_id:"review-fixture",reviewed:true,translations:{en:prepared}};
  const research={briefs:{en:{sources:urls.map(url=>({url,claim:"Weekday hours",evidence:"Transportation Subway: 05:00 - 25:00 (Weekdays) / 05:00 – 24:00 (Weekends & Holidays)",checked_at:"2026-10-05"}))}}};
  const decision={action:"approve",reason:"공식 근거와 표기 동치를 확인했습니다.",instructions:"",target_languages:["en"],claims:[{lang:"en",claim:"25:00 is 01:00 next day",status:"verified",source_url:urls[0],evidence_quote:"05:00 - 25:00 (Weekdays)"}]};
  return {w,input,research,decision};
}
test("senior approval requires real quotes, all languages and structural checks", () => {
  const {w,input,research,decision}=supervisorFixture();
  assert.equal(quality(input.translations.en,w,"en").passed,true);
  assert.equal(validateSupervision(decision,w,input,research.briefs).action,"approve");
  assert.equal(validateSupervision({...decision,claims:[{...decision.claims[0],evidence_quote:"invented supporting sentence"}]},w,input,research.briefs).action,"edit");
  assert.equal(validateSupervision({...decision,claims:[]},w,input,research.briefs).action,"edit");
  const noLinks=structuredClone(input);noLinks.translations.en.content_md="short";
  assert.equal(validateSupervision(decision,w,noLinks,research.briefs).action,"edit");
});
test("format recovery restores exact sources and photos without changing the Quick Answer", () => {
  const {w,input,research}=supervisorFixture();
  const article=input.translations.en;
  const oldAnswer=article.content_md.match(/## Quick Answer\n([\s\S]*?)(?=\n## )/)![1];
  const repaired=prepareForReview({...article,content_md:article.content_md.replace(/Sources:[\s\S]*$/, "Sources: names without links")},research.briefs.en,"en");
  assert.equal(repaired.content_md.match(/## Quick Answer\n([\s\S]*?)(?=\n## )/)![1].trim(),oldAnswer.trim());
  assert.equal((repaired.content_md.match(/!\[/g)||[]).length,2);
  assert.equal(quality(repaired,w,"en").passed,true);
});
test("Sonnet costs and model identity use the correct rates", async () => {
  const {env,d}=environment();env.ANTHROPIC_API_KEY="test";
  const original=globalThis.fetch;
  globalThis.fetch=async (_url,init)=>{
    assert.equal(JSON.parse(String(init?.body)).model,SUPERVISOR_MODEL);
    return Response.json({stop_reason:"end_turn",usage:{input_tokens:1000,output_tokens:100},content:[{type:"text",text:'{"ok":true}'}]});
  };
  try {
    const result=await modelJson(env,"koreadecode/model-price","system",{},1000,undefined,SUPERVISOR_MODEL);
    assert.equal(result.cost_usd,0.003);
    const run=d.sqlite.prepare("SELECT model,actual FROM ai_runs").get() as any;
    assert.equal(run.model,SUPERVISOR_MODEL);assert.equal(run.actual,0.003);
  } finally {globalThis.fetch=original;}
});
test("a stalled verifier is supervised, edited and approved entirely in the background", async () => {
  const {env,d}=environment();env.ANTHROPIC_API_KEY="test";
  const {w,input,research,decision}=supervisorFixture();
  const payload={title:input.translations.en.title,slug:input.slug,category:input.category,input,research,repair_attempts:2,quality:{factual:false}};
  d.sqlite.prepare("INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES('review-fixture',?,?,?,'Travel','{}','review','now','now')").run(w.site_id,input.slug,input.translations.en.title);
  d.sqlite.prepare("INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES('review-fixture','topic',?,'verifier','failed',?,'now','now')").run(w.site_id,JSON.stringify(payload));
  const original=globalThis.fetch;let supervisorCalls=0;
  globalThis.fetch=async (_url,init)=>{
    const body=JSON.parse(String(init?.body));let data:any;
    if(body.system.includes("senior editorial supervisor")) data=++supervisorCalls===1 ? {...decision,action:"edit",instructions:"Keep supported times and fix the prior report."} : decision;
    else if(body.system.includes("senior correction editor")) data=input.translations.en;
    else data={passed:true,reason:"supported",claims:decision.claims};
    return Response.json({stop_reason:"end_turn",usage:{input_tokens:100,output_tokens:100},content:[{type:"text",text:JSON.stringify(data)}]});
  };
  try {
    for(let i=0;i<5;i++) await advanceHarness(env);
    const state=d.sqlite.prepare("SELECT stage,status,payload_json FROM agent_workflows").get() as any;
    assert.equal(state.stage,"publisher");assert.equal(state.status,"pending");
    const saved=JSON.parse(state.payload_json);
    assert.equal(saved.supervision.length,2);assert.equal(saved.supervision[0].action,"edit");assert.equal(saved.supervision[1].action,"approve");
    assert.equal(saved.supervisor_approval,await articleFingerprint(saved.input));
    saved.input.translations.en.title+=" changed";
    d.sqlite.prepare("UPDATE agent_workflows SET payload_json=?").run(JSON.stringify(saved));
    const result=await advanceHarness(env);
    assert.ok("error" in result && result.error?.includes("상위 검토 승인"));
  } finally {globalThis.fetch=original;}
});

test("a confirmed truncated senior response gets only one automatic recovery", async () => {
  const {env,d}=environment();env.ANTHROPIC_API_KEY="test";
  const {w,input,research}=supervisorFixture();
  d.sqlite.prepare("INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES('truncated-review',?,?,?,'Travel','{}','review','now','now')").run(w.site_id,input.slug,input.translations.en.title);
  d.sqlite.prepare("INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES('truncated-review','topic',?,'supervisor','pending',?,'now','now')").run(w.site_id,JSON.stringify({title:input.translations.en.title,slug:input.slug,input,research}));
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({stop_reason:"max_tokens",usage:{input_tokens:100,output_tokens:100},content:[]});};
  try {
    await advanceHarness(env);
    assert.equal((d.sqlite.prepare("SELECT status FROM agent_workflows").get() as any).status,"pending");
    await advanceHarness(env);
    assert.equal((d.sqlite.prepare("SELECT status FROM agent_workflows").get() as any).status,"failed");
    await advanceHarness(env);
    assert.equal(calls,2);
    assert.equal((d.sqlite.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE actual>0").get() as any).n,2);
  } finally {globalThis.fetch=original;}
});

test("provider rate limits defer the checkpoint and release unspent reservations", async () => {
  const {env,d}=environment();env.ANTHROPIC_API_KEY="test";
  const {w,input,research,decision}=supervisorFixture();
  const payload={slug:input.slug,input,research,supervision:[{...decision,action:"edit",run_id:"assignment",model:SUPERVISOR_MODEL}]};
  d.sqlite.prepare("INSERT INTO content_jobs(id,site_id,slug,title,category,request_json,status,created_at,updated_at) VALUES('rate-limited',?,?,?,'Travel','{}','editing','now','now')").run(w.site_id,input.slug,input.translations.en.title);
  d.sqlite.prepare("INSERT INTO agent_workflows(job_id,topic_id,site_id,stage,status,payload_json,created_at,updated_at) VALUES('rate-limited','topic',?,'editor','pending',?,'now','now')").run(w.site_id,JSON.stringify(payload));
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>++calls===1 ? Response.json({error:{type:"rate_limit_error"}},{status:429,headers:{"Retry-After":"60"}}) : Response.json({stop_reason:"end_turn",usage:{input_tokens:100,output_tokens:100},content:[{type:"text",text:JSON.stringify(input.translations.en)}]});
  try {
    const result=await advanceHarness(env);assert.ok("waiting" in result && result.waiting);
    let state=d.sqlite.prepare("SELECT status,payload_json FROM agent_workflows").get() as any;
    assert.equal(state.status,"retry_wait");
    assert.equal((d.sqlite.prepare("SELECT actual,reserved FROM ai_runs").get() as any).reserved,0);
    await advanceHarness(env);assert.equal(calls,1);
    await recoverWorkflows(env,Date.parse(JSON.parse(state.payload_json).provider_retry_at)+1);
    await advanceHarness(env);
    state=d.sqlite.prepare("SELECT status,stage,payload_json FROM agent_workflows").get() as any;
    assert.equal(state.stage,"photo_editor");assert.equal(calls,2);
    assert.deepEqual(JSON.parse(state.payload_json).editor_completed.assignment,["en"]);
  } finally {globalThis.fetch=original;}
});

test("an existing public original becomes a private correction draft without duplicate creation on replay", async () => {
  const {env,d}=environment();env.NATIVE_BLOG_SUPABASE_KEY="test";
  const {w,input}=supervisorFixture(),job="revision-job";
  const originalRow={id:99,slug:input.slug,status:"published",content:"Original published body"};
  const rows=new Map<string,any>([[input.slug,{...originalRow}]]);
  d.sqlite.prepare("INSERT INTO publication_receipts(job_id,lang,phase,updated_at) VALUES(?,'en','create','now')").run(job);
  const original=globalThis.fetch;let creates=0,patches=0;
  globalThis.fetch=async(url,init)=>{
    if(init?.method==="POST") {creates++;const body=JSON.parse(String(init.body));const row={...body,id:100};rows.set(body.slug,row);return Response.json([row],{status:201});}
    if(init?.method==="PATCH") {patches++;throw Error("Original must never be patched");}
    const slug=new URL(String(url)).searchParams.get("slug")!.slice(3);
    const row=rows.get(slug);return Response.json(row?[row]:[]);
  };
  try {
    const first=await publishJob(env,w,job,input,"draft") as any;
    const second=await publishJob(env,w,job,input,"draft") as any;
    assert.equal(first.posts.en.id,100);assert.equal(first.posts.en.status,"draft");
    assert.equal(first.posts.en.revision_of.id,99);
    assert.equal(first.posts.en.slug,second.posts.en.slug);
    assert.ok(first.posts.en.slug.includes("-review-"));
    assert.equal(creates,1);assert.equal(patches,0);
    assert.deepEqual(rows.get(input.slug),originalRow);
    assert.equal((d.sqlite.prepare("SELECT COUNT(*) AS n FROM publication_receipts WHERE remote_json IS NULL").get() as any).n,0);
  } finally {globalThis.fetch=original;}
});
