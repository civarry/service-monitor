import "@supabase/functions-js/edge-runtime.d.ts";
import { fetchClosureAlerts, ClosureAlert } from "./lib/ncdr.ts";
import { fetchSeenIds, markSeen } from "./lib/db.ts";
import { sendTelegram, escapeHtml } from "./lib/telegram.ts";

// Only these cities trigger a Telegram alert. Match is by prefix so e.g.
// "桃園市復興區" (a district within Taoyuan) still matches "桃園市".
const TRACKED_LOCALITIES = ["臺北市", "新北市", "桃園市"];

function isTracked(locality: string): boolean {
  return TRACKED_LOCALITIES.some((city) => locality.startsWith(city));
}

function formatTaipeiTime(d: Date): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function formatAlert(a: ClosureAlert): string {
  const parts = [
    `⚠️ <b>停班停課通知</b>`,
    `<b>${escapeHtml(a.locality)}</b>`,
    ``,
    escapeHtml(a.message),
  ];
  if (a.effective) parts.push(``, `生效：${formatTaipeiTime(a.effective)}`);
  if (a.expires) parts.push(`有效至：${formatTaipeiTime(a.expires)}`);
  return parts.join("\n");
}

Deno.serve(async (_req) => {
  try {
    const alerts = await fetchClosureAlerts();
    const now = new Date();

    const candidates = alerts.filter(
      (a) => isTracked(a.locality) && (!a.expires || a.expires > now)
    );

    const seen = await fetchSeenIds(candidates.map((a) => a.id));
    const fresh = candidates.filter((a) => !seen.has(a.id));

    let sent = 0;
    for (const alert of fresh) {
      const ok = await sendTelegram(formatAlert(alert));
      if (ok) sent++;
      // Mark seen regardless of Telegram delivery outcome — a delivery
      // failure shouldn't cause the same alert to retry forever and spam
      // once Telegram recovers; the underlying event is still valid info
      // on the source's own site if this one message is lost.
      await markSeen(alert.id, alert.locality);
    }

    return new Response(
      JSON.stringify({
        checked: alerts.length,
        tracked_active: candidates.length,
        new: fresh.length,
        sent,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
