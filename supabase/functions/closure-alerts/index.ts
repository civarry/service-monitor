import "@supabase/functions-js/edge-runtime.d.ts";
import { fetchClosureAlerts, ClosureAlert } from "./lib/ncdr.ts";
import { fetchSeenIds, markSeen } from "./lib/db.ts";
import { sendTelegram, escapeHtml } from "./lib/telegram.ts";
import { translateAlert, Translation } from "./lib/groq.ts";

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

function formatAlert(a: ClosureAlert, translation: Translation | null): string {
  const parts = [
    `⚠️ <b>停班停課 / CLOSURE</b>`,
    translation
      ? `<b>${escapeHtml(a.locality)}</b> · ${escapeHtml(translation.localityEn)}`
      : `<b>${escapeHtml(a.locality)}</b>`,
    ``,
  ];

  // Chinese original and English rendering share one quote block: they are the
  // same notice, and splitting them into two blocks reads as two alerts.
  const body = translation
    ? `${escapeHtml(a.message)}\n\n${escapeHtml(translation.messageEn)}`
    : escapeHtml(a.message);
  parts.push(`<blockquote expandable>${body}</blockquote>`);

  const window: string[] = [];
  if (a.effective) window.push(`Effective ${formatTaipeiTime(a.effective)}`);
  if (a.expires) window.push(`Expires ${formatTaipeiTime(a.expires)}`);
  if (window.length > 0) parts.push(``, `<i>${window.join(" · ")}</i>`);

  return parts.join("\n");
}

// Injects one synthetic alert instead of fetching the real feed, so
// end-to-end delivery (Telegram formatting, dedup) can be verified without
// waiting for an actual typhoon. Uses a fixed id, so a second {"test":true}
// call correctly reports "new":0 — proving dedup works too.
function makeTestAlert(): ClosureAlert {
  const now = new Date();
  return {
    id: "test_manual_alert",
    locality: "臺北市",
    message: "這是手動觸發的測試訊息，用於驗證 Telegram 通知功能是否正常運作。",
    link: "",
    effective: now,
    expires: new Date(now.getTime() + 3600_000),
  };
}

Deno.serve(async (req) => {
  try {
    let body: { test?: boolean } = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }

    const alerts = body.test ? [makeTestAlert()] : await fetchClosureAlerts();
    const now = new Date();

    // Translate everything in the feed once, up front, so both the actual
    // Telegram alert (for new ones) and the /closures feed summary (for
    // everything) show English — not just whichever entries happen to be new.
    const translations = new Map<string, Translation | null>(
      await Promise.all(
        alerts.map(async (a) => [a.id, await translateAlert(a.locality, a.message)] as const)
      )
    );

    // Fetched for the whole feed (not just candidates) so the /closures
    // summary can correctly report "already sent" vs. "not yet due" per
    // entry, instead of guessing from tracked/expired alone.
    const seen = await fetchSeenIds(alerts.map((a) => a.id));

    const candidates = alerts.filter(
      (a) => isTracked(a.locality) && (!a.expires || a.expires > now)
    );
    const fresh = candidates.filter((a) => !seen.has(a.id));

    let sent = 0;
    for (const alert of fresh) {
      const ok = await sendTelegram(formatAlert(alert, translations.get(alert.id) ?? null));
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
        // Everything currently in the feed, tracked or not, expired or not —
        // lets a caller (e.g. the /closures Telegram command) show what's
        // actually there instead of just a count.
        feed: alerts.map((a) => {
          const t = translations.get(a.id) ?? null;
          return {
            locality: a.locality,
            locality_en: t?.localityEn ?? null,
            message: a.message,
            message_en: t?.messageEn ?? null,
            tracked: isTracked(a.locality),
            expires: a.expires ? a.expires.toISOString() : null,
            expired: a.expires ? a.expires <= now : false,
            already_sent: seen.has(a.id),
          };
        }),
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
