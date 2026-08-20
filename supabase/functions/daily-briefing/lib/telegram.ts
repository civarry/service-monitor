const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface LinkButton {
  text: string;
  url: string;
}

/**
 * `buttons` render as an inline keyboard beneath the message, one per row.
 * Button labels are plain text, NOT HTML — escaping them would surface a
 * literal "&amp;" to the reader.
 *
 * `silent` suppresses the notification sound. The briefing arrives as a stack
 * of cards, and only the first should buzz the phone.
 */
export async function sendTelegram(
  text: string,
  buttons?: LinkButton[],
  silent = false
): Promise<boolean> {
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
        ...(buttons && buttons.length > 0
          ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } }
          : {}),
      }),
      // Unbounded before: a hung Telegram call could burn the whole platform
      // budget and take the briefing with it.
      signal: AbortSignal.timeout(15000),
    }
  );
  return res.ok;
}
