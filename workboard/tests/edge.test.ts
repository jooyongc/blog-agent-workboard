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
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(
    fs.readFileSync(
      new URL("../migrations/0001_workboard.sql", import.meta.url),
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
            s.run(...args);
            return { success: true };
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
test("catalog always includes all four production workspaces and two Blogger languages", () => {
  assert.deepEqual(
    CATALOG.map((w) => w.site_id),
    ["asty-cabin", "korea-buy-list", "koreabylocal", "koreadecode"],
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
  assert.equal(j.workspaces.length, 4);
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
  assert.equal(invalid.status, 400);
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
  const w = validateDraft(input);
  const payload = draftPayload(w, input);
  assert.equal(payload.status, "draft");
  assert.equal(
    "published_at" in payload ? payload.published_at : "missing",
    null,
  );
  const other = draft("koreadecode");
  assert.equal(draftPayload(validateDraft(other), other).status, "draft");
  assert.ok("writer_name" in draftPayload(getWorkspace("koreadecode"), other));
  assert.throws(() => validateDraft({ ...input, reviewed: false }));
  assert.throws(() => validateDraft({ ...input, slug: "../bad" }));
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
test("a Blogger selection cannot trigger the ASTY workflow", async () => {
  const { env } = environment();
  env.GITHUB_TOKEN = "mock";
  const res = await request("pipeline", env, {
    method: "POST",
    body: JSON.stringify({
      site_id: "korea-buy-list",
      limit: 3,
      dry_run: true,
    }),
  });
  assert.equal(res.status, 409);
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
