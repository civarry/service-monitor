import satori from "npm:satori@0.10.13";
import { Resvg, initWasm } from "npm:@resvg/resvg-wasm@2.6.2";
import { woffCodepoints } from "./woff.ts";

const FONT_BASE = "https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

// One design system, reused by every card: one spacing scale, one font, one
// rule weight, one radius. Accent is the only thing that varies per section.
const INK = "#0F172A";
const BODY = "#334155";
const MUTED = "#94A3B8";
const HAIRLINE = "#E2E8F0";
const PAPER = "#FFFFFF";

export interface CardItem {
  text: string;
  /** Number of outlets covering the story; rendered as a chip, never a glyph. */
  badge?: number;
}

export interface CardSpec {
  eyebrow: string;
  title: string;
  date: string;
  summary: string | null;
  items: CardItem[];
  accent: string;
  footer: string;
}

let fontsPromise: Promise<{ name: string; data: ArrayBuffer; weight: 400 | 600 | 700; style: "normal" }[]> | null = null;
let wasmReady: Promise<void> | null = null;

// latin covers ASCII, accents, curly quotes, dashes and the degree sign;
// latin-ext adds the currency block, where ₱ lives, and Philippine headlines quote
// peso figures constantly.
//
// The two subsets MUST carry different family names. satori resolves a family
// to the first font matching the requested weight and never consults a second
// entry with the same name, so registering both as "Inter" silently hides
// latin-ext and ₱ renders as tofu. FAMILY declares the fallback order instead.
const SUBSETS = [
  { subset: "latin", family: "Inter" },
  { subset: "latin-ext", family: "InterExt" },
] as const;

export const FAMILY = SUBSETS.map((s) => s.family).join(", ");

let supported: Set<number> | null = null;

function loadFonts() {
  if (!fontsPromise) {
    const wanted = ([400, 600, 700] as const).flatMap((weight) =>
      SUBSETS.map(({ subset, family }) => ({ weight, subset, family }))
    );
    fontsPromise = (async () => {
      const loaded = await Promise.all(
        wanted.map(async ({ weight, subset, family }) => ({
          name: family,
          data: await fetch(`${FONT_BASE}/inter-${subset}-${weight}-normal.woff`).then((r) => r.arrayBuffer()),
          weight,
          style: "normal" as const,
        }))
      );
      // Coverage is read from the fonts themselves rather than a hand-kept
      // range list. A published subset range and what the file actually
      // contains are not the same thing, and the gap shows up as tofu.
      const cps = new Set<number>();
      for (const f of loaded) {
        try {
          (await woffCodepoints(f.data)).forEach((c) => cps.add(c));
        } catch { /* a font whose cmap will not parse just contributes nothing */ }
      }
      if (cps.size > 0) supported = cps;
      return loaded;
    })();
  }
  return fontsPromise;
}

/**
 * Drops any character the loaded fonts cannot draw. A missing character reads
 * as a small gap; a tofu block reads as a bug. Runs against real cmap coverage,
 * so it stays correct if the fonts change.
 */
export function sanitize(text: string): string {
  if (!supported) return text;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || supported.has(cp)) out += ch;
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = fetch(WASM_URL).then((r) => r.arrayBuffer()).then((b) => initWasm(b));
  }
  return wasmReady;
}

const el = (type: string, style: Record<string, unknown>, children?: unknown) =>
  ({ type, props: { style, ...(children === undefined ? {} : { children }) } });

function storyRow(item: CardItem, i: number, accent: string, last: boolean) {
  const line: unknown[] = [
    el("div", { display: "flex", fontSize: 31, fontWeight: 600, color: INK, lineHeight: 1.3 }, sanitize(item.text)),
  ];
  // The cross-outlet count used to ride along in the label text as "✦2", which
  // no Latin subset can draw. As a chip it reads better and cannot tofu.
  if (item.badge && item.badge > 1) {
    line.push(el("div", {
      display: "flex", alignItems: "center", marginLeft: 14, marginTop: 4,
      paddingLeft: 12, paddingRight: 12, paddingTop: 3, paddingBottom: 5,
      borderRadius: 999, background: accent, color: "#FFFFFF",
      fontSize: 19, fontWeight: 700, flexShrink: 0,
    }, `${item.badge} outlets`));
  }

  return el("div", {
    display: "flex", alignItems: "flex-start", gap: 24,
    paddingTop: 22, paddingBottom: 22,
    borderBottom: last ? "none" : `2px solid ${HAIRLINE}`,
  }, [
    el("div", { fontSize: 24, fontWeight: 700, color: accent, width: 46, flexShrink: 0, paddingTop: 6 },
      String(i + 1).padStart(2, "0")),
    el("div", { display: "flex", flexWrap: "wrap", alignItems: "flex-start", flexGrow: 1 }, line),
  ]);
}

export async function renderCard(spec: CardSpec): Promise<Uint8Array> {
  const fonts = await loadFonts();

  const body: unknown[] = [
    el("div", { display: "flex", height: 14, background: spec.accent }),
    el("div", { display: "flex", flexDirection: "column", padding: "56px 72px 48px 72px", flexGrow: 1 }, [
      el("div", { fontSize: 23, fontWeight: 700, letterSpacing: 4, color: spec.accent }, sanitize(spec.eyebrow).toUpperCase()),
      el("div", { fontSize: 92, fontWeight: 700, color: INK, letterSpacing: -2, marginTop: 14, lineHeight: 1.05 }, sanitize(spec.title)),
      el("div", { fontSize: 27, color: MUTED, marginTop: 14 }, sanitize(spec.date)),
      ...(spec.summary
        ? [el("div", { fontSize: 32, color: BODY, lineHeight: 1.55, marginTop: 40 }, sanitize(spec.summary))]
        : []),
      el("div", {
        fontSize: 21, fontWeight: 700, letterSpacing: 4, color: MUTED,
        marginTop: 48, paddingBottom: 10, borderBottom: `3px solid ${INK}`,
      }, "TOP STORIES"),
      el("div", { display: "flex", flexDirection: "column" },
        spec.items.map((it, i) => storyRow(it, i, spec.accent, i === spec.items.length - 1))),
      el("div", { display: "flex", flexGrow: 1 }),
      el("div", {
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 40, paddingTop: 24, borderTop: `2px solid ${HAIRLINE}`,
        fontSize: 23, color: MUTED,
      }, [
        el("div", { display: "flex", fontWeight: 600 }, sanitize(spec.footer)),
        el("div", { display: "flex", fontWeight: 600, color: spec.accent }, "civarry.github.io"),
      ]),
    ]),
  ];

  const svg = await satori(
    el("div", {
      display: "flex", flexDirection: "column",
      width: 1080, minHeight: 1350, background: PAPER, fontFamily: FAMILY,
    }, body),
    { width: 1080, fonts }
  );

  await ensureWasm();
  return new Resvg(svg, { fitTo: { mode: "width", value: 1080 } }).render().asPng();
}
