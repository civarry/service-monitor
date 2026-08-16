// Parses the NCDR (National Science and Technology Center for Disaster
// Reduction) CAP Atom feed for 停班停課 (work/school closure) alerts.
// This is the government's own designated machine-readable distribution
// channel for this data (linked from the DGPA dataset on data.gov.tw,
// rights: Public Domain) — not a scrape of the DGPA HTML page, which
// disallows all crawlers except Googlebot via robots.txt.
export const NCDR_FEED_URL = "https://alerts.ncdr.nat.gov.tw/RssAtomFeed.ashx?AlertType=33";

export interface ClosureAlert {
  id: string;
  locality: string;
  message: string; // full human-readable Chinese status text from the source
  link: string;
  effective: Date | null;
  expires: Date | null;
}

function extract(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  return m ? m[1].trim() : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// CAP dates in this feed look like "2026/8/9 上午 08:30:00" — always
// Taiwan wall-clock time (UTC+8), no explicit offset in the string itself.
function parseCapDateTime(raw: string): Date | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(上午|下午)\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, meridiem, hRaw, mi, s] = m;
  let h = parseInt(hRaw, 10);
  if (meridiem === "上午") { if (h === 12) h = 0; } else { if (h !== 12) h += 12; }
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${y}-${pad(parseInt(mo, 10))}-${pad(parseInt(d, 10))}T${pad(h)}:${mi}:${s}+08:00`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

// Source format: "[停班停課通知]<locality>:<status text>"
function parseLocalityAndMessage(summary: string): { locality: string; message: string } | null {
  const m = /^\[停班停課通知\]([^:]+):([\s\S]*)$/.exec(summary.trim());
  if (!m) return null;
  return { locality: m[1].trim(), message: m[2].trim() };
}

export async function fetchClosureAlerts(): Promise<ClosureAlert[]> {
  const res = await fetch(NCDR_FEED_URL, {
    headers: { "User-Agent": "civarry-closure-alerts/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ncdr feed: ${res.status}`);
  const xml = await res.text();

  const alerts: ClosureAlert[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const id = extract(block, "id");
    const summaryRaw = decodeEntities(extract(block, "summary"));
    const parsed = parseLocalityAndMessage(summaryRaw);
    if (!id || !parsed) continue;

    const linkMatch = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
    alerts.push({
      id,
      locality: parsed.locality,
      message: parsed.message,
      link: linkMatch ? linkMatch[1] : "",
      effective: parseCapDateTime(extract(block, "cap:effective")),
      expires: parseCapDateTime(extract(block, "cap:expires")),
    });
  }
  return alerts;
}
