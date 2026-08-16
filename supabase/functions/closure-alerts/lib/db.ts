const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const HEADERS: Record<string, string> = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const DB_TIMEOUT_MS = 20000;

// Returns the subset of `ids` already present in closure_alerts_seen.
export async function fetchSeenIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const url = new URL(`${SUPABASE_URL}/rest/v1/closure_alerts_seen`);
  url.searchParams.set("select", "id");
  url.searchParams.set("id", `in.(${ids.join(",")})`);
  const res = await fetch(url.toString(), { headers: HEADERS, signal: AbortSignal.timeout(DB_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetchSeenIds: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export async function markSeen(id: string, locality: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/closure_alerts_seen`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id, locality }),
    signal: AbortSignal.timeout(DB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`markSeen: ${res.status} ${await res.text()}`);
}
