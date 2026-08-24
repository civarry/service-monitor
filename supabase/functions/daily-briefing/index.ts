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
import { sendTelegram, sendPhoto, escapeHtml } from "./lib/telegram.ts";
import { renderCard, CardSpec } from "./lib/card.ts";

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
          // Articles re-routed to tw-ph by the previous check are kept:
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
// articles by recency, which surfaces what everyone is actually talking about.
//
// Threshold tuned looser than dedupe (0.85): catches genuine same-event
// coverage with different angles, not just verbatim syndication. Members
// of a cluster are passed to the LLM as additional_coverage so the prompt
// can synthesize across outlets.
//
// Fallback to Jaccard for articles missing embeddings (Voyage outage or
// not-yet-processed), so the briefing never breaks on embedding state.
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

// Labels are 3-5 word phrases, but when Groq is down they fall back to the raw
// headline, which the articles table stores at up to 500 chars.
function labelFor(it: ArticleWithId, label: string | undefined): string {
  const raw = (label && label.trim()) || it.title;
  return raw.length > 70 ? `${raw.slice(0, 69).trimEnd()}…` : raw;
}

// The caption travels with the image when the card is forwarded, so it carries
// the sources rather than leaving a shared photo unattributed.
function sourceCaption(emoji: string, label: string, items: ArticleWithId[], labels: string[]): string {
  const links = items
    .map((it, i) => `▸ <a href="${escapeHtml(it.url)}">${escapeHtml(labelFor(it, labels[i]))}</a>`)
    .join("\n");
  return `<b>${emoji} ${escapeHtml(label)}</b> · <i>${escapeHtml(taipeiDateLong())}</i>\n${links}`;
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

// A text card is a plain message; a photo card is a rendered PNG whose caption
// carries the source links. `fallback` is the text form, used both to store
// message_text and to survive a rendering failure.
type Card =
  | { kind: "text"; text: string }
  | { kind: "photo"; spec: CardSpec; caption: string; fallback: string };

/**
 * `label` is the Telegram-facing name and may contain any character; `cardTitle`
 * is what gets drawn into the image and must stay within the font's coverage.
 * `digest` is the raw digest: cross-outlet counts come from `clusters` and are
 * drawn as chips, rather than being baked into the label text as "✦2", which no
 * Latin font subset can render.
 */
function sectionCard(
  emoji: string,
  label: string,
  cardTitle: string,
  accent: string,
  digest: CategoryDigest,
  clusters: Cluster[]
): Card {
  const header = `<b><u>${emoji} ${escapeHtml(label.toUpperCase())}</u></b>`;
  const items = clusters.map((c) => c.rep);
  if (items.length === 0) return { kind: "text", text: `${header}\n<i>nothing today</i>` };

  // Telegram text keeps the ✦ badges: they render fine outside the image.
  const badged = withClusterBadges(digest, clusters);
  const sources = [...new Set(items.map((it) => it.source))].join(", ");

  const fallbackParts = [header];
  if (digest.summary) fallbackParts.push(`<blockquote>${escapeHtml(digest.summary)}</blockquote>`);
  fallbackParts.push(
    items.map((it, i) => `▸ <a href="${escapeHtml(it.url)}">${escapeHtml(labelFor(it, badged.labels[i]))}</a>`).join("\n")
  );

  return {
    kind: "photo",
    spec: {
      eyebrow: "Good Morning Taipei",
      title: cardTitle,
      date: taipeiDateLong(),
      summary: digest.summary,
      items: items.map((it, i) => ({
        text: labelFor(it, digest.labels[i]),
        badge: clusters[i].members.length,
      })),
      accent,
      footer: `${items.length} ${items.length === 1 ? "story" : "stories"} · ${sources}`,
    },
    caption: sourceCaption(emoji, label, items, badged.labels),
    fallback: fallbackParts.join("\n"),
  };
}

// Below this, the TW↔PH section is hidden entirely (header + lonely bullet
// looks broken). Counted in distinct clusters, not articles: five articles
// of the same Marcos-OFW story would cluster to 1 and still be sparse.
const TW_PH_MIN_CLUSTERS = 2;

// One accent per section, the only thing that varies between cards.
const ACCENT_TW = "#DC2626";
const ACCENT_PH = "#1D4ED8";
const ACCENT_TWPH = "#059669";

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
): Promise<Card[]> {
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

  const cards: Card[] = [
    {
      kind: "text",
      text: [
        `☀️ <b>Good Morning Taipei</b>`,
        `<i>${escapeHtml(taipeiDateLong())}</i>`,
        ``,
        formatWeather(weather),
      ].join("\n"),
    },
    sectionCard("🇹🇼", "Taiwan", "Taiwan", ACCENT_TW, twDigest, twClusters),
    sectionCard("🇵🇭", "Philippines", "Philippines", ACCENT_PH, phDigest, phClusters),
  ];
  if (showTwPh) {
    cards.push(
      sectionCard(
        "🤝",
        "Taiwan ↔ Philippines",
        // No arrow glyph in the drawn title: U+2194 is outside the font subsets.
        "Taiwan & Philippines",
        ACCENT_TWPH,
        twPhDigest,
        twPhClusters
      )
    );
  }
  return cards;
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
      `🧹 <b>Repo hygiene</b>: ${h.passing}/${h.total} documented. ` +
      `Needs attention: ${escapeHtml(names)}${more} · /audit for details`
    );
  } catch {
    return null;
  }
}

// A briefing assembled around a failure should say so, in the place the reader
// actually looks, rather than only in a workflow log. Goes on the first card,
// which is the one that arrives with the notification.
function footerFor(message: string, degraded: string[]): string {
  if (degraded.length === 0) return message;
  // Step names only, capped: the reader needs to know the briefing may be
  // incomplete, not to read a stack of error strings. Full detail goes to the
  // .degraded field in the response, which the workflow logs.
  const steps = degraded.map((d) => d.split(":")[0]);
  const shown = escapeHtml(steps.slice(0, 3).join(", "));
  const more = steps.length > 3 ? ` +${steps.length - 3} more` : "";
  return `${message}\n\n<i>⚠️ assembled with degraded data: ${shown}${more}</i>`;
}

Deno.serve(async (req) => {
  const briefingDate = taipeiDate();

  let body: { force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  // Every step that is not "compose and send" is best-effort. A transient
  // Supabase blip used to abort the whole run and replace the briefing with an
  // error message; the briefing is the product, so anything that can be
  // survived is survived and recorded here instead.
  const degraded: string[] = [];
  const note = (step: string, err: unknown) =>
    degraded.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);

  try {
    if (!body.force) {
      // A dedup check that cannot be completed is not a reason to skip: the
      // worst case is a duplicate briefing, which beats a silent miss.
      let existing: { sent_at: string | null } | null = null;
      try {
        existing = await getBriefingForDate(briefingDate);
      } catch (err) {
        note("dedup check", err);
      }
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
      // formatWeather already renders a null weather as "unavailable".
      getTaipeiWeather().catch((err) => {
        note("weather", err);
        return null;
      }),
      gatherArticles(briefingDate),
    ]);

    const deduped = dedupeByUrl(rawArticles);
    if (deduped.length > 0) {
      try {
        await upsertArticles(deduped);
      } catch (err) {
        note("article upsert", err);
      }
    }

    // Embedding freshly upserted rows happens on the independent embed-articles
    // cron, not triggered from here, so clustering falls through to Jaccard for
    // articles too new to have vectors yet, and the /30-min cron catches up.
    //
    // The stored rows are preferred because they carry ids, embeddings and
    // cluster ids, so clustering can use vectors rather than Jaccard alone.
    // When the read fails, today's freshly gathered feed items stand in: a
    // database outage should cost briefing quality, not the briefing.
    let articles: ArticleWithId[] = [];
    try {
      articles = await fetchTodaysArticles(briefingDate);
    } catch (err) {
      note("article read", err);
    }
    if (articles.length === 0 && deduped.length > 0) {
      if (degraded.length > 0) note("source", new Error("composed from live feeds, not the database"));
      articles = deduped.map((r, i) => ({ ...r, id: `feed-${i}` }));
    }

    if (articles.length === 0) {
      throw new Error("no articles available from either the database or the feeds");
    }

    const cards = await composeDigest(weather, articles);
    if (cards[0].kind === "text") {
      cards[0].text = footerFor(cards[0].text, degraded);
    }

    // Sent in order, and only the first buzzes the phone: a four-card stack
    // that fires four notifications is worse than the wall of text it replaced.
    let sent = true;
    for (const [i, card] of cards.entries()) {
      const silent = i > 0;
      let ok: boolean;

      if (card.kind === "text") {
        ok = await sendTelegram(card.text, silent);
      } else {
        try {
          ok = await sendPhoto(await renderCard(card.spec), card.caption, silent);
        } catch (err) {
          // Rendering pulls fonts and a wasm binary over the network. If any of
          // that fails the section still goes out, as text.
          note(`card render (${card.spec.title})`, err);
          ok = await sendTelegram(card.fallback, silent);
        }
      }
      if (!ok) sent = false;
    }

    // Stored joined, since the briefings table holds one message_text per day
    // and it backs both the dedup check and the /brief history.
    const message = cards
      .map((c) => (c.kind === "text" ? c.text : c.fallback))
      .join("\n\n");

    // After the send, deliberately: failing to record a briefing that did go
    // out is a bookkeeping problem, and previously it raised a "Briefing
    // error" alert for a briefing the reader had already received.
    try {
      await saveBriefing(briefingDate, weather, message);
    } catch (err) {
      note("briefing save", err);
    }

    // Sent as its own message rather than appended to the news digest:
    // an unrelated repo-maintenance nag doesn't belong in the same bubble
    // as the morning weather/news briefing.
    try {
      const hygiene = await repoHygieneLine();
      if (hygiene) await sendTelegram(hygiene);
    } catch (err) {
      note("repo hygiene", err);
    }

    return new Response(
      JSON.stringify({
        sent,
        briefing_date: briefingDate,
        article_count: articles.length,
        degraded: degraded.length > 0 ? degraded : undefined,
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
