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
                (domains?.length ? system.split("Return JSON")[0] + " Search phase only: paraphrase briefly in at most 250 words with citations. Do not copy source passages or output an article, JSON or code blocks." : system) +
                (domains?.length
                  ? "\nYou MUST use Google Search before answering, never answer from memory. Search at most three queries using only these official domains: " +
                    domains.join(", ") +
                    ". SEARCH PHASE: Do not return JSON or code blocks. Write concise natural-language findings with Google Search citations. Search queries must explicitly include site: filters for these official domains. Ignore the earlier JSON formatting instruction; grounding metadata will be structured by the server."
                  : ""),
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens,
          thinkingConfig:
            model === "gemini-2.5-flash"
              ? { thinkingBudget: 0 }
              : { thinkingLevel: "low" },
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
  ].slice(0, 20);
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
  if (domains?.length && !data && text) {
    const batches = await Promise.all(
      resolved.map(async (link) => {
        if (!link.resolved) return [];
        const indices = (metadata.groundingChunks || []).flatMap(
          (chunk: any, index: number) =>
            chunk.web?.uri === link.url ? [index] : [],
        );
        const claims = (metadata.groundingSupports || [])
          .filter((support: any) =>
            support.groundingChunkIndices?.some((i: number) =>
              indices.includes(i),
            ),
          )
          .map((support: any) => support.segment?.text)
          .filter((value: any) => typeof value === "string" && value.trim());
        if (!claims.length) return [];
        try {
          const page = await fetch(link.resolved, {
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
          });
          if (
            !page.ok ||
            !/text\/html|text\/plain/.test(
              page.headers.get("content-type") || "",
            )
          ) {
            await page.body?.cancel();
            return [];
          }
          const html = (await page.text()).slice(0, 250000);
          const main =
            html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html;
          const evidence = main
            .replace(
              /<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,
              " ",
            )
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 16000);
          if (evidence.length < 100) return [];
          return [
            {
              url: link.resolved,
              checked_at: new Date().toISOString().slice(0, 10),
              claim: claims.join(" "),
              evidence,
            },
          ];
        } catch {
          return [];
        }
      }),
    );
    const sources = batches.flat();
    data = {
      brief: text,
      primary_keyword: "",
      secondary_keywords: [],
      aeo_question_variants: [],
      sources,
      unsupported: sources.length
        ? []
        : ["공식 출처의 검색 근거가 반환되지 않았습니다."],
    };
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
