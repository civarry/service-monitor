import "@supabase/functions-js/edge-runtime.d.ts";
import { FEEDS, isTaiwanPhilippinesNews, isTaiwanAnchored } from "./lib/sources.ts";
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

          // For tw-news feeds (currently only Taipei Times), drop items that
          // don't mention any Taiwan-anchor term. Taipei Times' main feed
          // mixes in international wire (Fed Reserve, Iran/NK) and soft
          // features (cosplay) that don't belong in a Taipei-reader briefing.
          // Articles re-routed to tw-ph by the previous check are kept —
          // those are cross-coverage and intentionally cross-categorical.
          if (
            feed.category === "tw-news" &&
            !isTwPh &&
            !isTaiwanAnchored(textBlob)
          ) {
            continue;
          }

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

// Clustering: group articles about the same event across sources. The
// briefing then picks top clusters by SIZE (most-covered story), not top
// articles by recency — surfaces what everyone is actually talking about.
//
// Threshold tuned looser than dedupe (0.85): catches genuine same-event
// coverage with different angles, not just verbatim syndication. Members
// of a cluster are passed to the LLM as additional_coverage so the prompt
// can synthesize across outlets.
//
// Fallback to Jaccard for articles missing embeddings (Voyage outage or
// not-yet-processed) — briefing never breaks on embedding state.
const CLUSTER_COSINE_THRESHOLD = 0.80;
const CLUSTER_JACCARD_THRESHOLD = 0.4;

interface Cluster {
  rep: ArticleWithId;             // representative (most-recent member)
  members: ArticleWithId[];       // all members including rep
}

function clusterArticles(articles: ArticleWithId[]): Cluster[] {
  const clusters: Cluster[] = [];
  const repTokens = new Map<ArticleWithId, Set<string>>();

  for (const article of articles) {
    const itemTokens = titleTokens(article.title);
    let placed = false;

    for (const cluster of clusters) {
      const rep = cluster.rep;
      const cosScore =
        article.embedding && rep.embedding
          ? cosine(article.embedding, rep.embedding)
          : -1;
      const usedCosine = cosScore >= 0;
      const matches = usedCosine
        ? cosScore >= CLUSTER_COSINE_THRESHOLD
        : jaccard(itemTokens, repTokens.get(rep)!) >= CLUSTER_JACCARD_THRESHOLD;

      if (matches) {
        cluster.members.push(article);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({ rep: article, members: [article] });
      repTokens.set(article, itemTokens);
    }
  }

  // Sort: bigger clusters first (most-covered = most important by social
  // signal). Tiebreak by representative's recency, then by description
  // length (richer detail = better headline).
  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length) {
      return b.members.length - a.members.length;
    }
    const pa = a.rep.published_at || "";
    const pb = b.rep.published_at || "";
    if (pa !== pb) return pb.localeCompare(pa);
    return (b.rep.description?.length || 0) - (a.rep.description?.length || 0);
  });

  return clusters;
}

function pickTopClusters(
  rows: ArticleWithId[],
  category: string,
  n: number
): Cluster[] {
  let inCategory = rows.filter((r) => r.category === category);
  // Apply the Taiwan-anchor filter retroactively so already-stored DB rows
  // that predate the gather-time filter (e.g., Fed Reserve / cosplay stories
  // ingested before this fix) also get dropped from today's briefing.
  if (category === "tw-news") {
    inCategory = inCategory.filter((r) =>
      isTaiwanAnchored(`${r.title} ${r.description || ""}`)
    );
  }
  return clusterArticles(inCategory).slice(0, n);
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

// Below this, the TW↔PH section is hidden entirely (header + lonely bullet
// looks broken). Counted in distinct clusters, not articles — five articles
// of the same Marcos-OFW story would cluster to 1 and still be sparse.
const TW_PH_MIN_CLUSTERS = 2;

// Convert a Cluster into the shape digestCategory expects, attaching other
// outlets' descriptions as additional_coverage so the LLM can synthesize.
function clusterForDigest(c: Cluster) {
  const others = c.members.slice(1); // drop the rep itself
  return {
    title: c.rep.title,
    description: c.rep.description,
    additional_coverage: others.map((m) => ({
      source: m.source,
      description: m.description,
    })),
  };
}

// Append a "✦N" badge to labels for multi-outlet clusters so the reader can
// see clustering working at a glance. Singletons (size 1) get no badge.
function withClusterBadges(
  digest: CategoryDigest,
  clusters: Cluster[]
): CategoryDigest {
  return {
    summary: digest.summary,
    labels: digest.labels.map((label, i) => {
      const c = clusters[i];
      if (!c || c.members.length < 2) return label;
      return `${label} ✦${c.members.length}`;
    }),
  };
}

async function composeDigest(
  weather: Weather | null,
  rows: ArticleWithId[]
): Promise<string> {
  const twClusters = pickTopClusters(rows, "tw-news", 5);
  const phClusters = pickTopClusters(rows, "ph-news", 5);
  const twPhClusters = pickTopClusters(rows, "tw-ph", 5);

  const showTwPh = twPhClusters.length >= TW_PH_MIN_CLUSTERS;

  const [twDigest, phDigest, twPhDigest] = await Promise.all([
    digestCategory("Taiwan", twClusters.map(clusterForDigest)),
    digestCategory("Philippines", phClusters.map(clusterForDigest)),
    showTwPh
      ? digestCategory(
          "Taiwan and Philippines relations / overseas Filipino",
          twPhClusters.map(clusterForDigest)
        )
      : Promise.resolve<CategoryDigest>({ summary: null, labels: [] }),
  ]);

  const parts: string[] = [
    `☀️ <b>Good Morning Taipei</b>`,
    `<i>${escapeHtml(taipeiDateLong())}</i>`,
    ``,
    formatWeather(weather),
    ``,
    section("🇹🇼", "Taiwan", withClusterBadges(twDigest, twClusters), twClusters.map((c) => c.rep)),
    ``,
    section("🇵🇭", "Philippines", withClusterBadges(phDigest, phClusters), phClusters.map((c) => c.rep)),
  ];
  if (showTwPh) {
    parts.push(
      "",
      section(
        "🤝",
        "Taiwan ↔ Philippines",
        withClusterBadges(twPhDigest, twPhClusters),
        twPhClusters.map((c) => c.rep)
      )
    );
  }
  return parts.join("\n");
}

// One-line repo hygiene nag, appended only when repos fail the
// documentation standard (data from the nightly Update Repo Health action)
async function repoHygieneLine(): Promise<string | null> {
  try {
    const res = await fetch("https://civarry.github.io/repo_health.json");
    if (!res.ok) return null;
    const h = (await res.json()) as {
      total: number;
      passing: number;
      repos: { name: string; missing: string[] }[];
    };
    const failing = h.repos.filter((r) => r.missing.length > 0);
    if (failing.length === 0) return null;
    const names = failing.slice(0, 5).map((r) => r.name).join(", ");
    const more = failing.length > 5 ? ` +${failing.length - 5} more` : "";
    return (
      `🧹 <b>Repo hygiene</b> — ${h.passing}/${h.total} documented. ` +
      `Needs attention: ${escapeHtml(names)}${more} · /audit for details`
    );
  } catch {
    return null;
  }
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
    // clustering falls through to Jaccard for the new articles. The /30-min
    // cron picks up anything missed on the next pass.
    void triggerEmbedJob().catch(() => {});

    const articles = await fetchTodaysArticles(briefingDate);

    let message = await composeDigest(weather, articles);
    const hygiene = await repoHygieneLine();
    if (hygiene) message += `\n\n${hygiene}`;
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
