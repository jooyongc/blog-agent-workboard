export function modelLabel(model?: string) {
  return (
    (
      {
        "claude-haiku-4-5": "Haiku 4.5",
        "claude-sonnet-5-5": "Sonnet 5.5",
        "gemini-2.5-flash": "Gemini 2.5 Flash · 검색",
        "gemini-3.8-flash": "Gemini 3.8 Flash",
        "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
      } as Record<string, string>
    )[model || ""] ||
    model ||
    "연결 확인 중"
  );
}
