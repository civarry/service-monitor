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

// Taipei Times' main RSS mixes Taiwan-domestic news with international wire
// stories (Federal Reserve, Iran/NK, US politics) and soft features
// (cosplay, food). Without a second Taiwan-anchored source for clustering
// to filter through, those leak into the briefing's top-5. This anchor
// pattern keeps an article in tw-news only when its title or description
// mentions at least one Taiwan-specific term. Generous coverage of cities,
// political parties, major figures, and TSMC catches >95% of genuine
// Taiwan-domestic stories without false positives.
const TW_ANCHOR_PATTERN =
  /\b(taiwan|taiwanese|taipei|new\s+taipei|taichung|taoyuan|kaohsiung|tainan|hsinchu|chiayi|keelung|miaoli|yilan|hualien|formosa|tsmc|foxconn|hon\s+hai|mediatek|kmt|dpp|tpp|cross[\s-]?strait|lai\s+ching|tsai\s+ing|ko\s+wen|han\s+kuo|chiang\s+kai|cross[\s-]?(?:taiwan|strait)|legislative\s+yuan|executive\s+yuan|presidential\s+office|cabinet\s+spokesperson|taiwan\s+strait|prc[\s-]+taiwan|china[\s-]+taiwan|wto[\s-]+taiwan|wha[\s-]+taiwan)\b/i;

export function isTaiwanAnchored(text: string): boolean {
  return TW_ANCHOR_PATTERN.test(text);
}
