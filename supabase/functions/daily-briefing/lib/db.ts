const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const HEADERS: Record<string, string> = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

export interface ArticleRow {
  title: string;
  description: string;
  url: string;
  source: string;
  category: string;
  published_at: string | null;
  briefing_date: string;
}

export interface ArticleWithId extends ArticleRow {
  id: string;
  embedding?: number[] | null;
  cluster_id?: string | null;
}

export async function upsertArticles(rows: ArticleRow[]): Promise<void> {
  if (rows.length === 0) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/articles?on_conflict=url`,
    {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) throw new Error(`upsertArticles: ${res.status} ${await res.text()}`);
}

export async function fetchTodaysArticles(briefingDate: string): Promise<ArticleWithId[]> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/articles`);
  url.searchParams.set("briefing_date", `eq.${briefingDate}`);
  url.searchParams.set("select", "id,title,description,url,source,category,published_at,briefing_date,embedding,cluster_id");
  url.searchParams.set("order", "published_at.desc.nullslast");
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok) throw new Error(`fetchTodaysArticles: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as ArticleWithId[];
  return rows.map((r) => ({
    ...r,
    embedding: typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding,
  }));
}

export async function bulkSetEmbeddings(items: { id: string; embedding: string }[]): Promise<void> {
  if (items.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bulk_set_article_embeddings`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ payload: items }),
  });
  if (!res.ok) throw new Error(`bulkSetEmbeddings: ${res.status} ${await res.text()}`);
}

export async function bulkSetClusters(items: { id: string; cluster_id: string }[]): Promise<void> {
  if (items.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bulk_set_article_clusters`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ payload: items }),
  });
  if (!res.ok) throw new Error(`bulkSetClusters: ${res.status} ${await res.text()}`);
}

export async function clearTodaysClusters(briefingDate: string): Promise<void> {
  // Detach articles first so the FK-free relation stays clean
  await fetch(
    `${SUPABASE_URL}/rest/v1/articles?briefing_date=eq.${briefingDate}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ cluster_id: null }),
    }
  );
  await fetch(
    `${SUPABASE_URL}/rest/v1/clusters?briefing_date=eq.${briefingDate}`,
    { method: "DELETE", headers: HEADERS }
  );
}

export interface ClusterRow {
  id: string;
  category: string;
  briefing_date: string;
  article_count: number;
  topic_label?: string | null;
  summary?: string | null;
}

export async function insertClusters(rows: ClusterRow[]): Promise<void> {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/clusters`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insertClusters: ${res.status} ${await res.text()}`);
}

export async function getBriefingForDate(briefing_date: string): Promise<{ sent_at: string | null } | null> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/briefings`);
  url.searchParams.set("briefing_date", `eq.${briefing_date}`);
  url.searchParams.set("select", "sent_at");
  url.searchParams.set("limit", "1");
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

export async function saveBriefing(
  briefing_date: string,
  weather_json: unknown,
  message_text: string
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/briefings?on_conflict=briefing_date`,
    {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        briefing_date,
        weather_json,
        message_text,
        sent_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) throw new Error(`saveBriefing: ${res.status} ${await res.text()}`);
}
