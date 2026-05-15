const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GROQ_MODEL = "llama-3.1-8b-instant";

export interface SummarizableArticle {
  title: string;
  description?: string;
}

export async function summarizeCategory(
  label: string,
  articles: SummarizableArticle[]
): Promise<string | null> {
  if (articles.length === 0) return null;

  const bullets = articles
    .slice(0, 5)
    .map((a, i) => `${i + 1}. ${a.title}${a.description ? " — " + a.description.slice(0, 200) : ""}`)
    .join("\n");

  const prompt =
    `You are writing a morning briefing for a reader in Taipei. ` +
    `Summarize the following ${label} headlines into 2 short sentences (max 40 words total). ` +
    `Be specific. Mention concrete names/places only if present. ` +
    `No preamble, no hashtags, no emoji, no "Here is the summary" wording.\n\n` +
    `Headlines:\n${bullets}`;

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
        max_tokens: 200,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}
