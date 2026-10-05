export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}
export async function body<T>(request: Request): Promise<T> {
  if (Number(request.headers.get("content-length") ?? 0) > 100000)
    throw new HttpError(413, "입력 내용이 너무 큽니다.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 100000)
    throw new HttpError(413, "입력 내용이 너무 큽니다.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "올바른 JSON 형식이 필요합니다.");
  }
}
export async function remote(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (res.status >= 300 && res.status < 400)
    throw new HttpError(502, "사이트 주소의 리다이렉트를 확인해 주세요.");
  return res;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new HttpError(403, "다른 사이트에서 요청할 수 없습니다.");
}
export function cookie(request: Request, name: string) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}
export function validSlug(slug: unknown): slug is string {
  return (
    typeof slug === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    slug.length <= 100
  );
}
export function message(error: unknown) {
  return error instanceof HttpError
    ? error.message
    : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
