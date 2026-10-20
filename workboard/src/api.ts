export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch("/api/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    credentials: "same-origin",
    signal: options.signal ?? AbortSignal.timeout(150000),
  });
  const data = await res.json().catch(() => {
    throw new ApiError(res.status,"서버가 올바른 JSON 상태 응답을 반환하지 않았습니다.");
  });
  if (!res.ok)
    throw new ApiError(
      res.status,
      (data as { error?: string }).error ?? "요청을 처리하지 못했습니다.",
    );
  return data as T;
}
