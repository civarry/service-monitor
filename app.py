"""
Sneaky Backend - Streamlit as a Backend Service
Polls Supabase for new messages and sends Telegram notifications.
Nobody needs to know this is Streamlit.
"""

import streamlit as st
import requests
import time
import html
from datetime import datetime, timezone, timedelta


# ---------- CONFIGURATION ----------

SUPABASE_URL = st.secrets["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = st.secrets["SUPABASE_SERVICE_KEY"]
TELEGRAM_BOT_TOKEN = st.secrets["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = st.secrets["TELEGRAM_CHAT_ID"]

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


def format_notification(msg):
    raw_ts = msg.get("created_at", "")
    try:
        utc_dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
        timestamp = utc_dt.astimezone(PHT).strftime("%Y-%m-%d %I:%M %p PHT")
    except (ValueError, AttributeError):
        timestamp = raw_ts or "Unknown time"
    name = html.escape(msg.get("name", ""))
    email = html.escape(msg.get("email", ""))
    message = html.escape(msg.get("message", ""))
    return (
        f"<b>New Contact Form Message</b>\n\n"
        f"<b>From:</b> {name}\n"
        f"<b>Email:</b> {email}\n"
        f"<b>Message:</b>\n{message}\n\n"
        f"<i>Received: {timestamp}</i>"
    )


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

def process_pending_messages():
    messages = fetch_pending_messages()
    for msg in messages:
        update_message_status(msg["id"], "processing")
        notification = format_notification(msg)
        success = send_telegram_message(notification)
        update_message_status(msg["id"], "done" if success else "failed")
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

log_entries = fetch_recent_logs()
session_processed = 0

while True:
    try:
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
