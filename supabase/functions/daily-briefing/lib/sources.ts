export type Category = "tw-news" | "ph-news" | "tw-ph";

export interface Feed {
  source: string;
  url: string;
  category: Exclude<Category, "tw-ph">;
}

// Focus Taiwan (CNA English) does not currently expose a public RSS feed —
// every documented path (/rss/index, /rss, /feed, CNA's aspx variants)
// returns 404 as of May 2026. Leaving TW single-source until a working
// Taiwan-anchored English feed is identified.
export const FEEDS: Feed[] = [
  { source: "Taipei Times", url: "https://www.taipeitimes.com/xml/index.rss", category: "tw-news" },
  { source: "Inquirer", url: "https://newsinfo.inquirer.net/feed", category: "ph-news" },
  { source: "Philstar", url: "https://www.philstar.com/rss/headlines", category: "ph-news" },
];

const TW_PH_PATTERN =
  /\b(philippin\w*|filipino\w*|ofw|migrant\s+worker|manila|labor|visa|taiwan)\b/i;

export function isTaiwanPhilippinesNews(category: Category, text: string): boolean {
  const haystack = text.toLowerCase();
  if (category === "tw-news") {
    return /\b(philippin|filipino|ofw|migrant\s+worker|manila)\b/i.test(haystack);
  }
  if (category === "ph-news") {
    return /\b(taiwan|taipei|taipa|kaohsiung)\b/i.test(haystack);
  }
  return TW_PH_PATTERN.test(haystack);
}
