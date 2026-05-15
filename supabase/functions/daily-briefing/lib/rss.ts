export interface RssItem {
  title: string;
  description: string;
  url: string;
  published_at: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extract(block: string, tag: string): string {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i").exec(block);
  if (cdata) return cdata[1].trim();
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return plain ? plain[1].trim() : "";
}

function extractLink(block: string): string {
  // RSS 2.0: <link>url</link>
  const rss = /<link[^>]*>([^<]+)<\/link>/i.exec(block);
  if (rss && rss[1].trim().startsWith("http")) return rss[1].trim();
  // Atom: <link href="url" />
  const atom = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  return atom ? atom[1] : "";
}

export function parseRss(xml: string, limit = 30): RssItem[] {
  const items: RssItem[] = [];
  const blockRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = decodeEntities(stripTags(extract(block, "title")));
    const url = decodeEntities(extractLink(block));
    if (!title || !url) continue;
    const descRaw = extract(block, "description") || extract(block, "summary") || extract(block, "content");
    const description = decodeEntities(stripTags(descRaw)).slice(0, 500);
    const pub = extract(block, "pubDate") || extract(block, "published") || extract(block, "updated");
    let iso: string | null = null;
    if (pub) {
      const d = new Date(pub);
      iso = isNaN(d.getTime()) ? null : d.toISOString();
    }
    items.push({ title, description, url, published_at: iso });
  }
  return items;
}

export async function fetchFeed(url: string): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "civarry-briefing/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const xml = await res.text();
  return parseRss(xml);
}
