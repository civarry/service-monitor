import "@supabase/functions-js/edge-runtime.d.ts";

// ---------- CONFIGURATION ----------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SMTP_EMAIL = Deno.env.get("SMTP_EMAIL")!;
const SMTP_APP_PASSWORD = Deno.env.get("SMTP_APP_PASSWORD")!;

const HEADERS: Record<string, string> = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

const OK = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// ---------- HELPERS ----------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function toPHTString(iso: string): string {
  try {
    const dt = new Date(iso);
    return dt.toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "long",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + " PHT";
  } catch {
    return iso || "Unknown time";
  }
}

// ---------- TELEGRAM ----------

async function sendTelegram(text: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- SUPABASE HELPERS ----------

async function supabaseGet(
  table: string,
  params: Record<string, string>
): Promise<unknown[]> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok) return [];
  return await res.json();
}

async function supabasePatch(
  table: string,
  params: Record<string, string>,
  body: Record<string, unknown>
): Promise<unknown[]> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${table} failed: ${await res.text()}`);
  return await res.json();
}

async function supabasePost(
  table: string,
  body: Record<string, unknown>,
  extraPrefer?: string
): Promise<void> {
  const headers = { ...HEADERS };
  if (extraPrefer) headers["Prefer"] = extraPrefer;
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function saveLogEntry(
  entryType: string,
  message: string
): Promise<void> {
  try {
    await supabasePost("activity_log", { type: entryType, message });
  } catch {
    // Best-effort
  }
}

// ---------- MESSAGE HELPERS ----------

interface MessageRow {
  id: number;
  name?: string;
  email?: string;
  message?: string;
  reply?: string;
  reply_status?: string;
  created_at?: string;
}

async function fetchMessageById(id: number): Promise<MessageRow | null> {
  const rows = (await supabaseGet("messages", {
    id: `eq.${id}`,
    limit: "1",
  })) as MessageRow[];
  return rows[0] || null;
}

async function fetchOldestDraft(): Promise<MessageRow | null> {
  const rows = (await supabaseGet("messages", {
    reply_status: "eq.draft",
    order: "created_at.asc",
    limit: "1",
  })) as MessageRow[];
  return rows[0] || null;
}

async function fetchAllDrafts(): Promise<MessageRow[]> {
  return (await supabaseGet("messages", {
    reply_status: "eq.draft",
    select: "id,name,email,message,created_at",
    order: "created_at.asc",
  })) as MessageRow[];
}

async function saveReply(
  id: number,
  replyText: string,
  replyStatus: string
): Promise<void> {
  await supabasePatch(
    "messages",
    { id: `eq.${id}` },
    { reply: replyText, reply_status: replyStatus }
  );
}

// ---------- SITE SETTINGS ----------

async function fetchSiteSetting(key: string): Promise<unknown> {
  const rows = (await supabaseGet("site_settings", {
    key: `eq.${key}`,
    select: "value",
  })) as { value: unknown }[];
  if (!rows[0]) return null;
  const val = rows[0].value;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

async function updateSiteSetting(
  key: string,
  value: unknown
): Promise<void> {
  await supabasePost(
    "site_settings",
    { key, value, updated_at: new Date().toISOString() },
    "resolution=merge-duplicates,return=representation"
  );
}

// ---------- EMAIL ----------

async function sendEmailReply(
  toEmail: string,
  toName: string,
  replyText: string,
  originalMessage: string
): Promise<boolean> {
  try {
    const nowStr = toPHTString(new Date().toISOString());
    const replyParagraphs = replyText
      .trim()
      .split("\n")
      .filter((p) => p.trim())
      .map(
        (p) =>
          `<p style="margin:0 0 12px 0;line-height:1.6;">${escapeHtml(p)}</p>`
      )
      .join("");

    const bodyHtml = `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <tr><td style="padding:32px 24px 16px 24px;">
            ${replyParagraphs}
        </td></tr>
        <tr><td style="padding:8px 24px 0 24px;">
            <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="padding-right:16px;vertical-align:top;">
                        <div style="width:48px;height:48px;background:#111;border-radius:10px;text-align:center;">
                            <span style="color:#fff;font-weight:700;font-size:18px;line-height:48px;">CJ</span>
                        </div>
                    </td>
                    <td style="vertical-align:top;">
                        <p style="margin:0;font-weight:600;font-size:14px;color:#111;">CJ Carito</p>
                        <p style="margin:2px 0 0 0;font-size:13px;color:#666;">Data Scientist &amp; Developer</p>
                        <p style="margin:8px 0 0 0;font-size:12px;">
                            <a href="https://civarry.github.io" style="color:#2563eb;text-decoration:none;">civarry.github.io</a>
                            <span style="color:#ccc;margin:0 6px;">|</span>
                            <a href="https://github.com/civarry" style="color:#2563eb;text-decoration:none;">GitHub</a>
                            <span style="color:#ccc;margin:0 6px;">|</span>
                            <a href="https://linkedin.com/in/cccarito" style="color:#2563eb;text-decoration:none;">LinkedIn</a>
                        </p>
                    </td>
                </tr>
            </table>
        </td></tr>
        <tr><td style="padding:16px 24px 24px 24px;">
            <div style="background:#f9fafb;padding:20px 24px;border-radius:8px;">
                <p style="margin:0 0 8px 0;font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Your message on ${nowStr}</p>
                <p style="margin:0;font-size:13px;color:#666;line-height:1.5;font-style:italic;">${escapeHtml(originalMessage)}</p>
            </div>
        </td></tr>
    </table>
    `;

    // Use Gmail SMTP via a simple HTTPS relay approach
    // Deno doesn't have native SMTP, so we use the Resend-style approach
    // or fall back to a raw SMTP connection via Deno's TCP
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const conn = await Deno.connectTls({
      hostname: "smtp.gmail.com",
      port: 465,
    });

    async function readLine(): Promise<string> {
      const buf = new Uint8Array(1024);
      const n = await conn.read(buf);
      return n ? decoder.decode(buf.subarray(0, n)) : "";
    }

    async function writeLine(line: string): Promise<void> {
      await conn.write(encoder.encode(line + "\r\n"));
    }

    // SMTP conversation
    await readLine(); // greeting

    await writeLine(`EHLO localhost`);
    await readLine();

    await writeLine(`AUTH LOGIN`);
    await readLine();

    await writeLine(btoa(SMTP_EMAIL));
    await readLine();

    await writeLine(btoa(SMTP_APP_PASSWORD));
    await readLine();

    await writeLine(`MAIL FROM:<${SMTP_EMAIL}>`);
    await readLine();

    await writeLine(`RCPT TO:<${toEmail}>`);
    await readLine();

    await writeLine(`DATA`);
    await readLine();

    const boundary = `boundary${Date.now()}`;
    const emailData = [
      `From: CJ Carito <${SMTP_EMAIL}>`,
      `To: ${toName} <${toEmail}>`,
      `Subject: Re: Your message on civarry.github.io`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      bodyHtml,
      `.`,
    ].join("\r\n");

    await writeLine(emailData);
    await readLine();

    await writeLine(`QUIT`);
    conn.close();

    return true;
  } catch (e) {
    console.error("Email error:", e);
    return false;
  }
}

// ---------- COMMAND HANDLERS ----------

async function handleDrafts(): Promise<void> {
  const drafts = await fetchAllDrafts();
  if (!drafts.length) {
    await sendTelegram("No pending drafts.");
    return;
  }
  const lines = drafts.map((d, i) => {
    const name = escapeHtml(d.name || "");
    const preview = escapeHtml((d.message || "").slice(0, 50));
    return `${i + 1}. <b>${name}</b> — ${preview}...`;
  });
  await sendTelegram(
    `<b>Pending drafts (${drafts.length}):</b>\n\n` +
      lines.join("\n") +
      `\n\n/approve — reply to #1 (oldest)\n/approve <id> — reply to specific`
  );
}

async function handleApprove(args: string): Promise<string | null> {
  const parts = args.trim().split(/\s+/);
  let msgRow: MessageRow | null;
  if (parts[0] && /^\d+$/.test(parts[0])) {
    msgRow = await fetchMessageById(parseInt(parts[0]));
  } else {
    msgRow = await fetchOldestDraft();
  }
  if (!msgRow) {
    await sendTelegram("No draft reply found to approve.");
    return null;
  }
  if (msgRow.reply_status !== "draft") {
    await sendTelegram("This message has already been replied to.");
    return null;
  }
  await saveReply(msgRow.id, msgRow.reply || "", "approved");
  const emailSent = await sendEmailReply(
    msgRow.email || "",
    msgRow.name || "",
    msgRow.reply || "",
    msgRow.message || ""
  );
  const status = emailSent ? "sent" : "saved (email failed)";
  await sendTelegram(
    `<b>Reply approved for msg #${msgRow.id}</b>\n\n` +
      `<b>To:</b> ${escapeHtml(msgRow.name || "")} (${escapeHtml(msgRow.email || "")})\n` +
      `<b>Reply:</b> ${escapeHtml(msgRow.reply || "")}\n` +
      `<b>Email:</b> ${status}`
  );
  return `Approved reply for msg #${msgRow.id}`;
}

async function handleEdit(args: string): Promise<string | null> {
  const rest = args.trim();
  const parts = rest.split(/\s+/);
  let msgRow: MessageRow | null;
  let customReply = rest;

  if (parts[0] && /^\d+$/.test(parts[0])) {
    msgRow = await fetchMessageById(parseInt(parts[0]));
    customReply = parts.slice(1).join(" ");
  } else {
    msgRow = await fetchOldestDraft();
  }
  if (!msgRow) {
    await sendTelegram("No draft reply found to edit.");
    return null;
  }
  if (!customReply) {
    await sendTelegram("Usage: /edit <your reply> or /edit <id> <your reply>");
    return null;
  }
  await saveReply(msgRow.id, customReply, "edited");
  const emailSent = await sendEmailReply(
    msgRow.email || "",
    msgRow.name || "",
    customReply,
    msgRow.message || ""
  );
  const status = emailSent ? "sent" : "saved (email failed)";
  await sendTelegram(
    `<b>Reply updated for msg #${msgRow.id}</b>\n\n` +
      `<b>To:</b> ${escapeHtml(msgRow.name || "")} (${escapeHtml(msgRow.email || "")})\n` +
      `<b>Reply:</b> ${escapeHtml(customReply)}\n` +
      `<b>Email:</b> ${status}`
  );
  return `Edited reply for msg #${msgRow.id}`;
}

async function handleUpdate(args: string): Promise<string | null> {
  const parts = args.trim().split(/\s+/);
  if (!parts[0]) {
    await sendTelegram(
      "<b>Usage:</b>\n/update bio <text>\n/update social <platform> <url>\n/update status <emoji> <text>\n/update status off"
    );
    return null;
  }
  const sub = parts[0].toLowerCase();
  const value = parts.slice(1).join(" ");

  if (sub === "bio") {
    if (!value) {
      await sendTelegram("Usage: /update bio <your bio text>");
      return null;
    }
    await updateSiteSetting("bio", { text: value });
    await sendTelegram(`<b>Bio updated.</b>\n\n${escapeHtml(value)}`);
    return "Bio updated";
  }

  if (sub === "social") {
    const socialParts = value.split(/\s+/);
    if (socialParts.length < 2) {
      await sendTelegram("Usage: /update social <platform> <url>");
      return null;
    }
    const platform = socialParts[0];
    const url = socialParts[1];
    const current = ((await fetchSiteSetting("social")) || {}) as Record<
      string,
      string
    >;
    current[platform.toLowerCase()] = url;
    await updateSiteSetting("social", current);
    await sendTelegram(
      `<b>Social updated:</b> ${escapeHtml(platform)} = ${escapeHtml(url)}`
    );
    return `Social updated: ${platform}`;
  }

  if (sub === "status") {
    if (!value || value.toLowerCase() === "off") {
      await updateSiteSetting("status", {
        active: false,
        emoji: "",
        text: "",
      });
      await sendTelegram("<b>Status cleared.</b>");
      return "Status cleared";
    }
    const statusParts = value.split(/\s+/);
    if (statusParts.length < 2) {
      await sendTelegram(
        "Usage: /update status <emoji> <text> or /update status off"
      );
      return null;
    }
    const emoji = statusParts[0];
    const statusText = statusParts.slice(1).join(" ");
    await updateSiteSetting("status", {
      active: true,
      emoji,
      text: statusText,
    });
    await sendTelegram(
      `<b>Status set:</b> ${emoji} ${escapeHtml(statusText)}`
    );
    return "Status updated";
  }

  await sendTelegram(`Unknown: /update ${escapeHtml(sub)}`);
  return null;
}

async function handleAdd(args: string): Promise<string | null> {
  const parts = args.trim().split(/\s+/);
  if (!parts[0]) {
    await sendTelegram(
      "<b>Usage:</b>\n/add project <title> | <description> | <url>\n/add skill <skill name>"
    );
    return null;
  }
  const sub = parts[0].toLowerCase();
  const value = parts.slice(1).join(" ");

  if (sub === "project") {
    const segments = value.split("|").map((s) => s.trim());
    if (segments.length < 2) {
      await sendTelegram(
        "Usage: /add project <title> | <description> | <url>"
      );
      return null;
    }
    const title = segments[0];
    const description = segments[1];
    const url = segments[2] || "";
    let projects = ((await fetchSiteSetting("projects")) || []) as Record<
      string,
      string
    >[];
    if (!Array.isArray(projects)) projects = [];
    projects.push({ title, description, url });
    await updateSiteSetting("projects", projects);
    await sendTelegram(
      `<b>Project added:</b> ${escapeHtml(title)}\n<b>Description:</b> ${escapeHtml(description)}\n<b>Total projects:</b> ${projects.length}`
    );
    return `Project added: ${title}`;
  }

  if (sub === "skill") {
    if (!value) {
      await sendTelegram("Usage: /add skill <skill name>");
      return null;
    }
    let skills = ((await fetchSiteSetting("skills")) || []) as string[];
    if (!Array.isArray(skills)) skills = [];
    skills.push(value);
    await updateSiteSetting("skills", skills);
    await sendTelegram(
      `<b>Skill added:</b> ${escapeHtml(value)} (total: ${skills.length})`
    );
    return `Skill added: ${value}`;
  }

  await sendTelegram(`Unknown: /add ${escapeHtml(sub)}`);
  return null;
}

async function handleRemove(args: string): Promise<string | null> {
  const parts = args.trim().split(/\s+/);
  if (!parts[0]) {
    await sendTelegram(
      "<b>Usage:</b>\n/remove project <title>\n/remove skill <skill name>"
    );
    return null;
  }
  const sub = parts[0].toLowerCase();
  const value = parts.slice(1).join(" ");

  if (sub === "project") {
    let projects = ((await fetchSiteSetting("projects")) || []) as Record<
      string,
      string
    >[];
    if (!Array.isArray(projects)) projects = [];
    const originalCount = projects.length;
    projects = projects.filter(
      (p) => (p.title || "").toLowerCase() !== value.toLowerCase()
    );
    if (projects.length === originalCount) {
      await sendTelegram(`No project found: ${escapeHtml(value)}`);
      return null;
    }
    await updateSiteSetting("projects", projects);
    await sendTelegram(
      `<b>Project removed:</b> ${escapeHtml(value)} (${projects.length} remaining)`
    );
    return `Project removed: ${value}`;
  }

  if (sub === "skill") {
    let skills = ((await fetchSiteSetting("skills")) || []) as string[];
    if (!Array.isArray(skills)) skills = [];
    const idx = skills.indexOf(value);
    if (idx === -1) {
      await sendTelegram(`Skill not found: ${escapeHtml(value)}`);
      return null;
    }
    skills.splice(idx, 1);
    await updateSiteSetting("skills", skills);
    await sendTelegram(
      `<b>Skill removed:</b> ${escapeHtml(value)} (${skills.length} remaining)`
    );
    return `Skill removed: ${value}`;
  }

  await sendTelegram(`Unknown: /remove ${escapeHtml(sub)}`);
  return null;
}

async function handleList(args: string): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "projects") {
    let projects = ((await fetchSiteSetting("projects")) || []) as Record<
      string,
      string
    >[];
    if (!Array.isArray(projects)) projects = [];
    if (!projects.length) {
      await sendTelegram("No projects found.");
      return;
    }
    const lines = projects.map(
      (p, i) =>
        `${i + 1}. <b>${escapeHtml(p.title || "")}</b> - ${escapeHtml(p.description || "")}`
    );
    await sendTelegram("<b>Projects:</b>\n\n" + lines.join("\n"));
    return;
  }

  if (sub === "skills") {
    let skills = ((await fetchSiteSetting("skills")) || []) as string[];
    if (!Array.isArray(skills)) skills = [];
    if (!skills.length) {
      await sendTelegram("No skills found.");
      return;
    }
    await sendTelegram(
      "<b>Skills:</b>\n\n" + skills.map((s) => escapeHtml(s)).join(", ")
    );
    return;
  }

  await sendTelegram("Usage: /list projects | /list skills");
}

async function handleDarkmode(args: string): Promise<string | null> {
  const mode = args.trim().toLowerCase();
  if (mode === "on") {
    await updateSiteSetting("theme", "dark");
    await sendTelegram("<b>Dark mode enabled.</b>");
    await saveLogEntry("command", "Dark mode enabled");
    return "Dark mode enabled";
  }
  if (mode === "off") {
    await updateSiteSetting("theme", "light");
    await sendTelegram("<b>Light mode enabled.</b>");
    await saveLogEntry("command", "Light mode enabled");
    return "Light mode enabled";
  }
  await sendTelegram("Usage: /darkmode on|off");
  return null;
}

async function handleAnnounce(args: string): Promise<void> {
  const rest = args.trim();

  if (!rest || rest.toLowerCase() === "off") {
    await updateSiteSetting("announce", {
      active: false,
      message: "",
      type: "flash",
      duration: 0,
    });
    await sendTelegram("<b>Announcement cleared.</b>");
    return;
  }

  let atype = "flash";
  let duration = 20;
  let message = rest;

  if (rest.includes("--persist")) {
    const idx = rest.lastIndexOf("--persist");
    message = rest.slice(0, idx).trim();
    atype = "persistent";
    duration = 0;
  } else if (rest.includes("--flash")) {
    const idx = rest.lastIndexOf("--flash");
    message = rest.slice(0, idx).trim();
    const durationStr = rest.slice(idx + 7).trim();
    duration = parseInt(durationStr.replace(/\D/g, "") || "20");
  }

  if (!message) {
    await sendTelegram(
      "Usage:\n/announce Hello world\n/announce Hello --flash 20s\n/announce Hello --persist\n/announce off"
    );
    return;
  }

  await updateSiteSetting("announce", {
    active: true,
    message,
    type: atype,
    duration,
  });
  const durationLabel = atype === "flash" ? `${duration}s` : "until cleared";
  await sendTelegram(
    `<b>Announcement set</b>\n\n<b>Message:</b> ${escapeHtml(message)}\n<b>Type:</b> ${atype}\n<b>Duration:</b> ${durationLabel}`
  );
}

// ---------- MAIN HANDLER ----------

Deno.serve(async (req) => {
  try {
    const update = await req.json();

    // Extract message from Telegram update
    const msg = update.message;
    if (!msg) return OK();

    const chatId = String(msg.chat?.id || "");
    const text: string = msg.text || "";

    // Only respond to commands from CJ's chat
    if (chatId !== TELEGRAM_CHAT_ID || !text.startsWith("/")) return OK();

    // Strip @botname suffix if present (e.g. /drafts@MyBot)
    const spaceIdx = text.indexOf(" ");
    const rawCmd = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const command = rawCmd.split("@")[0].toLowerCase();
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);

    let logMsg: string | null = null;

    switch (command) {
      case "/drafts":
        await handleDrafts();
        break;
      case "/approve":
        logMsg = await handleApprove(args);
        break;
      case "/edit":
        logMsg = await handleEdit(args);
        break;
      case "/update":
        logMsg = await handleUpdate(args);
        break;
      case "/add":
        logMsg = await handleAdd(args);
        break;
      case "/remove":
        logMsg = await handleRemove(args);
        break;
      case "/list":
        await handleList(args);
        break;
      case "/darkmode":
        logMsg = await handleDarkmode(args);
        break;
      case "/announce":
        await handleAnnounce(args);
        break;
      default:
        await sendTelegram(`Unknown command: ${escapeHtml(command)}`);
    }

    if (logMsg) {
      await saveLogEntry("command", logMsg);
    }

    return OK();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("Webhook error:", errorMsg);
    await sendTelegram(
      `<b>Webhook error:</b>\n${escapeHtml(errorMsg)}`
    );
    // Always return 200 to prevent Telegram retries
    return OK();
  }
});
