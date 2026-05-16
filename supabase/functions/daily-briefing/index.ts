import "@supabase/functions-js/edge-runtime.d.ts";
import { FEEDS, isTaiwanPhilippinesNews } from "./lib/sources.ts";
import { fetchFeed } from "./lib/rss.ts";
import { getTaipeiWeather, Weather } from "./lib/weather.ts";
import {
  upsertArticles,
  fetchTodaysArticles,
  saveBriefing,
  getBriefingForDate,
  ArticleRow,
  ArticleWithId,
} from "./lib/db.ts";
import { digestCategory, CategoryDigest } from "./lib/groq.ts";
import { sendTelegram, escapeHtml } from "./lib/telegram.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function triggerEmbedJob(): Promise<void> {
  await fetch(`${SUPABASE_URL}/functions/v1/embed-articles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(6000),
  });
}

function taipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function taipeiDateLong(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function shiftDay(yyyymmdd: string, delta: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function isTodayInTaipei(iso: string | null): boolean {
  if (!iso) return true;
  const today = taipeiDate();
  const articleDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return articleDay >= shiftDay(today, -1);
}

async function gatherArticles(briefingDate: string): Promise<ArticleRow[]> {
  const results: ArticleRow[] = [];
  const errors: string[] = [];

  await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const items = await fetchFeed(feed.url);
        for (const it of items) {
          if (!isTodayInTaipei(it.published_at)) continue;
          const textBlob = `${it.title} ${it.description}`;
          const isTwPh = isTaiwanPhilippinesNews(feed.category, textBlob);
          results.push({
            title: it.title.slice(0, 500),
            description: it.description.slice(0, 500),
            url: it.url,
            source: feed.source,
            category: isTwPh ? "tw-ph" : feed.category,
            published_at: it.published_at,
            briefing_date: briefingDate,
          });
        }
      } catch (err) {
        errors.push(`${feed.source}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  if (errors.length > 0) console.log("Feed errors:", errors.join(" | "));
  return results;
}

function dedupeByUrl(rows: ArticleRow[]): ArticleRow[] {
  const seen = new Set<string>();
  const out: ArticleRow[] = [];
  for (const r of rows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

const TITLE_STOPWORDS = new Set([
  "a","an","and","are","as","at","be","been","by","for","from","has","have",
  "in","is","it","its","of","on","or","that","the","to","was","were","will",
  "with","over","after","amid","says","said","says:","new","s","t",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Cosine similarity for two same-length numeric vectors.
// 512-d voyage-3-lite × ~5 kept items ≈ 2.5K ops per article — trivial CPU.
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Drop syndication + semantic duplicates. Prefer cosine similarity on
// embeddings when both items have them (catches semantic near-duplicates
// like "PMA Graduation Address" vs "PMA Graduation Speech" even when token
// overlap is low). Fall back to Jaccard on title tokens when either side
// lacks an embedding (new articles not yet processed by embed-articles, or
// a Voyage outage). The briefing therefore never breaks on embedding state.
const SEMANTIC_THRESHOLD = 0.85;
const JACCARD_THRESHOLD = 0.4;

function dedupeNearDuplicates(items: ArticleWithId[]): ArticleWithId[] {
  const kept: { item: ArticleWithId; tokens: Set<string> }[] = [];
  for (const item of items) {
    const tokens = titleTokens(item.title);
    const isDupe = kept.some((k) => {
      if (item.embedding && k.item.embedding) {
        return cosine(item.embedding, k.item.embedding) >= SEMANTIC_THRESHOLD;
      }
      return jaccard(tokens, k.tokens) >= JACCARD_THRESHOLD;
    });
    if (!isDupe) kept.push({ item, tokens });
  }
  return kept.map((k) => k.item);
}

function pickTop(rows: ArticleWithId[], category: string, n: number): ArticleWithId[] {
  const inCategory = rows.filter((r) => r.category === category);
  const deduped = dedupeNearDuplicates(inCategory);
  return deduped.slice(0, n);
}

function headlineLinks(items: ArticleWithId[], labels: string[]): string {
  return items
    .map((it, i) => {
      const text = (labels[i] && labels[i].trim()) || it.title;
      return `• <a href="${escapeHtml(it.url)}">${escapeHtml(text)}</a>`;
    })
    .join("\n");
}

function formatWeather(w: Weather | null): string {
  if (!w) return "🌤 Weather unavailable";
  const wxEmoji =
    w.precip_prob >= 70 ? "🌧" : w.precip_prob >= 40 ? "🌦" : w.code >= 1 && w.code <= 3 ? "⛅" : "☀️";
  const rainEmoji = w.precip_prob >= 40 ? "☔" : "💧";
  const tail = w.precip_prob >= 60 ? " · bring an umbrella" : "";
  return [
    `${wxEmoji} <b>${escapeHtml(w.summary)}</b> · ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C`,
    `${rainEmoji} ${escapeHtml(w.rain_window)}${tail}`,
  ].join("\n");
}

function section(emoji: string, label: string, digest: CategoryDigest, items: ArticleWithId[]): string {
  const header = `${emoji} <b>${label}</b>`;
  if (items.length === 0) return `${header}\n<i>(no items today)</i>`;
  const summaryBlock = digest.summary ? `<blockquote>${escapeHtml(digest.summary)}</blockquote>` : "";
  const parts = [header];
  if (summaryBlock) parts.push(summaryBlock);
  parts.push(headlineLinks(items, digest.labels));
  return parts.join("\n");
}

// Below this, the TW↔PH section is hidden entirely (header + bullet alone
// looks lonely). A single cross-cutting article better belongs as a footnote;
// for now we just suppress it until the day actually has cross-coverage.
const TW_PH_MIN_ITEMS = 2;

async function composeDigest(
  weather: Weather | null,
  rows: ArticleWithId[]
): Promise<string> {
  const tw = pickTop(rows, "tw-news", 5);
  const ph = pickTop(rows, "ph-news", 5);
  const twPh = pickTop(rows, "tw-ph", 5);

  const showTwPh = twPh.length >= TW_PH_MIN_ITEMS;

  const [twDigest, phDigest, twPhDigest] = await Promise.all([
    digestCategory("Taiwan", tw),
    digestCategory("Philippines", ph),
    showTwPh
      ? digestCategory("Taiwan and Philippines relations / overseas Filipino", twPh)
      : Promise.resolve<CategoryDigest>({ summary: null, labels: [] }),
  ]);

  const parts: string[] = [
    `☀️ <b>Good Morning Taipei</b>`,
    `<i>${escapeHtml(taipeiDateLong())}</i>`,
    ``,
    formatWeather(weather),
    ``,
    section("🇹🇼", "Taiwan", twDigest, tw),
    ``,
    section("🇵🇭", "Philippines", phDigest, ph),
  ];
  if (showTwPh) {
    parts.push("", section("🤝", "Taiwan ↔ Philippines", twPhDigest, twPh));
  }
  return parts.join("\n");
}

Deno.serve(async (req) => {
  const briefingDate = taipeiDate();

  let body: { force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  try {
    if (!body.force) {
      const existing = await getBriefingForDate(briefingDate);
      if (existing?.sent_at) {
        return new Response(
          JSON.stringify({
            skipped: true,
            briefing_date: briefingDate,
            already_sent_at: existing.sent_at,
            hint: "pass {\"force\":true} to override",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const [weather, rawArticles] = await Promise.all([
      getTaipeiWeather(),
      gatherArticles(briefingDate),
    ]);
    const deduped = dedupeByUrl(rawArticles);
    if (deduped.length > 0) await upsertArticles(deduped);

    // Fire-and-forget: kick the embed-articles function so freshly upserted
    // rows get vectors as soon as possible. Capped at 6s wall-clock so a slow
    // Voyage call can't stall the briefing — if it doesn't finish in time,
    // pickTop falls through to Jaccard dedupe for the new articles. The
    // /30-min cron picks up anything missed on the next pass.
    void triggerEmbedJob().catch(() => {});

    const articles = await fetchTodaysArticles(briefingDate);

    const message = await composeDigest(weather, articles);
    const sent = await sendTelegram(message);
    await saveBriefing(briefingDate, weather, message);

    return new Response(
      JSON.stringify({
        sent,
        briefing_date: briefingDate,
        article_count: articles.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sendTelegram(`<b>Briefing error:</b>\n${escapeHtml(errorMsg)}`);
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
