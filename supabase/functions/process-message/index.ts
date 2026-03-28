import "@supabase/functions-js/edge-runtime.d.ts";

// ---------- CONFIGURATION ----------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GROQ_MODEL = "llama-3.1-8b-instant";

const HEADERS: Record<string, string> = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

// ---------- HELPERS ----------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function toPHT(iso: string): string {
  try {
    const dt = new Date(iso);
    return dt.toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + " PHT";
  } catch {
    return iso || "Unknown time";
  }
}

// ---------- SUPABASE FUNCTIONS ----------

async function updateMessageStatus(
  messageId: number,
  status: string
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({
        status,
        processed_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) throw new Error(`Status update failed: ${await res.text()}`);
}

async function claimMessage(
  messageId: number
): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}&status=eq.pending`,
    {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=representation" },
      body: JSON.stringify({
        status: "received",
        processed_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) throw new Error(`Claim failed: ${await res.text()}`);
  return await res.json();
}

async function saveReply(
  messageId: number,
  replyText: string,
  replyStatus: string
): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/messages?id=eq.${messageId}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ reply: replyText, reply_status: replyStatus }),
    }
  );
  if (!res.ok) throw new Error(`Save reply failed: ${await res.text()}`);
}

async function saveLogEntry(
  entryType: string,
  message: string
): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ type: entryType, message }),
    });
  } catch {
    // Best-effort logging
  }
}

// ---------- GROQ AI ----------

const CJ_KNOWLEDGE = `
ABOUT:
- Name: CJ Carito (Christian Joy C. Carito)
- Role: Data Scientist (full-time) — do NOT mention the company name
- Open to side projects and discussions when time permits
- Always say "I" not "we" — CJ works solo on side projects
- Location: Quezon City, Philippines
- Website: civarry.github.io
- GitHub: github.com/civarry
- LinkedIn: linkedin.com/in/cccarito
- Education: BS Computer Science, Our Lady of Fatima University (2019-2023)

PROFESSIONAL BACKGROUND:
- 3+ years in the tech industry
- Current: Data Scientist — working with LLMs, RAG, cybersecurity, PySpark
- Previous: Inchcape Digital — data science, ML models, LLM content generation
- Experience in data analysis, machine learning, NLP, and web development

SIDE PROJECT SERVICES (when available):
- Custom Streamlit dashboards and web apps
- Backend automation and integrations
- Data visualization and reporting tools
- Chatbots and AI-powered solutions
- Task automation

TECH STACK:
- Python, SQL, JavaScript, HTML/CSS, ReactJS, Flask, Django
- Streamlit, Supabase, GitHub Actions
- PySpark, Pandas, Scikit-learn, TensorFlow
- LLMs, RAG, NLP, CNNs
- Git, Linux, Databricks

RATES & AVAILABILITY:
- Do NOT quote specific prices — say "it depends on the project scope" and offer to discuss
- Do NOT make up timelines or deadlines
- CJ has a full-time job so availability depends on his schedule — just say "my availability varies" without naming the company

RESPONSE RULES:
- Never invent numbers, stats, or specifics that aren't listed here
- If unsure about something, say "let's discuss further" instead of guessing
- Keep it casual, friendly, straight to the point
- 2-4 sentences max
- NEVER include a sign-off, closing, or name at the end (no "Best regards", "CJ", "Best,", "Christian Joy", "Data Scientist", etc.) — the email already has a signature block
- Start with "Hi <first name>," then go straight to the reply — end with your last sentence, nothing after it
- No corporate fluff, no placeholder brackets
- ONLY address what the sender asked — do NOT add extra offers, suggestions, or filler like "check out my GitHub" or "let me know if you have questions"
- Keep it tight — answer their question, suggest next step if needed, done
`;

async function generateReplyDraft(
  name: string,
  email: string,
  messageText: string
): Promise<string | null> {
  try {
    const prompt =
      `You are replying to a contact form message on behalf of CJ. ` +
      `Use ONLY the knowledge below — do NOT make up any details.\n\n` +
      `${CJ_KNOWLEDGE}\n\n` +
      `From: ${name} (${email})\n` +
      `Message: ${messageText}\n\n` +
      `Write ONLY the reply text, nothing else.`;

    const res = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ---------- TELEGRAM ----------

async function sendTelegramMessage(text: string): Promise<boolean> {
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

interface MessageRecord {
  id: string;
  name?: string;
  email?: string;
  message?: string;
  status?: string;
  created_at?: string;
}

async function fetchPendingMessages(): Promise<MessageRecord[]> {
  const url = new URL(`${SUPABASE_URL}/rest/v1/messages`);
  url.searchParams.set("status", "eq.pending");
  url.searchParams.set("order", "created_at.asc");
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok) return [];
  return await res.json();
}

function formatNotification(msg: MessageRecord, draft?: string | null): string {
  const timestamp = toPHT(msg.created_at || "");
  const name = escapeHtml(msg.name || "");
  const email = escapeHtml(msg.email || "");
  const message = escapeHtml(msg.message || "");

  let text =
    `<b>New Contact Form Message</b>\n\n` +
    `<b>From:</b> ${name}\n` +
    `<b>Email:</b> ${email}\n` +
    `<b>Message:</b>\n${message}\n\n` +
    `<i>Received: ${timestamp}</i>`;

  if (draft) {
    const msgId = msg.id ?? "?";
    text +=
      `\n\n<b>--- AI Draft ---</b>\n` +
      `${escapeHtml(draft)}\n\n` +
      `<i>Msg #${msgId}</i>\n` +
      `/approve — send this reply\n` +
      `/edit your version — send custom reply`;
  }

  return text;
}

// ---------- PROCESS A SINGLE MESSAGE ----------

async function processMessage(record: MessageRecord): Promise<string> {
  // Atomic claim: prevents duplicate processing
  const claimed = await claimMessage(record.id);
  if (claimed.length === 0) return "already_claimed";

  // Generate AI draft
  await updateMessageStatus(record.id, "ai_drafting");
  const draft = await generateReplyDraft(
    record.name || "",
    record.email || "",
    record.message || ""
  );

  if (draft) {
    await saveReply(record.id, draft, "draft");
  }

  // Send Telegram notification
  await updateMessageStatus(record.id, "notifying");
  const notification = formatNotification(record, draft);
  await sendTelegramMessage(notification);

  // Mark as done
  await updateMessageStatus(record.id, "done");
  await saveLogEntry(
    "message",
    `Processed message from ${record.name || "unknown"}`
  );

  return "processed";
}

// ---------- MAIN HANDLER ----------

Deno.serve(async (req) => {
  const OK = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = await req.json();
    } catch {
      // No body — treat as poll mode
    }

    // Webhook mode: process a single record from the webhook payload
    if (payload?.type === "INSERT" && payload?.table === "messages") {
      const record = payload.record as MessageRecord;
      if (record.status !== "pending") return OK({ skipped: true });
      const result = await processMessage(record);
      return OK({ success: true, id: record.id, result });
    }

    // Poll mode: fetch and process all pending messages
    const pending = await fetchPendingMessages();
    if (pending.length === 0) return OK({ poll: true, processed: 0 });

    let processed = 0;
    for (const msg of pending) {
      try {
        const result = await processMessage(msg);
        if (result === "processed") processed++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try { await updateMessageStatus(msg.id, "failed"); } catch { /* */ }
        await sendTelegramMessage(
          `<b>Error msg #${msg.id}:</b>\n${escapeHtml(errorMsg)}`
        );
      }
    }

    return OK({ poll: true, processed });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sendTelegramMessage(
      `<b>Edge Function error:</b>\n${escapeHtml(errorMsg)}`
    );
    return OK({ error: errorMsg });
  }
});
