const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * `silent` suppresses the notification sound. The briefing arrives as a stack
 * of cards, and only the first should buzz the phone.
 */
export async function sendTelegram(text: string, silent = false): Promise<boolean> {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: silent,
      }),
      // Unbounded before: a hung Telegram call could burn the whole platform
      // budget and take the briefing with it.
      signal: AbortSignal.timeout(15000),
    }
  );
  return res.ok;
}

/**
 * Caption is HTML, and its 1024-character limit applies *after* entity
 * parsing, so the <a> markup itself costs nothing against the budget — only
 * the visible link labels count.
 */
export async function sendPhoto(
  png: Uint8Array,
  caption: string,
  silent = false
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("disable_notification", String(silent));
    // Copied into a fresh Uint8Array so its buffer is a plain ArrayBuffer:
  // resvg hands back Uint8Array<ArrayBufferLike>, which is not a BlobPart.
  form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "briefing.png");

  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    { method: "POST", body: form, signal: AbortSignal.timeout(30000) }
  );
  return res.ok;
}
