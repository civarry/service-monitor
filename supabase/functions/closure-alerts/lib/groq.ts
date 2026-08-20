const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
// Groq retired llama-3.1-8b-instant. gpt-oss-20b is a reasoning model, so
// reasoning tokens count against max_tokens — hence the larger budget.
const FAST_MODEL = "openai/gpt-oss-20b";

export interface Translation {
  localityEn: string;
  messageEn: string;
}

// Best-effort: returns null on any failure so the Telegram message still
// sends with the original Chinese text rather than being blocked entirely.
export async function translateAlert(locality: string, message: string): Promise<Translation | null> {
  const prompt =
    `Translate this Taiwanese government work/school closure alert into natural, concise English.\n\n` +
    `Locality: ${locality}\n` +
    `Message: ${message}\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{ "locality_en": "English name, e.g. Fuxing District, Taoyuan City", "message_en": "one short sentence" }`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.1,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(content);
    if (typeof parsed.locality_en !== "string" || typeof parsed.message_en !== "string") return null;
    return { localityEn: parsed.locality_en, messageEn: parsed.message_en };
  } catch {
    return null;
  }
}
