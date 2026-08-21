import satori from "npm:satori@0.10.13";
import { Resvg, initWasm } from "npm:@resvg/resvg-wasm@2.6.2";

const FONT_BASE = "https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

// One design system, reused by every card: one spacing scale, one font, one
// rule weight, one radius. Accent is the only thing that varies per section.
const INK = "#0F172A";
const BODY = "#334155";
const MUTED = "#94A3B8";
const HAIRLINE = "#E2E8F0";
const PAPER = "#FFFFFF";

export interface CardSpec {
  eyebrow: string;
  title: string;
  date: string;
  summary: string | null;
  items: string[];
  accent: string;
  footer: string;
}

let fontsPromise: Promise<{ name: string; data: ArrayBuffer; weight: 400 | 600 | 700; style: "normal" }[]> | null = null;
let wasmReady: Promise<void> | null = null;

function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all(
      ([400, 600, 700] as const).map(async (weight) => ({
        name: "Inter",
        data: await fetch(`${FONT_BASE}/inter-latin-${weight}-normal.woff`).then((r) => r.arrayBuffer()),
        weight,
        style: "normal" as const,
      }))
    );
  }
  return fontsPromise;
}

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = fetch(WASM_URL).then((r) => r.arrayBuffer()).then((b) => initWasm(b));
  }
  return wasmReady;
}

const el = (type: string, style: Record<string, unknown>, children?: unknown) =>
  ({ type, props: { style, ...(children === undefined ? {} : { children }) } });

function storyRow(text: string, i: number, accent: string, last: boolean) {
  return el("div", {
    display: "flex", alignItems: "flex-start", gap: 24,
    paddingTop: 22, paddingBottom: 22,
    borderBottom: last ? "none" : `2px solid ${HAIRLINE}`,
  }, [
    el("div", { fontSize: 24, fontWeight: 700, color: accent, width: 46, flexShrink: 0, paddingTop: 6 },
      String(i + 1).padStart(2, "0")),
    el("div", { fontSize: 31, fontWeight: 600, color: INK, lineHeight: 1.3, flexGrow: 1 }, text),
  ]);
}

export async function renderCard(spec: CardSpec): Promise<Uint8Array> {
  const fonts = await loadFonts();

  const body: unknown[] = [
    el("div", { display: "flex", height: 14, background: spec.accent }),
    el("div", { display: "flex", flexDirection: "column", padding: "56px 72px 48px 72px", flexGrow: 1 }, [
      el("div", { fontSize: 23, fontWeight: 700, letterSpacing: 4, color: spec.accent }, spec.eyebrow.toUpperCase()),
      el("div", { fontSize: 92, fontWeight: 700, color: INK, letterSpacing: -2, marginTop: 14, lineHeight: 1.05 }, spec.title),
      el("div", { fontSize: 27, color: MUTED, marginTop: 14 }, spec.date),
      ...(spec.summary
        ? [el("div", { fontSize: 32, color: BODY, lineHeight: 1.55, marginTop: 40 }, spec.summary)]
        : []),
      el("div", {
        fontSize: 21, fontWeight: 700, letterSpacing: 4, color: MUTED,
        marginTop: 48, paddingBottom: 10, borderBottom: `3px solid ${INK}`,
      }, "TOP STORIES"),
      el("div", { display: "flex", flexDirection: "column" },
        spec.items.map((t, i) => storyRow(t, i, spec.accent, i === spec.items.length - 1))),
      el("div", { display: "flex", flexGrow: 1 }),
      el("div", {
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 40, paddingTop: 24, borderTop: `2px solid ${HAIRLINE}`,
        fontSize: 23, color: MUTED,
      }, [
        el("div", { display: "flex", fontWeight: 600 }, spec.footer),
        el("div", { display: "flex", fontWeight: 600, color: spec.accent }, "civarry.github.io"),
      ]),
    ]),
  ];

  const svg = await satori(
    el("div", {
      display: "flex", flexDirection: "column",
      width: 1080, minHeight: 1350, background: PAPER, fontFamily: "Inter",
    }, body),
    { width: 1080, fonts }
  );

  await ensureWasm();
  return new Resvg(svg, { fitTo: { mode: "width", value: 1080 } }).render().asPng();
}
