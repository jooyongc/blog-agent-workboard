import type { Workspace, Article, Quality } from "../shared/types";
export const SEO_RULES = `Apply the restored SEO/AEO/GEO playbook. Front-load a natural primary keyword in a question, definition, how-to or comparison title (no vague "ultimate guide"). Start content with a ## Quick Answer (40-80 English words or concise Japanese equivalent). Use exactly three main question-form H2 sections, each followed immediately by a direct answer. Include one definition of the main entity, named relevant entities, sourced atomic facts (never invent numbers), relevant verified internal links, and a 4-6 row comparison table only when the topic is a comparison. End with 3-5 visible FAQ pairs in the EXACT format **Q: question** followed on the next line by A: answer; Japanese Q text must be natural Japanese. Include Last updated: YYYY-MM-DD, with sources inline. Avoid body bold except FAQ Q labels. Meta description answers the title question, <=160 characters. Use only verified primary evidence; distinguish uncertainty and opinions. Never fabricate search volume, GSC positions, prices, rankings, source URLs, images, affiliate codes or entities. Structured FAQ data must match visible content. Follow the site's audience, pillars and voice; no ASTY content.`;
export function extractFaq(md: string) {
  return Array.from(
    md.matchAll(
      /\*\*Q:\s*(.+?)\*\*\s*\nA:\s*([\s\S]+?)(?=\n\n|\n\*\*Q:|\n## |$)/g,
    ),
  ).map((m) => ({
    question: m[1].trim(),
    answer: m[2]
      .trim()
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`]/g, ""),
  }));
}
export function quality(article: Article, w: Workspace, lang: string): Quality {
  const md = article.content_md;
  const faq = extractFaq(md);
  const headings = Array.from(md.matchAll(/^##\s+(.+)$/gm)).map((m) => m[1]);
  const quick =
    md
      .match(
        /^##\s+(?:Quick Answer|クイックアンサー|要点|即答)\s*\n([\s\S]*?)(?=\n## |$)/im,
      )?.[1]
      ?.trim() ?? "";
  const main = headings.filter(
    (h) =>
      !/(Quick Answer|Frequently Asked|FAQ|よくある|要点|即答|Sources|References)/i.test(
        h,
      ),
  );
  const question = main.filter(
    (h) =>
      /[?？]$/.test(h) ||
      /^(How|What|Which|Where|When|Why|Can|Do|Is|Are)\b/i.test(h),
  ).length;
  const source = (md.match(/(?<!!)\[[^\]]+\]\(https:\/\//g) ?? []).length;
  const images = (md.match(/!\[[^\]]+\]\(https:\/\//g) ?? []).length;
  const entities = w.strategy.entities.filter((e) =>
    md.toLowerCase().includes(e.toLowerCase()),
  ).length;
  const keyword = article.primary_keyword ?? "";
  const signals = {
    quick_answer: !!quick,
    question_h2_count: question,
    faq_count: faq.length,
    definition: /\b(?:is|means|refers to)\b|とは|意味/.test(md),
    atomic_facts: (md.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []).length,
    entities,
    comparison: /^\|.+\|\s*\n\|[- :|]+\|/m.test(md),
    freshness: /Last updated: \d{4}-\d{2}-\d{2}/.test(md),
    sources: source,
    images,
    keyword_title:
      !!keyword && article.title.toLowerCase().includes(keyword.toLowerCase()),
  };
  let score =
    (signals.quick_answer ? 20 : 0) +
    (question >= 3 ? 15 : question * 5) +
    (faq.length >= 3 && faq.length <= 5 ? 15 : 0) +
    (signals.definition ? 10 : 0) +
    (signals.atomic_facts >= 5 ? 10 : 0) +
    (entities >= 3 ? 10 : entities * 3) +
    (signals.comparison ? 10 : 0) +
    (signals.freshness ? 5 : 0) +
    (!/\*\*(?!Q:)[^*]+\*\*/.test(md) ? 5 : 0);
  const issues: string[] = [];
  if (!quick) issues.push("Quick Answer가 없습니다.");
  if (question < 3) issues.push("질문형 H2를 3개 이상 준비하세요.");
  if (faq.length < 3 || faq.length > 5)
    issues.push("본문 FAQ를 3~5개 준비하세요.");
  if (source < 2) issues.push("실제 확인한 출처 링크를 2개 이상 넣으세요.");
  if (
    (article.format === "comparison" ||
      /\bvs\b|compar(e|ison)|比較/i.test(article.title)) &&
    !signals.comparison
  )
    issues.push("비교 주제에는 실제 근거로 작성한 비교표가 필요합니다.");
  if (!signals.freshness) issues.push("Last updated 날짜를 넣으세요.");
  if (!article.meta_description || article.meta_description.length > 160)
    issues.push("검색 설명을 160자 이내로 준비하세요.");
  if (
    lang === "en" &&
    quick &&
    (quick.split(/\s+/).length < 40 || quick.split(/\s+/).length > 80)
  )
    issues.push("영어 Quick Answer는 40~80단어여야 합니다.");
  if (w.strategy.required_images > images)
    issues.push(
      `alt 설명을 포함한 이미지 ${w.strategy.required_images}장을 확인하세요.`,
    );
  if (
    w.strategy.affiliate_disclosure &&
    /affiliate|제휴|アフィリエイト/i.test(md) &&
    !md.slice(0, 800).includes(w.strategy.affiliate_disclosure)
  )
    issues.push("첫 링크보다 앞에 제휴 고지를 넣으세요.");
  return {
    score: Math.min(100, score),
    passed: score >= w.strategy.min_score && issues.length === 0,
    issues,
    signals,
    faq,
  };
}
export function schema(
  w: Workspace,
  a: Article,
  lang: string,
  url: string,
  published: string,
  image?: string,
) {
  const faq = extractFaq(a.content_md);
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": w.site_url + "/#organization",
      name: w.name,
      url: w.site_url,
    },
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: a.title,
      description: a.meta_description,
      inLanguage: lang,
      mainEntityOfPage: url,
      datePublished: published,
      dateModified: published,
      author: { "@id": w.site_url + "/#organization" },
      publisher: { "@id": w.site_url + "/#organization" },
      ...(image ? { image } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: w.site_url },
        { "@type": "ListItem", position: 2, name: a.title, item: url },
      ],
    },
    ...(faq.length >= 3 && faq.length <= 5
      ? [
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((f) => ({
              "@type": "Question",
              name: f.question,
              acceptedAnswer: { "@type": "Answer", text: f.answer },
            })),
          },
        ]
      : []),
  ];
}
export function schemaHtml(data: unknown) {
  return (
    '<script type="application/ld+json">' +
    JSON.stringify(data)
      .replace(/</g, "\\u003c")
      .replace(
        /[^\x00-\x7F]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      ) +
    "</script>"
  );
}
