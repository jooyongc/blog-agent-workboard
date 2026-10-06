import type { ModelId } from "./model";
export type GeminiResult = {
  text: string;
  finish_reason: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  searches: number;
  evidence_urls: string[];
  data?: any;
};
async function sourceUrl(url: string, domains: string[]) {
  let current = url;
  for (let i = 0; i < 4; i++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return null;
    if (
      domains.some(
        (domain) =>
          parsed.hostname === domain || parsed.hostname.endsWith("." + domain),
      )
    )
      return current;
    if (parsed.hostname !== "vertexaisearch.cloud.google.com") return null;
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const location = response.headers.get("Location");
    await response.body?.cancel();
    if (!location) return null;
    current = new URL(location, current).href;
  }
  return null;
}
export async function requestGemini(
  key: string,
  model: ModelId,
  system: string,
  input: unknown,
  maxTokens: number,
  domains?: string[],
) {
  return fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent",
    {
      method: "POST",
      redirect: "manual",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                system +
                (domains?.length
                  ? "\nYou MUST use Google Search before answering, never answer from memory. Search at most three queries using only these official domains: " +
                    domains.join(", ") +
                    ". Return exact grounded source URLs in JSON."
                  : ""),
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingLevel: "low" },
          ...(!domains?.length ? { responseMimeType: "application/json" } : {}),
        },
        ...(domains?.length ? { tools: [{ googleSearch: {} }] } : {}),
      }),
    },
  );
}
export async function parseGemini(
  raw: any,
  domains?: string[],
): Promise<GeminiResult> {
  const candidate = raw.candidates?.[0],
    usage = raw.usageMetadata || {};
  const text = (candidate?.content?.parts || [])
    .filter((p: any) => !p.thought && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
  const metadata = candidate?.groundingMetadata || {};
  const links = [
    ...new Set<string>(
      (metadata.groundingChunks || [])
        .map((c: any) => c.web?.uri)
        .filter((url: any) => typeof url === "string"),
    ),
  ].slice(0, 8);
  const resolved = domains?.length
    ? await Promise.all(
        links.map(async (url) => ({
          url,
          resolved: await sourceUrl(url, domains).catch(() => null),
        })),
      )
    : [];
  let data: any;
  if (text) {
    try {
      data = JSON.parse(
        text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
      );
    } catch {}
  }
  // Only exact redirects from actual grounding metadata can be normalized.
  if (Array.isArray(data?.sources))
    for (const source of data.sources) {
      const match = resolved.find(
        (link) => link.url === source.url && link.resolved,
      );
      if (match) source.url = match.resolved;
    }
  return {
    text,
    finish_reason:
      candidate?.finishReason || raw.promptFeedback?.blockReason || "EMPTY",
    input_tokens:
      Number(usage.promptTokenCount || 0) +
      Number(usage.toolUsePromptTokenCount || 0),
    output_tokens:
      Number(usage.candidatesTokenCount || 0) +
      Number(usage.thoughtsTokenCount || 0),
    cached_tokens: Number(usage.cachedContentTokenCount || 0),
    searches: new Set(
      (metadata.webSearchQueries || []).filter(
        (q: any) => typeof q === "string" && q.trim(),
      ),
    ).size,
    evidence_urls: resolved.flatMap((link) =>
      link.resolved ? [link.resolved] : [],
    ),
    data,
  };
}
