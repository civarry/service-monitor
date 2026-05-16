const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const FAST_MODEL = "llama-3.1-8b-instant";
const SMART_MODEL = "llama-3.3-70b-versatile";

// Skip prose synthesis below this threshold — too thin to summarize without
// hallucinating filler or meta-narrating about gaps. Bullets alone suffice.
const MIN_ARTICLES_FOR_SUMMARY = 3;

export interface SummarizableArticle {
  title: string;
  description?: string;
}

export interface CategoryDigest {
  summary: string | null;
  labels: string[]; // same order/length as input articles
}

function bulletList(articles: SummarizableArticle[]): string {
  return articles
    .map(
      (a, i) =>
        `${i + 1}. ${a.title}${a.description ? "\n   " + a.description.slice(0, 400) : ""}`
    )
    .join("\n");
}

async function groqJSON(
  model: string,
  prompt: string,
  maxTokens: number
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function generateLabels(
  articles: SummarizableArticle[]
): Promise<string[]> {
  const bullets = bulletList(articles);
  const prompt =
    `Headlines:\n${bullets}\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{ "labels": ["3-5 word noun phrase for #1", "for #2", ...] }\n\n` +
    `Rules:\n` +
    `- One label per headline, 3-5 words, noun phrase.\n` +
    `- No trailing punctuation, no quotes, no hashtags.\n` +
    `- Same count and order as headlines above.`;

  const parsed = await groqJSON(FAST_MODEL, prompt, 300);
  return Array.isArray(parsed?.labels)
    ? (parsed!.labels as unknown[])
        .map((l) => String(l).trim())
        .slice(0, articles.length)
    : [];
}

async function writeSummary(
  label: string,
  articles: SummarizableArticle[]
): Promise<string | null> {
  const bullets = bulletList(articles);

  const prompt =
    `You are a senior journalist writing the 7 AM ${label} section of a Taipei reader's morning briefing.\n\n` +
    `Headlines (numbered; description follows where available):\n${bullets}\n\n` +
    `Write a fact-dense 3-sentence summary (roughly 70-90 words total).\n\n` +
    `LEAD SELECTION — open with the SINGLE most consequential story. Use this ranking:\n` +
    `  HIGH consequence: natural disasters in progress (eruptions, typhoons, earthquakes), deaths affecting many, large financial figures (NT$/PHP billions), national-security or military actions, named government officials acting on policy, large-scale protests, public-health events.\n` +
    `  LOW consequence: local crime, individual missing-persons (unless tied to a broader event), festivals, soft features, board appointments, individual scholarships, weather absent disaster.\n` +
    `If multiple HIGH items exist, prefer the one with the most concrete numeric/named detail in its description.\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{ "summary": "..." }\n\n` +
    `Hard rules:\n` +
    `- Exactly 3 sentences. Cover at least 3 different headlines from the list.\n` +
    `- Group related stories thematically when natural (e.g., "The Marcos administration moved on three fronts — A, B, and C"). Do NOT chain unrelated items with "Meanwhile...", "In other news...", "Also...".\n` +
    `- Use specific facts from the descriptions: dollar amounts, percentages, named people, place names, times.\n` +
    `- END ON A FACT. No editorial closer. BANNED phrases: "boon for", "is significant", "underscores", "highlights the importance", "reflects the country's", "speaks to", "this comes as", "remains to be seen", "a testament to", "marks a milestone", "is a positive sign".\n` +
    `- NEVER meta-narrate about the input. BANNED phrases: "details are scarce", "no other major developments", "limited information", "other headlines mention", "the rest of the news", "remaining stories".\n` +
    `- If a headline lacks a concrete fact, silently omit it rather than apologizing for the gap or inventing one.\n` +
    `- No preamble like "Today's news...". No hashtags, no emoji.`;

  const parsed = await groqJSON(SMART_MODEL, prompt, 500);
  return typeof parsed?.summary === "string" ? parsed.summary.trim() : null;
}

export async function digestCategory(
  label: string,
  articles: SummarizableArticle[]
): Promise<CategoryDigest> {
  if (articles.length === 0) return { summary: null, labels: [] };
  const limited = articles.slice(0, 5);

  // Thin section — only labels, no synthesis. The section() renderer handles
  // a null summary by emitting just the header + bullets.
  if (limited.length < MIN_ARTICLES_FOR_SUMMARY) {
    const labels = await generateLabels(limited);
    return { summary: null, labels };
  }

  // Labels (8B, cheap) and summary (70B, smart, picks own lead) in parallel.
  const [labels, summary] = await Promise.all([
    generateLabels(limited),
    writeSummary(label, limited),
  ]);

  return { summary, labels };
}
