// @ts-ignore — Supabase global injected at runtime in edge functions
let _session: { run: (text: string, opts: unknown) => Promise<number[]> } | null = null;

function getSession() {
  if (!_session) {
    // @ts-ignore — Supabase.ai is provided by the edge runtime
    _session = new Supabase.ai.Session("gte-small");
  }
  return _session!;
}

export async function embedText(text: string): Promise<number[]> {
  const session = getSession();
  const out = await session.run(text, { mean_pool: true, normalize: true });
  return out as unknown as number[];
}

export function toPgVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
