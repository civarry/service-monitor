"""
Sneaky Backend - Streamlit as a Backend Service
Polls Supabase for new messages and sends Telegram notifications.
Nobody needs to know this is Streamlit.
"""

import streamlit as st
import requests
import time
import html
import json
import smtplib
from email.mime.text import MIMEText
from email.utils import formataddr
from datetime import datetime, timezone, timedelta


# ---------- CONFIGURATION ----------

SUPABASE_URL = st.secrets["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = st.secrets["SUPABASE_SERVICE_KEY"]
TELEGRAM_BOT_TOKEN = st.secrets["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = st.secrets["TELEGRAM_CHAT_ID"]
GROQ_API_KEY = st.secrets["GROQ_API_KEY"]
GROQ_MODEL = "llama-3.1-8b-instant"
SMTP_EMAIL = st.secrets["SMTP_EMAIL"]
SMTP_APP_PASSWORD = st.secrets["SMTP_APP_PASSWORD"]
SMTP_DISPLAY_NAME = "CJ Carito"

POLL_INTERVAL = 10
PHT = timezone(timedelta(hours=8))
HEARTBEAT_HOUR = 8

HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation"
}


# ---------- CUSTOM STYLES ----------

CUSTOM_CSS = """
<style>
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
@keyframes slideIn {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
}

/* Hide Streamlit defaults */
#MainMenu, footer, header { visibility: hidden; }

/* Animated header */
.monitor-header {
    animation: fadeIn 0.6s ease;
    padding: 0.5rem 0 1rem 0;
}
.monitor-header h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: #e0e0e0;
    margin: 0;
    letter-spacing: -0.5px;
}
.monitor-header p {
    font-size: 0.8rem;
    color: #666;
    margin: 0.25rem 0 0 0;
}

/* Status indicator */
.status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    margin-right: 6px;
    animation: pulse 2s ease-in-out infinite;
}

/* Metric cards */
.metric-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    animation: fadeIn 0.6s ease 0.1s both;
}
.metric-card {
    background: #111;
    border: 1px solid #1e1e1e;
    border-radius: 10px;
    padding: 1.25rem;
    transition: border-color 0.2s;
}
.metric-card:hover {
    border-color: #333;
}
.metric-label {
    font-size: 0.7rem;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 0.4rem;
}
.metric-value {
    font-size: 1.75rem;
    font-weight: 700;
    color: #e0e0e0;
    line-height: 1.2;
}
.metric-value.status {
    font-size: 1.1rem;
    color: #22c55e;
}

/* Info grid */
.info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    animation: fadeIn 0.6s ease 0.2s both;
}
.info-card {
    background: #111;
    border: 1px solid #1e1e1e;
    border-radius: 10px;
    padding: 1.25rem;
}
.info-card h3 {
    font-size: 0.75rem;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 0.75rem 0;
}
.info-row {
    display: flex;
    justify-content: space-between;
    padding: 0.35rem 0;
    border-bottom: 1px solid #1a1a1a;
    font-size: 0.8rem;
}
.info-row:last-child { border-bottom: none; }
.info-key { color: #888; }
.info-val { color: #ccc; font-weight: 500; }

/* Service badges */
.service-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0.35rem 0.7rem;
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid rgba(34, 197, 94, 0.15);
    border-radius: 6px;
    font-size: 0.75rem;
    color: #22c55e;
    margin: 0.2rem 0.3rem 0.2rem 0;
}

/* Log entries */
.log-entry {
    padding: 0.5rem 0.75rem;
    border-left: 2px solid #1e1e1e;
    margin-bottom: 0.4rem;
    font-size: 0.8rem;
    color: #999;
    animation: slideIn 0.3s ease;
}
.log-entry.heartbeat { border-left-color: #f59e0b; }
.log-entry.message { border-left-color: #3b82f6; }
.log-entry.command { border-left-color: #a855f7; }
.log-entry .log-time {
    color: #555;
    font-family: monospace;
    font-size: 0.7rem;
    margin-right: 0.5rem;
}

/* Status bar */
.status-bar {
    display: flex;
    justify-content: space-between;
    padding: 0.75rem 0;
    font-size: 0.75rem;
    color: #555;
    animation: fadeIn 0.6s ease 0.3s both;
}

/* Responsive */
@media (max-width: 768px) {
    .metric-row { grid-template-columns: repeat(2, 1fr); }
    .info-grid { grid-template-columns: 1fr; }
}
</style>
"""


# ---------- SUPABASE FUNCTIONS ----------

def fetch_pending_messages():
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={"status": "eq.pending", "order": "created_at.asc"},
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except requests.RequestException:
        return []


def update_message_status(message_id, status):
    try:
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={"id": f"eq.{message_id}"},
            json={"status": status, "processed_at": datetime.now(timezone.utc).isoformat()},
            timeout=10
        )
        response.raise_for_status()
        return True
    except requests.RequestException:
        return False


# ---------- ACTIVITY LOG FUNCTIONS ----------

def save_log_entry(entry_type, message):
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/activity_log",
            headers=HEADERS,
            json={"type": entry_type, "message": message},
            timeout=10
        )
    except requests.RequestException:
        pass


def fetch_recent_logs(limit=30):
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/activity_log",
            headers=HEADERS,
            params={"select": "type,message,created_at", "order": "created_at.desc", "limit": limit},
            timeout=10
        )
        response.raise_for_status()
        rows = response.json()
        entries = []
        for row in reversed(rows):
            try:
                utc_dt = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
                ts = utc_dt.astimezone(PHT).strftime('%H:%M:%S')
            except (ValueError, AttributeError):
                ts = "??:??:??"
            entries.append((row["type"], ts, row["message"]))
        return entries
    except requests.RequestException:
        return []


# ---------- SITE SETTINGS FUNCTIONS ----------

def update_site_setting(key, value):
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/site_settings",
            headers={**HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
            json={"key": key, "value": value, "updated_at": datetime.now(timezone.utc).isoformat()},
            timeout=10
        )
        return True
    except requests.RequestException:
        return False


def fetch_site_setting(key):
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/site_settings",
            headers=HEADERS,
            params={"key": f"eq.{key}", "select": "value"},
            timeout=10
        )
        response.raise_for_status()
        rows = response.json()
        if not rows:
            return None
        val = rows[0]["value"]
        if isinstance(val, str):
            try:
                return json.loads(val)
            except json.JSONDecodeError:
                return val
        return val
    except requests.RequestException:
        return None


# ---------- GROQ AI FUNCTIONS ----------

CJ_KNOWLEDGE = """
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
"""

def generate_reply_draft(name, email, message_text):
    try:
        prompt = (
            f"You are replying to a contact form message on behalf of CJ. "
            f"Use ONLY the knowledge below — do NOT make up any details.\n\n"
            f"{CJ_KNOWLEDGE}\n\n"
            f"From: {name} ({email})\n"
            f"Message: {message_text}\n\n"
            f"Write ONLY the reply text, nothing else."
        )
        response = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": GROQ_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 200,
                "temperature": 0.7
            },
            timeout=15
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"].strip()
    except (requests.RequestException, KeyError, IndexError):
        return None


# ---------- REPLY MANAGEMENT ----------

def save_reply(message_id, reply_text, reply_status):
    try:
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={"id": f"eq.{message_id}"},
            json={"reply": reply_text, "reply_status": reply_status},
            timeout=10
        )
        response.raise_for_status()
        return True
    except requests.RequestException:
        return False


def fetch_message_by_id(message_id):
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={"id": f"eq.{message_id}", "limit": "1"},
            timeout=10
        )
        response.raise_for_status()
        rows = response.json()
        return rows[0] if rows else None
    except requests.RequestException:
        return None


def fetch_oldest_draft_message():
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={
                "reply_status": "eq.draft",
                "order": "created_at.asc",
                "limit": "1"
            },
            timeout=10
        )
        response.raise_for_status()
        rows = response.json()
        return rows[0] if rows else None
    except requests.RequestException:
        return None


def fetch_all_draft_messages():
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={
                "reply_status": "eq.draft",
                "select": "id,name,email,message,created_at",
                "order": "created_at.asc"
            },
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except requests.RequestException:
        return []


def send_email_reply(to_email, to_name, reply_text, original_message):
    try:
        subject = "Re: Your message on civarry.github.io"
        now_str = datetime.now(PHT).strftime("%B %d, %Y at %I:%M %p PHT")
        reply_paragraphs = "".join(
            f'<p style="margin:0 0 12px 0;line-height:1.6;">{html.escape(p)}</p>'
            for p in reply_text.strip().split("\n") if p.strip()
        )
        body_html = f"""
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#333;">
            <tr><td style="padding:32px 24px 16px 24px;">
                {reply_paragraphs}
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
                    <p style="margin:0 0 8px 0;font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Your message on {now_str}</p>
                    <p style="margin:0;font-size:13px;color:#666;line-height:1.5;font-style:italic;">{html.escape(original_message)}</p>
                </div>
            </td></tr>
        </table>
        """
        msg = MIMEText(body_html, "html")
        msg["Subject"] = subject
        msg["From"] = formataddr((SMTP_DISPLAY_NAME, SMTP_EMAIL))
        msg["To"] = formataddr((to_name, to_email))
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(SMTP_EMAIL, SMTP_APP_PASSWORD)
            server.send_message(msg)
        return True
    except Exception:
        return False


# ---------- TELEGRAM COMMAND HANDLING ----------

def get_telegram_updates(last_id):
    try:
        response = requests.get(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
            params={"offset": last_id + 1, "timeout": 0},
            timeout=10
        )
        response.raise_for_status()
        data = response.json()
        if data.get("ok"):
            return data.get("result", [])
        return []
    except requests.RequestException:
        return []


def clear_old_updates():
    try:
        response = requests.get(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates",
            params={"timeout": 0},
            timeout=10
        )
        response.raise_for_status()
        data = response.json()
        if data.get("ok") and data.get("result"):
            return data["result"][-1]["update_id"]
        return 0
    except requests.RequestException:
        return 0


def handle_command(text):
    text = text.strip()

    if text.startswith("/drafts"):
        drafts = fetch_all_draft_messages()
        if not drafts:
            send_telegram_message("No pending drafts.")
            return None
        lines = []
        for i, d in enumerate(drafts, 1):
            name = html.escape(d.get("name", ""))
            msg_preview = html.escape(d.get("message", "")[:50])
            lines.append(f"{i}. <b>{name}</b> — {msg_preview}...")
        send_telegram_message(
            f"<b>Pending drafts ({len(drafts)}):</b>\n\n" + "\n".join(lines) +
            f"\n\n/approve — reply to #{1} (oldest)\n/approve <id> — reply to specific"
        )
        return None

    if text.startswith("/approve"):
        parts = text.split()
        if len(parts) >= 2 and parts[1].isdigit():
            msg_row = fetch_message_by_id(int(parts[1]))
        else:
            msg_row = fetch_oldest_draft_message()
        if not msg_row:
            send_telegram_message("No draft reply found to approve.")
            return None
        if msg_row.get("reply_status") != "draft":
            send_telegram_message("This message has already been replied to.")
            return None
        save_reply(msg_row["id"], msg_row["reply"], "approved")
        email_sent = send_email_reply(
            msg_row.get("email", ""),
            msg_row.get("name", ""),
            msg_row["reply"],
            msg_row.get("message", "")
        )
        status = "sent" if email_sent else "saved (email failed)"
        send_telegram_message(
            f"<b>Reply approved for msg #{msg_row['id']}</b>\n\n"
            f"<b>To:</b> {html.escape(msg_row.get('name', ''))} ({html.escape(msg_row.get('email', ''))})\n"
            f"<b>Reply:</b> {html.escape(msg_row.get('reply', ''))}\n"
            f"<b>Email:</b> {status}"
        )
        return f"Approved reply for msg #{msg_row['id']}"

    if text.startswith("/edit "):
        rest = text[len("/edit "):].strip()
        parts = rest.split(maxsplit=1)
        msg_row = None
        custom_reply = rest
        if parts and parts[0].isdigit():
            msg_row = fetch_message_by_id(int(parts[0]))
            custom_reply = parts[1] if len(parts) > 1 else ""
        else:
            msg_row = fetch_oldest_draft_message()
        if not msg_row:
            send_telegram_message("No draft reply found to edit.")
            return None
        if not custom_reply:
            send_telegram_message("Usage: /edit <your reply> or /edit <id> <your reply>")
            return None
        save_reply(msg_row["id"], custom_reply, "edited")
        email_sent = send_email_reply(
            msg_row.get("email", ""),
            msg_row.get("name", ""),
            custom_reply,
            msg_row.get("message", "")
        )
        status = "sent" if email_sent else "saved (email failed)"
        send_telegram_message(
            f"<b>Reply updated for msg #{msg_row['id']}</b>\n\n"
            f"<b>To:</b> {html.escape(msg_row.get('name', ''))} ({html.escape(msg_row.get('email', ''))})\n"
            f"<b>Reply:</b> {html.escape(custom_reply)}\n"
            f"<b>Email:</b> {status}"
        )
        return f"Edited reply for msg #{msg_row['id']}"

    if text.startswith("/update"):
        rest = text[len("/update"):].strip()
        parts = rest.split(maxsplit=1)
        if not parts:
            send_telegram_message(
                "<b>Usage:</b>\n"
                "/update bio <text>\n"
                "/update social <platform> <url>\n"
                "/update status <emoji> <text>\n"
                "/update status off"
            )
            return None
        subcommand = parts[0].lower()
        value = parts[1] if len(parts) > 1 else ""

        if subcommand == "bio":
            if not value:
                send_telegram_message("Usage: /update bio <your bio text>")
                return None
            update_site_setting("bio", {"text": value})
            send_telegram_message(f"<b>Bio updated.</b>\n\n{html.escape(value)}")
            return "Bio updated"

        if subcommand == "social":
            social_parts = value.split(maxsplit=1)
            if len(social_parts) < 2:
                send_telegram_message("Usage: /update social <platform> <url>")
                return None
            platform, url = social_parts
            current = fetch_site_setting("social") or {}
            current[platform.lower()] = url
            update_site_setting("social", current)
            send_telegram_message(f"<b>Social updated:</b> {html.escape(platform)} = {html.escape(url)}")
            return f"Social updated: {platform}"

        if subcommand == "status":
            if not value or value.lower() == "off":
                update_site_setting("status", {"active": False, "emoji": "", "text": ""})
                send_telegram_message("<b>Status cleared.</b>")
                return "Status cleared"
            status_parts = value.split(maxsplit=1)
            if len(status_parts) < 2:
                send_telegram_message("Usage: /update status <emoji> <text> or /update status off")
                return None
            emoji, status_text = status_parts
            update_site_setting("status", {"active": True, "emoji": emoji, "text": status_text})
            send_telegram_message(f"<b>Status set:</b> {emoji} {html.escape(status_text)}")
            return "Status updated"

        send_telegram_message(f"Unknown: /update {html.escape(subcommand)}")
        return None

    if text.startswith("/add"):
        rest = text[len("/add"):].strip()
        parts = rest.split(maxsplit=1)
        if not parts:
            send_telegram_message(
                "<b>Usage:</b>\n"
                "/add project <title> | <description> | <url>\n"
                "/add skill <skill name>"
            )
            return None
        subcommand = parts[0].lower()
        value = parts[1] if len(parts) > 1 else ""

        if subcommand == "project":
            segments = [s.strip() for s in value.split("|")]
            if len(segments) < 2:
                send_telegram_message("Usage: /add project <title> | <description> | <url>")
                return None
            title = segments[0]
            description = segments[1]
            url = segments[2] if len(segments) > 2 else ""
            projects = fetch_site_setting("projects") or []
            if not isinstance(projects, list):
                projects = []
            projects.append({"title": title, "description": description, "url": url})
            update_site_setting("projects", projects)
            send_telegram_message(
                f"<b>Project added:</b> {html.escape(title)}\n"
                f"<b>Description:</b> {html.escape(description)}\n"
                f"<b>Total projects:</b> {len(projects)}"
            )
            return f"Project added: {title}"

        if subcommand == "skill":
            if not value:
                send_telegram_message("Usage: /add skill <skill name>")
                return None
            skills = fetch_site_setting("skills") or []
            if not isinstance(skills, list):
                skills = []
            skills.append(value)
            update_site_setting("skills", skills)
            send_telegram_message(f"<b>Skill added:</b> {html.escape(value)} (total: {len(skills)})")
            return f"Skill added: {value}"

        send_telegram_message(f"Unknown: /add {html.escape(subcommand)}")
        return None

    if text.startswith("/remove"):
        rest = text[len("/remove"):].strip()
        parts = rest.split(maxsplit=1)
        if not parts:
            send_telegram_message(
                "<b>Usage:</b>\n"
                "/remove project <title>\n"
                "/remove skill <skill name>"
            )
            return None
        subcommand = parts[0].lower()
        value = parts[1] if len(parts) > 1 else ""

        if subcommand == "project":
            projects = fetch_site_setting("projects") or []
            if not isinstance(projects, list):
                projects = []
            original_count = len(projects)
            projects = [p for p in projects if p.get("title", "").lower() != value.lower()]
            if len(projects) == original_count:
                send_telegram_message(f"No project found: {html.escape(value)}")
                return None
            update_site_setting("projects", projects)
            send_telegram_message(f"<b>Project removed:</b> {html.escape(value)} ({len(projects)} remaining)")
            return f"Project removed: {value}"

        if subcommand == "skill":
            skills = fetch_site_setting("skills") or []
            if not isinstance(skills, list):
                skills = []
            if value in skills:
                skills.remove(value)
                update_site_setting("skills", skills)
                send_telegram_message(f"<b>Skill removed:</b> {html.escape(value)} ({len(skills)} remaining)")
                return f"Skill removed: {value}"
            send_telegram_message(f"Skill not found: {html.escape(value)}")
            return None

        send_telegram_message(f"Unknown: /remove {html.escape(subcommand)}")
        return None

    if text.startswith("/list"):
        rest = text[len("/list"):].strip().lower()
        if rest == "projects":
            projects = fetch_site_setting("projects") or []
            if not isinstance(projects, list):
                projects = []
            if not projects:
                send_telegram_message("No projects found.")
                return None
            lines = []
            for i, p in enumerate(projects, 1):
                lines.append(f"{i}. <b>{html.escape(p.get('title', ''))}</b> - {html.escape(p.get('description', ''))}")
            send_telegram_message("<b>Projects:</b>\n\n" + "\n".join(lines))
            return None
        if rest == "skills":
            skills = fetch_site_setting("skills") or []
            if not isinstance(skills, list):
                skills = []
            if not skills:
                send_telegram_message("No skills found.")
                return None
            send_telegram_message("<b>Skills:</b>\n\n" + ", ".join(html.escape(s) for s in skills))
            return None
        send_telegram_message("Usage: /list projects | /list skills")
        return None

    if text.startswith("/darkmode"):
        parts = text.split()
        if len(parts) >= 2 and parts[1].lower() in ("on", "off"):
            mode = parts[1].lower()
            if mode == "on":
                update_site_setting("theme", "dark")
                send_telegram_message("<b>Dark mode enabled.</b>")
                save_log_entry("command", "Dark mode enabled")
                return "Dark mode enabled"
            else:
                update_site_setting("theme", "light")
                send_telegram_message("<b>Light mode enabled.</b>")
                save_log_entry("command", "Light mode enabled")
                return "Light mode enabled"
        else:
            send_telegram_message("Usage: /darkmode on|off")
        return None

    if text.startswith("/announce"):
        rest = text[len("/announce"):].strip()

        if not rest or rest.lower() == "off":
            update_site_setting("announce", {"active": False, "message": "", "type": "flash", "duration": 0})
            send_telegram_message("<b>Announcement cleared.</b>")
            return None

        # Parse: /announce <message> --flash 20s | --persist
        atype = "flash"
        duration = 20
        message = rest

        if "--persist" in rest:
            idx = rest.rfind("--persist")
            message = rest[:idx].strip()
            atype = "persistent"
            duration = 0
        elif "--flash" in rest:
            idx = rest.rfind("--flash")
            message = rest[:idx].strip()
            duration_str = rest[idx + 7:].strip()
            duration = int("".join(c for c in duration_str if c.isdigit()) or "20")

        if not message:
            send_telegram_message("Usage:\n/announce Hello world\n/announce Hello --flash 20s\n/announce Hello --persist\n/announce off")
            return

        update_site_setting("announce", {
            "active": True,
            "message": message,
            "type": atype,
            "duration": duration
        })
        duration_label = f"{duration}s" if atype == "flash" else "until cleared"
        send_telegram_message(
            f"<b>Announcement set</b>\n\n"
            f"<b>Message:</b> {html.escape(message)}\n"
            f"<b>Type:</b> {atype}\n"
            f"<b>Duration:</b> {duration_label}"
        )
        return None


# ---------- TELEGRAM FUNCTIONS ----------

def send_telegram_message(text):
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10
        )
        response.raise_for_status()
        return True
    except requests.RequestException:
        return False


def format_notification(msg, draft=None):
    raw_ts = msg.get("created_at", "")
    try:
        utc_dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
        timestamp = utc_dt.astimezone(PHT).strftime("%Y-%m-%d %I:%M %p PHT")
    except (ValueError, AttributeError):
        timestamp = raw_ts or "Unknown time"
    name = html.escape(msg.get("name", ""))
    email = html.escape(msg.get("email", ""))
    message = html.escape(msg.get("message", ""))
    text = (
        f"<b>New Contact Form Message</b>\n\n"
        f"<b>From:</b> {name}\n"
        f"<b>Email:</b> {email}\n"
        f"<b>Message:</b>\n{message}\n\n"
        f"<i>Received: {timestamp}</i>"
    )
    if draft:
        msg_id = msg.get("id", "?")
        text += (
            f"\n\n<b>--- Auto-Replied ---</b>\n"
            f"{html.escape(draft)}\n\n"
            f"<i>Msg #{msg_id}</i>\n"
            f"/edit your correction - send follow-up email"
        )
    return text


# ---------- HEARTBEAT ----------

def get_message_stats():
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers={**HEADERS, "Prefer": "count=exact"},
            params={"select": "id", "limit": "0"},
            timeout=10
        )
        response.raise_for_status()
        total = response.headers.get("content-range", "0/0").split("/")[-1]

        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers={**HEADERS, "Prefer": "count=exact"},
            params={"select": "id", "status": "eq.pending", "limit": "0"},
            timeout=10
        )
        response.raise_for_status()
        pending = response.headers.get("content-range", "0/0").split("/")[-1]

        return {"total": total, "pending": pending}
    except requests.RequestException:
        return {"total": "?", "pending": "?"}


def get_last_heartbeat_date():
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/app_state",
            headers=HEADERS,
            params={"key": "eq.last_heartbeat_date", "select": "value"},
            timeout=10
        )
        response.raise_for_status()
        rows = response.json()
        return rows[0]["value"] if rows else None
    except requests.RequestException:
        return None


def set_last_heartbeat_date(date_str):
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/app_state",
            headers={**HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
            json={"key": "last_heartbeat_date", "value": date_str, "updated_at": datetime.now(timezone.utc).isoformat()},
            timeout=10
        )
    except requests.RequestException:
        pass


def send_heartbeat():
    stats = get_message_stats()
    now = datetime.now(PHT).strftime("%Y-%m-%d %H:%M:%S PHT")
    send_telegram_message(
        f"<b>Daily Status Report</b>\n\n"
        f"<b>Status:</b> Online\n"
        f"<b>Time:</b> {now}\n"
        f"<b>Total messages:</b> {stats['total']}\n"
        f"<b>Pending:</b> {stats['pending']}\n\n"
        f"<i>civarry.github.io is running.</i>"
    )


# ---------- PROCESS MESSAGES ----------

def claim_pending_messages():
    try:
        # Claim pending messages
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers={**HEADERS, "Prefer": "return=representation"},
            params={"status": "eq.pending"},
            json={"status": "received", "processed_at": datetime.now(timezone.utc).isoformat()},
            timeout=10
        )
        response.raise_for_status()
        claimed = response.json()

        # Also recover messages stuck at received/ai_drafting (app crashed mid-processing)
        response2 = requests.patch(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers={**HEADERS, "Prefer": "return=representation"},
            params={"status": "in.(received,ai_drafting)", "processed_at": f"lt.{(datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat()}"},
            json={"status": "received"},
            timeout=10
        )
        response2.raise_for_status()
        recovered = response2.json()

        return claimed + recovered
    except requests.RequestException:
        return []


def process_pending_messages():
    messages = claim_pending_messages()
    for msg in messages:
        update_message_status(msg["id"], "ai_drafting")
        draft = generate_reply_draft(
            msg.get("name", ""),
            msg.get("email", ""),
            msg.get("message", "")
        )
        if draft:
            save_reply(msg["id"], draft, "approved")

        update_message_status(msg["id"], "notifying")
        notification = format_notification(msg, draft=draft)
        send_telegram_message(notification)

        if draft and msg.get("email"):
            update_message_status(msg["id"], "sending_reply")
            email_sent = send_email_reply(
                msg.get("email", ""),
                msg.get("name", ""),
                draft,
                msg.get("message", "")
            )
            update_message_status(msg["id"], "replied" if email_sent else "done")
        else:
            update_message_status(msg["id"], "done")
    return len(messages)


def get_live_stats():
    try:
        stats = get_message_stats()
        total = int(stats["total"]) if stats["total"] != "?" else 0
        pending = int(stats["pending"]) if stats["pending"] != "?" else 0
        return {"total": total, "pending": pending, "done": total - pending}
    except (ValueError, TypeError):
        return {"total": 0, "pending": 0, "done": 0}


# ---------- STREAMLIT DASHBOARD ----------

st.set_page_config(page_title="Service Monitor", page_icon=":material/monitor_heart:", layout="wide")

# Inject custom CSS
st.markdown(CUSTOM_CSS, unsafe_allow_html=True)

# Fetch stats
stats = get_live_stats()
now_pht = datetime.now(PHT)

# Header
st.markdown("""
<div class="monitor-header">
    <h1><span class="status-dot"></span> Service Monitor</h1>
    <p>Real-time message processing and service health</p>
</div>
""", unsafe_allow_html=True)

# Metric cards
st.markdown(f"""
<div class="metric-row">
    <div class="metric-card">
        <div class="metric-label">Status</div>
        <div class="metric-value status"><span class="status-dot"></span> Operational</div>
    </div>
    <div class="metric-card">
        <div class="metric-label">Total Messages</div>
        <div class="metric-value">{stats['total']}</div>
    </div>
    <div class="metric-card">
        <div class="metric-label">Processed</div>
        <div class="metric-value">{stats['done']}</div>
    </div>
    <div class="metric-card">
        <div class="metric-label">Pending</div>
        <div class="metric-value">{stats['pending']}</div>
    </div>
</div>
""", unsafe_allow_html=True)

st.markdown("<br>", unsafe_allow_html=True)

# Info grid + Activity log
st.markdown(f"""
<div class="info-grid">
    <div class="info-card">
        <h3>System Info</h3>
        <div class="info-row"><span class="info-key">Region</span><span class="info-val">Asia-Pacific</span></div>
        <div class="info-row"><span class="info-key">Poll Interval</span><span class="info-val">{POLL_INTERVAL}s</span></div>
        <div class="info-row"><span class="info-key">Heartbeat</span><span class="info-val">Daily {HEARTBEAT_HOUR}:00 PHT</span></div>
        <div class="info-row"><span class="info-key">Local Time</span><span class="info-val">{now_pht.strftime('%H:%M:%S PHT')}</span></div>
    </div>
    <div class="info-card">
        <h3>Connected Services</h3>
        <div style="padding: 0.25rem 0;">
            <span class="service-badge">Supabase</span>
            <span class="service-badge">Telegram</span>
            <span class="service-badge">GitHub Pages</span>
            <span class="service-badge">Groq AI</span>
        </div>
    </div>
</div>
""", unsafe_allow_html=True)

st.markdown("<br>", unsafe_allow_html=True)

# Activity log (Streamlit-managed for live updates)
st.markdown('<div style="animation: fadeIn 0.6s ease 0.3s both;">', unsafe_allow_html=True)
st.markdown("##### Activity Log")
log_container = st.container(border=True, height=250)
with log_container:
    log_placeholder = st.empty()
st.markdown('</div>', unsafe_allow_html=True)

# Status bar placeholder
status_placeholder = st.empty()

# ---------- THE ACTUAL BACKEND LOOP ----------

# Ensure no webhook conflicts with getUpdates polling
try:
    requests.post(f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/deleteWebhook", timeout=10)
except requests.RequestException:
    pass

# Register Telegram bot command menu
try:
    requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/setMyCommands",
        json={"commands": [
            {"command": "drafts", "description": "List all pending draft replies"},
            {"command": "approve", "description": "Approve oldest draft reply"},
            {"command": "edit", "description": "Replace draft — /edit [id] <text>"},
            {"command": "update", "description": "Update content — /update bio|social|status"},
            {"command": "add", "description": "Add content — /add project|skill"},
            {"command": "remove", "description": "Remove content — /remove project|skill"},
            {"command": "list", "description": "View content — /list projects|skills"},
            {"command": "darkmode", "description": "Toggle theme — /darkmode on|off"},
            {"command": "announce", "description": "Site banner — /announce <msg> --flash 20s"},
        ]},
        timeout=10
    )
except requests.RequestException:
    pass

log_entries = fetch_recent_logs()
session_processed = 0
last_update_id = clear_old_updates()

while True:
    try:
        # Process Telegram commands
        updates = get_telegram_updates(last_update_id)
        for update in updates:
            last_update_id = update["update_id"]
            msg = update.get("message", {})
            chat_id = str(msg.get("chat", {}).get("id", ""))
            text = msg.get("text", "")
            if chat_id == TELEGRAM_CHAT_ID and text.startswith("/"):
                log_msg = handle_command(text)
                if log_msg:
                    log_entries.append(("command", datetime.now(PHT).strftime('%H:%M:%S'), log_msg))

        now_pht = datetime.now(PHT)
        today_str = now_pht.date().isoformat()
        if now_pht.hour >= HEARTBEAT_HOUR and get_last_heartbeat_date() != today_str:
            send_heartbeat()
            set_last_heartbeat_date(today_str)
            log_entries.append(("heartbeat", now_pht.strftime('%H:%M:%S'), "Daily heartbeat sent"))
            save_log_entry("heartbeat", "Daily heartbeat sent")

        count = process_pending_messages()
        session_processed += count

        if count > 0:
            log_msg = f"Processed {count} message(s)"
            log_entries.append(("message", datetime.now(PHT).strftime('%H:%M:%S'), log_msg))
            save_log_entry("message", log_msg)

        log_entries = log_entries[-30:]

        # Render activity log with styled HTML
        with log_placeholder.container():
            if log_entries:
                log_html = ""
                for entry_type, ts, text in reversed(log_entries[-15:]):
                    log_html += f'<div class="log-entry {entry_type}"><span class="log-time">{ts}</span>{text}</div>'
                st.markdown(log_html, unsafe_allow_html=True)
            else:
                st.markdown('<div style="color:#444; font-size:0.8rem; padding:1rem;">Waiting for activity...</div>', unsafe_allow_html=True)

        # Status bar
        with status_placeholder.container():
            st.markdown(f"""
            <div class="status-bar">
                <span>Last poll: {datetime.now(PHT).strftime('%Y-%m-%d %H:%M:%S')} PHT</span>
                <span>Session: {session_processed} processed</span>
            </div>
            """, unsafe_allow_html=True)

    except Exception:
        pass

    time.sleep(POLL_INTERVAL)
