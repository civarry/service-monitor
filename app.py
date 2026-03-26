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

# Load from Streamlit secrets (.streamlit/secrets.toml or Streamlit Cloud secrets)
SUPABASE_URL = st.secrets["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = st.secrets["SUPABASE_SERVICE_KEY"]
TELEGRAM_BOT_TOKEN = st.secrets["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = st.secrets["TELEGRAM_CHAT_ID"]

# Polling interval in seconds
POLL_INTERVAL = 10

# Daily heartbeat config (8:00 AM PHT)
PHT = timezone(timedelta(hours=8))
HEARTBEAT_HOUR = 8

# Supabase REST API headers (service role — full access)
HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation"
}


# ---------- SUPABASE FUNCTIONS ----------

def fetch_pending_messages():
    """Fetch all pending messages from Supabase"""
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={
                "status": "eq.pending",
                "order": "created_at.asc"
            },
            timeout=10
        )
        response.raise_for_status()
        return response.json()
    except requests.RequestException:
        return []


def update_message_status(message_id, status):
    """Update a message's status in Supabase"""
    try:
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=HEADERS,
            params={"id": f"eq.{message_id}"},
            json={
                "status": status,
                "processed_at": datetime.now(timezone.utc).isoformat()
            },
            timeout=10
        )
        response.raise_for_status()
        return True
    except requests.RequestException:
        return False


# ---------- TELEGRAM FUNCTIONS ----------

def send_telegram_message(text):
    """Send a message via Telegram Bot API"""
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": TELEGRAM_CHAT_ID,
                "text": text,
                "parse_mode": "HTML"
            },
            timeout=10
        )
        response.raise_for_status()
        return True
    except requests.RequestException:
        return False


def format_notification(msg):
    """Format a message into a Telegram notification"""
    raw_ts = msg.get("created_at", "")
    try:
        utc_dt = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
        timestamp = utc_dt.astimezone(PHT).strftime("%Y-%m-%d %I:%M %p PHT")
    except (ValueError, AttributeError):
        timestamp = raw_ts or "Unknown time"
    # Escape user content to prevent HTML injection in Telegram
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


# ---------- DAILY HEARTBEAT ----------

def get_message_stats():
    """Get message counts from Supabase to include in heartbeat"""
    try:
        # Count total messages
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers={**HEADERS, "Prefer": "count=exact"},
            params={"select": "id", "limit": "0"},
            timeout=10
        )
        response.raise_for_status()
        total = response.headers.get("content-range", "0/0").split("/")[-1]

        # Count pending messages
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
    """Get the last heartbeat date from Supabase app_state"""
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/app_state",
            headers=HEADERS,
            params={"key": "eq.last_heartbeat_date", "select": "value"},
            timeout=10
        )
        response.raise_for_status()
        rows = response.json()
        if rows:
            return rows[0]["value"]
        return None
    except requests.RequestException:
        return None


def set_last_heartbeat_date(date_str):
    """Save the last heartbeat date to Supabase app_state (upsert)"""
    try:
        response = requests.post(
            f"{SUPABASE_URL}/rest/v1/app_state",
            headers={**HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
            json={
                "key": "last_heartbeat_date",
                "value": date_str,
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            timeout=10
        )
        response.raise_for_status()
    except requests.RequestException:
        pass


def send_heartbeat():
    """Send daily status report via Telegram — also keeps Supabase active"""
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
    """Fetch pending messages, send Telegram notifications, update status"""
    messages = fetch_pending_messages()

    for msg in messages:
        # Mark as processing
        update_message_status(msg["id"], "processing")

        # Send Telegram notification
        notification = format_notification(msg)
        success = send_telegram_message(notification)

        # Update final status
        if success:
            update_message_status(msg["id"], "done")
        else:
            update_message_status(msg["id"], "failed")

    return len(messages)


# ---------- HELPER: FETCH LIVE STATS ----------

def get_live_stats():
    """Fetch current stats from Supabase for the dashboard"""
    try:
        stats = get_message_stats()
        total = int(stats["total"]) if stats["total"] != "?" else 0
        pending = int(stats["pending"]) if stats["pending"] != "?" else 0
        done = total - pending
        return {"total": total, "pending": pending, "done": done}
    except (ValueError, TypeError):
        return {"total": 0, "pending": 0, "done": 0}


# ---------- STREAMLIT DASHBOARD ----------

st.set_page_config(
    page_title="Service Monitor",
    page_icon=":material/monitor_heart:",
    layout="wide"
)

# Header
st.markdown("#### :material/monitor_heart: Service Monitor")
st.caption("Real-time service health and message processing dashboard")

st.divider()

# Fetch initial stats
initial_stats = get_live_stats()

# Top metrics row
col1, col2, col3, col4 = st.columns(4)
with col1:
    st.metric(
        label="Service Status",
        value="Operational",
        delta="online",
    )
with col2:
    st.metric(
        label="Total Messages",
        value=initial_stats["total"],
    )
with col3:
    st.metric(
        label="Processed",
        value=initial_stats["done"],
    )
with col4:
    st.metric(
        label="Pending",
        value=initial_stats["pending"],
    )

st.divider()

# Two-column layout: activity log + system info
left_col, right_col = st.columns([3, 2])

with left_col:
    st.markdown("##### :material/history: Activity Log")
    log_container = st.container(border=True, height=300)
    with log_container:
        log_placeholder = st.empty()

with right_col:
    st.markdown("##### :material/info: System Info")
    with st.container(border=True):
        now_pht = datetime.now(PHT)
        st.markdown(f"**Region:** Asia-Pacific")
        st.markdown(f"**Poll Interval:** {POLL_INTERVAL}s")
        st.markdown(f"**Heartbeat:** Daily {HEARTBEAT_HOUR}:00 PHT")
        st.markdown(f"**Local Time:** {now_pht.strftime('%H:%M:%S PHT')}")

    st.markdown("##### :material/link: Connected Services")
    with st.container(border=True):
        st.markdown(":material/database: Supabase — Connected")
        st.markdown(":material/send: Telegram — Connected")
        st.markdown(":material/language: Frontend — civarry.github.io")

# Bottom status bar
st.divider()
status_placeholder = st.empty()

# ---------- THE ACTUAL BACKEND LOOP ----------

log_entries = []
session_processed = 0

while True:
    try:
        # Daily heartbeat — sends once per day at HEARTBEAT_HOUR PHT
        # Uses Supabase to track last send date so it survives session restarts
        now_pht = datetime.now(PHT)
        today_str = now_pht.date().isoformat()
        if now_pht.hour >= HEARTBEAT_HOUR and get_last_heartbeat_date() != today_str:
            send_heartbeat()
            set_last_heartbeat_date(today_str)
            log_entries.append(
                f":material/favorite: `{now_pht.strftime('%H:%M:%S')}` — Daily heartbeat sent"
            )

        count = process_pending_messages()
        session_processed += count

        if count > 0:
            log_entries.append(
                f":material/mail: `{datetime.now(PHT).strftime('%H:%M:%S')}` — Processed **{count}** message(s)"
            )

        # Keep only last 30 entries
        log_entries = log_entries[-30:]

        # Update activity log
        with log_placeholder.container():
            for entry in reversed(log_entries[-15:]):
                st.markdown(entry)

        # Update status bar
        with status_placeholder.container():
            s1, s2 = st.columns(2)
            with s1:
                st.caption(f":material/schedule: Last poll: {datetime.now(PHT).strftime('%Y-%m-%d %H:%M:%S')} PHT")
            with s2:
                st.caption(f":material/mail: Session total: {session_processed} processed")

    except Exception:
        pass

    time.sleep(POLL_INTERVAL)
