import "@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY")!;

const VOYAGE_MODEL = "voyage-3-lite"; // 512-d vectors
const VOYAGE_BATCH = 128;             // max inputs per Voyage call
const LOOKBACK_DAYS = 2;              // only embed articles from today / yesterday
const FETCH_LIMIT = 500;              // safety cap per invocation

const HEADERS: Record<string, string> = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

interface PendingArticle {
  id: string;
  title: string;
  description: string | null;
}

function taipeiDateShifted(daysAgo: number): string {
  const now = new Date();
  const shifted = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

async function fetchPending(): Promise<PendingArticle[]> {
  const cutoff = taipeiDateShifted(LOOKBACK_DAYS);
  const url = new URL(`${SUPABASE_URL}/rest/v1/articles`);
  url.searchParams.set("embedding", "is.null");
  url.searchParams.set("briefing_date", `gte.${cutoff}`);
  url.searchParams.set("select", "id,title,description");
  url.searchParams.set("order", "briefing_date.desc,published_at.desc.nullslast");
  url.searchParams.set("limit", String(FETCH_LIMIT));
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`fetchPending: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

function buildText(a: PendingArticle): string {
  const title = (a.title || "").trim();
  const desc = (a.description || "").trim();
  // Cap to ~2000 chars; Voyage charges by tokens and headlines+leads rarely need more.
  const combined = desc ? `${title}\n${desc}` : title;
  return combined.slice(0, 2000);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: "document",
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const arr = (data.data || []) as { embedding: number[]; index: number }[];
  arr.sort((a, b) => a.index - b.index);
  return arr.map((d) => d.embedding);
}

async function persistEmbeddings(
  items: { id: string; embedding: string }[]
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/bulk_set_article_embeddings`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ payload: items }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `bulk_set_article_embeddings: ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }
}

Deno.serve(async (_req) => {
  try {
    const pending = await fetchPending();
    if (pending.length === 0) {
      return new Response(
        JSON.stringify({ embedded: 0, message: "no pending articles" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    let total = 0;
    const errors: string[] = [];

    for (let i = 0; i < pending.length; i += VOYAGE_BATCH) {
      const batch = pending.slice(i, i + VOYAGE_BATCH);
      try {
        const vectors = await embedBatch(batch.map(buildText));
        if (vectors.length !== batch.length) {
          throw new Error(
            `vector count mismatch: got ${vectors.length} for ${batch.length} inputs`
          );
        }
        const items = batch.map((a, j) => ({
          id: a.id,
          embedding: JSON.stringify(vectors[j]),
        }));
        await persistEmbeddings(items);
        total += batch.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`batch ${i / VOYAGE_BATCH}: ${msg}`);
      }
    }

    return new Response(
      JSON.stringify({
        embedded: total,
        pending_total: pending.length,
        errors: errors.length ? errors : undefined,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("embed-articles fatal:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
