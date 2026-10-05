import type { Env } from "./env";
import { cookie, HttpError } from "./http";
const encoder = new TextEncoder();
async function key(secret: string) {
  if (!secret || secret.length < 32)
    throw new HttpError(503, "로그인 설정을 확인해 주세요.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function bytes64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function from64(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
export async function makeSession(secret: string, now = Date.now()) {
  const payload = bytes64(
    encoder.encode(
      JSON.stringify({
        exp: Math.floor(now / 1000) + 604800,
        nonce: crypto.randomUUID(),
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(payload),
  );
  return payload + "." + bytes64(new Uint8Array(signature));
}
export async function verifySession(
  value: string,
  secret: string,
  now = Date.now(),
) {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra) return false;
    const data = JSON.parse(new TextDecoder().decode(from64(payload)));
    if (!Number.isFinite(data.exp) || data.exp <= now / 1000) return false;
    return crypto.subtle.verify(
      "HMAC",
      await key(secret),
      from64(signature),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}
export async function authenticated(request: Request, env: Env) {
  return verifySession(
    cookie(request, "workboard_session"),
    env.DASHBOARD_SESSION_SECRET,
  );
}
export async function equalSecret(a: string, b: string) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const xa = new Uint8Array(x),
    ya = new Uint8Array(y);
  let result = 0;
  for (let i = 0; i < xa.length; i++) result |= xa[i] ^ ya[i];
  return result === 0;
}
export function sessionCookie(
  request: Request,
  value: string,
  maxAge = 604800,
) {
  return `workboard_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
