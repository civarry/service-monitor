const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GROQ_MODEL = "llama-3.1-8b-instant";

export interface SummarizableArticle {
  title: string;
  description?: string;
}

export interface CategoryDigest {
  summary: string | null;
  labels: string[]; // same order/length as input articles
}

export async function digestCategory(
  label: string,
  articles: SummarizableArticle[]
): Promise<CategoryDigest> {
  if (articles.length === 0) return { summary: null, labels: [] };

  const bullets = articles
    .slice(0, 5)
    .map((a, i) => `${i + 1}. ${a.title}${a.description ? "\n   " + a.description.slice(0, 400) : ""}`)
    .join("\n");

  const prompt =
    `You are a senior journalist writing the 7 AM morning briefing for a busy reader in Taipei. ` +
    `Synthesize today's ${label} headlines into a fact-dense, specific summary.\n\n` +
    `Headlines (with descriptions where available):\n${bullets}\n\n` +
    `Return ONLY valid JSON in this exact shape, no commentary, no markdown fences:\n` +
    `{\n` +
    `  "summary": "3 sentences, roughly 70-90 words total. Lead with the single most significant story using concrete details (names, figures, places). Then tie in the other headlines, grouping related ones. No preamble like 'Today's news...'. No hashtags, no emoji.",\n` +
    `  "labels": ["3-5 word headline label for #1", "label for #2", ...]\n` +
    `}\n\n` +
    `Hard rules:\n` +
    `- Use concrete specifics from the descriptions: names, dollar amounts, places, percentages.\n` +
    `- Synthesize across stories rather than listing topics. Avoid phrases like "various updates" or "multiple developments".\n` +
    `- Cover at least 3 of the headlines explicitly; don't ignore the smaller ones.\n` +
    `- Labels: noun phrases, no trailing punctuation, same count and order as the headlines above.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { summary: null, labels: [] };
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(content);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
      labels: Array.isArray(parsed.labels)
        ? parsed.labels.map((l: unknown) => String(l).trim()).slice(0, articles.length)
        : [],
    };
  } catch {
    return { summary: null, labels: [] };
  }
}
