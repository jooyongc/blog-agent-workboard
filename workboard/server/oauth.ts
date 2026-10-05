import type { Env } from "./env";
import { workspace, variable } from "./registry";
import { HttpError, remote } from "./http";
async function key(env: Env) {
  if (!env.CONNECTION_SECRET || env.CONNECTION_SECRET.length < 32)
    throw new HttpError(503, "연결 암호화 설정이 필요합니다.");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.CONNECTION_SECRET),
    ),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env),
    new TextEncoder().encode(value),
  );
  return (
    btoa(String.fromCharCode(...iv)) +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(encoded)))
  );
}
export async function savedRefresh(env: Env, site: string) {
  const r = await env.WORKBOARD_DB.prepare(
    "SELECT ciphertext FROM connection_tokens WHERE site_id=?",
  )
    .bind(site)
    .first<{ ciphertext: string }>();
  if (!r) return "";
  const [iv, data] = r.ciphertext.split(".");
  const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(iv) },
      await key(env),
      bytes(data),
    ),
  );
}
export function googleCredentials(
  env: Env,
  w: import("../shared/types").Workspace,
) {
  const client = variable(env, w.connection.client_id_env).trim();
  const secret = variable(env, w.connection.client_secret_env).trim();
  if (!/^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(client))
    throw new HttpError(
      503,
      "Blogger Client ID가 Google OAuth 형식이 아닙니다. Cloudflare BLOGGER_CLIENT_ID에 웹 애플리케이션 OAuth 클라이언트 ID를 등록하세요.",
    );
  if (!secret) throw new HttpError(503, "Blogger Client Secret을 등록하세요.");
  return { client, secret };
}
export async function oauthStart(env: Env, siteId: string, origin: string) {
  const w = await workspace(env, siteId);
  if (w.integration !== "blogger")
    throw new HttpError(400, "Blogger 연결을 선택하세요.");
  const { client } = googleCredentials(env, w);
  const state = crypto.randomUUID() + crypto.randomUUID(),
    uri = origin + "/api/blogger/oauth/callback";
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO oauth_states(state,site_id,redirect_uri,expires_at) VALUES(?,?,?,?)",
  )
    .bind(state, siteId, uri, Date.now() + 600000)
    .run();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client,
    redirect_uri: uri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/blogger",
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  return { url: url.href, redirect_uri: uri };
}
export async function oauthCallback(env: Env, url: URL) {
  const state = url.searchParams.get("state") ?? "",
    code = url.searchParams.get("code");
  const r = await env.WORKBOARD_DB.prepare(
    "DELETE FROM oauth_states WHERE state=? AND expires_at>? RETURNING site_id,redirect_uri",
  )
    .bind(state, Date.now())
    .first<{ site_id: string; redirect_uri: string }>();
  if (!r || !code || url.searchParams.has("error"))
    throw new HttpError(
      400,
      "Google 인증이 완료되지 않았습니다. 연결을 다시 시작하세요.",
    );
  const w = await workspace(env, r.site_id);
  const { client, secret } = googleCredentials(env, w);
  const res = await remote("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client,
      client_secret: secret,
      redirect_uri: r.redirect_uri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new HttpError(
      503,
      error.error === "invalid_client"
        ? "Google에서 OAuth 클라이언트를 찾지 못했습니다. BLOGGER_CLIENT_ID·SECRET이 같은 활성 웹 클라이언트의 값인지 확인하세요."
        : error.error === "redirect_uri_mismatch"
          ? "Google OAuth 클라이언트의 승인된 리다이렉트 URI에 /api/blogger/oauth/callback 주소를 등록하세요."
          : "Google 인증 코드 교환에 실패했습니다. 연결을 다시 시작하세요.",
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  if (!data.refresh_token)
    throw new HttpError(
      409,
      "오프라인 발행 권한을 받지 못했습니다. Google 연결을 다시 승인하세요.",
    );
  const blog = await remote(
    `https://www.googleapis.com/blogger/v3/users/self/blogs/${w.connection.blog_id}`,
    { headers: { Authorization: "Bearer " + data.access_token } },
  );
  if (!blog.ok)
    throw new HttpError(
      403,
      "이 계정의 Blogger 관리 권한을 확인하지 못했습니다.",
    );
  const access = (await blog.json()) as {
    blog_user_info?: { blogId?: string; hasAdminAccess?: boolean };
  };
  if (
    access.blog_user_info?.blogId !== w.connection.blog_id ||
    access.blog_user_info?.hasAdminAccess !== true
  )
    throw new HttpError(403, "이 계정의 Blogger 관리자 권한이 필요합니다.");
  await env.WORKBOARD_DB.prepare(
    "INSERT INTO connection_tokens(site_id,ciphertext,updated_at) VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at",
  )
    .bind(
      w.site_id,
      await seal(env, data.refresh_token),
      new Date().toISOString(),
    )
    .run();
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/settings?blogger=connected",
      "Cache-Control": "no-store",
    },
  });
}
