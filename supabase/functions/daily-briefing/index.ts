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
import { summarizeCategory } from "./lib/groq.ts";
import { sendTelegram, escapeHtml } from "./lib/telegram.ts";

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

function pickTop(rows: ArticleWithId[], category: string, n: number): ArticleWithId[] {
  return rows.filter((r) => r.category === category).slice(0, n);
}

function headlineLinks(items: ArticleWithId[]): string {
  if (items.length === 0) return "  (no items)";
  return items
    .map((it) => `• <a href="${escapeHtml(it.url)}">${escapeHtml(it.title)}</a>`)
    .join("\n");
}

function formatWeather(w: Weather | null): string {
  if (!w) return "🌤 Weather unavailable";
  const rainNote = w.precip_prob >= 60 ? " · ☔ bring an umbrella" : "";
  return `🌤 <b>${escapeHtml(w.summary)}</b> · ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C · Rain ${w.precip_prob}%${rainNote}`;
}

function section(emoji: string, label: string, summary: string | null, items: ArticleWithId[]): string {
  const header = `${emoji} <b>${label}</b> (${items.length})`;
  if (items.length === 0) return `${header}\n  (no items)`;
  const summaryLine = summary ? `<i>${escapeHtml(summary)}</i>\n` : "";
  return `${header}\n${summaryLine}${headlineLinks(items)}`;
}

async function composeDigest(
  weather: Weather | null,
  rows: ArticleWithId[]
): Promise<string> {
  const tw = pickTop(rows, "tw-news", 5);
  const ph = pickTop(rows, "ph-news", 5);
  const twPh = pickTop(rows, "tw-ph", 5);

  const [twSummary, phSummary, twPhSummary] = await Promise.all([
    summarizeCategory("Taiwan", tw),
    summarizeCategory("Philippines", ph),
    summarizeCategory("Taiwan and Philippines relations / overseas Filipino", twPh),
  ]);

  return [
    `☀️ <b>Good Morning Taipei</b>`,
    `<i>${escapeHtml(taipeiDateLong())}</i>`,
    ``,
    formatWeather(weather),
    ``,
    section("🇹🇼", "Taiwan", twSummary, tw),
    ``,
    section("🇵🇭", "Philippines", phSummary, ph),
    ``,
    section("🤝", "Taiwan ↔ Philippines", twPhSummary, twPh),
  ].join("\n");
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
