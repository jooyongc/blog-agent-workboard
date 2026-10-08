export function modelLabel(model?: string) {
  return (
    (
      {
        "claude-haiku-4-5": "Haiku 4.5",
        "claude-haiku-5-5": "Claude Haiku 5.5",
        "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-sonnet-5-5": "Sonnet 5.5",
        "gemini-2.5-flash": "Gemini 2.5 Flash · 검색",
        "gemini-3.1-flash-image": "Gemini 3.1 Flash Image",
        "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
        "gemini-3.6-flash": "Gemini 3.6 Flash",
        "gemini-3.8-flash": "Gemini 3.8 Flash",
        "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
      } as Record<string, string>
    )[model || ""] ||
    model ||
    "연결 확인 중"
  );
}
