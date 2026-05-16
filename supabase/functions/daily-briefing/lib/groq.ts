const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const FAST_MODEL = "llama-3.1-8b-instant";
const SMART_MODEL = "llama-3.3-70b-versatile";

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

async function pickLeadAndLabels(
  articles: SummarizableArticle[]
): Promise<{ lead_index: number; labels: string[] }> {
  const bullets = bulletList(articles);
  const prompt =
    `Headlines:\n${bullets}\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{\n` +
    `  "lead_index": <integer 1-${articles.length}>,\n` +
    `  "labels": ["3-5 word noun phrase for #1", "for #2", ...]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- lead_index = the SINGLE most consequential headline. Prefer: hard news over soft (volcanic eruptions, deaths, large financial figures over festivals or local color), national over local, named officials over anonymous events.\n` +
    `- labels: noun phrases, 3-5 words, no trailing punctuation, same count and order as headlines above.`;

  const parsed = await groqJSON(FAST_MODEL, prompt, 300);
  const leadRaw = parsed?.lead_index;
  const lead_index =
    typeof leadRaw === "number" && leadRaw >= 1 && leadRaw <= articles.length
      ? leadRaw
      : 1;
  const labels = Array.isArray(parsed?.labels)
    ? (parsed!.labels as unknown[])
        .map((l) => String(l).trim())
        .slice(0, articles.length)
    : [];
  return { lead_index, labels };
}

async function writeSummary(
  label: string,
  articles: SummarizableArticle[],
  leadIndex: number
): Promise<string | null> {
  const bullets = bulletList(articles);
  const safeIdx = Math.max(0, Math.min(articles.length - 1, leadIndex - 1));
  const lead = articles[safeIdx];

  const prompt =
    `You are a senior journalist writing the 7 AM ${label} section of a Taipei reader's morning briefing. ` +
    `Synthesize today's headlines into a fact-dense 3-sentence summary (roughly 70-90 words).\n\n` +
    `Headlines (numbered; description follows where available):\n${bullets}\n\n` +
    `LEAD WITH headline #${leadIndex}: "${lead.title}". Open with concrete details (names, figures, places, percentages) drawn from its description.\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{ "summary": "..." }\n\n` +
    `Hard rules:\n` +
    `- Exactly 3 sentences. Cover at least 3 different headlines from the list.\n` +
    `- Group related stories thematically when natural (e.g., "The Marcos administration moved on three fronts — A, B, and C"). Do NOT chain unrelated items with "Meanwhile...", "In other news...", "Also...".\n` +
    `- Use specific facts from the descriptions: dollar amounts, percentages, named people, place names.\n` +
    `- END ON A FACT. No editorial closer. BANNED phrases: "boon for", "is significant", "underscores", "highlights the importance", "reflects the country's", "speaks to", "this comes as", "remains to be seen", "a testament to", "marks a milestone", "is a positive sign".\n` +
    `- No preamble like "Today's news...". No hashtags, no emoji.\n` +
    `- If you cannot find a concrete fact for a story, omit it rather than inventing one.`;

  const parsed = await groqJSON(SMART_MODEL, prompt, 500);
  return typeof parsed?.summary === "string" ? parsed.summary.trim() : null;
}

export async function digestCategory(
  label: string,
  articles: SummarizableArticle[]
): Promise<CategoryDigest> {
  if (articles.length === 0) return { summary: null, labels: [] };
  const limited = articles.slice(0, 5);

  // Step 1: fast 8B model picks the lead + generates per-headline labels.
  const fast = await pickLeadAndLabels(limited);

  // Step 2: smart 70B model writes the summary, told which headline to lead with.
  const summary = await writeSummary(label, limited, fast.lead_index);

  return { summary, labels: fast.labels };
}
