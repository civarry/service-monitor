// Reads the set of codepoints a WOFF actually contains, so text can be filtered
// against real coverage instead of a hand-maintained range list.
async function inflate(buf: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([new Uint8Array(buf)]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function woffCodepoints(woff: ArrayBuffer): Promise<Set<number>> {
  const v = new DataView(woff);
  if (v.getUint32(0) !== 0x774f4646) throw new Error("not a WOFF");
  const numTables = v.getUint16(12);

  let cmap: Uint8Array | null = null;
  for (let i = 0; i < numTables; i++) {
    const p = 44 + i * 20;
    const tag = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    if (tag !== "cmap") continue;
    const off = v.getUint32(p + 4), comp = v.getUint32(p + 8), orig = v.getUint32(p + 12);
    const raw = new Uint8Array(woff, off, comp);
    cmap = comp < orig ? await inflate(raw) : raw;
    break;
  }
  if (!cmap) throw new Error("no cmap table");

  const c = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const out = new Set<number>();
  const n = c.getUint16(2);
  for (let i = 0; i < n; i++) {
    const rec = 4 + i * 8;
    const plat = c.getUint16(rec), enc = c.getUint16(rec + 2), sub = c.getUint32(rec + 4);
    const unicode = plat === 0 || (plat === 3 && (enc === 1 || enc === 10));
    if (!unicode) continue;
    const fmt = c.getUint16(sub);
    if (fmt === 4) {
      const segX2 = c.getUint16(sub + 6), seg = segX2 / 2;
      const endP = sub + 14, startP = endP + segX2 + 2;
      for (let s = 0; s < seg; s++) {
        const end = c.getUint16(endP + s * 2), start = c.getUint16(startP + s * 2);
        if (start === 0xffff) continue;
        for (let cp = start; cp <= Math.min(end, 0xfffe); cp++) out.add(cp);
      }
    } else if (fmt === 12) {
      const groups = c.getUint32(sub + 12);
      for (let g = 0; g < groups; g++) {
        const p = sub + 16 + g * 12;
        const start = c.getUint32(p), end = c.getUint32(p + 4);
        for (let cp = start; cp <= Math.min(end, 0x2ffff); cp++) out.add(cp);
      }
    }
  }
  return out;
}
