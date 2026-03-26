"""
Sneaky Backend - Streamlit as a Backend Service
Polls Supabase for new messages and sends Telegram notifications.
Nobody needs to know this is Streamlit.
"""

import streamlit as st
import requests
import time
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
    except requests.RequestException as e:
        st.error(f"Supabase fetch error: {e}")
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
                "processed_at": datetime.utcnow().isoformat()
            },
            timeout=10
        )
        response.raise_for_status()
        return True
    except requests.RequestException as e:
        st.error(f"Supabase update error: {e}")
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
    except requests.RequestException as e:
        st.error(f"Telegram error: {e}")
        return False


def format_notification(msg):
    """Format a message into a Telegram notification"""
    timestamp = msg.get("created_at", "Unknown time")
    return (
        f"<b>New Contact Form Message</b>\n\n"
        f"<b>From:</b> {msg['name']}\n"
        f"<b>Email:</b> {msg['email']}\n"
        f"<b>Message:</b>\n{msg['message']}\n\n"
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


# ---------- STREAMLIT "UI" (the decoy) ----------

st.set_page_config(page_title="System Monitor", page_icon="📊")

st.title("System Monitor")
st.caption("Internal monitoring dashboard.")

# Show some basic stats so it looks like a legit Streamlit app
col1, col2, col3 = st.columns(3)
with col1:
    st.metric("Status", "Online")
with col2:
    st.metric("Uptime", "Active")
with col3:
    st.metric("Last Check", datetime.now().strftime("%H:%M:%S"))

st.divider()
st.caption("Monitoring in progress...")

# ---------- THE ACTUAL BACKEND LOOP ----------

status_placeholder = st.empty()
log_placeholder = st.empty()
log_entries = []
last_heartbeat_date = None

while True:
    try:
        # Daily heartbeat — sends once per day at HEARTBEAT_HOUR PHT
        now_pht = datetime.now(PHT)
        today = now_pht.date()
        if now_pht.hour >= HEARTBEAT_HOUR and last_heartbeat_date != today:
            send_heartbeat()
            last_heartbeat_date = today
            log_entries.append(f"[{now_pht.strftime('%H:%M:%S')}] Daily heartbeat sent")

        count = process_pending_messages()

        if count > 0:
            log_entry = f"[{datetime.now().strftime('%H:%M:%S')}] Processed {count} message(s)"
            log_entries.append(log_entry)
            # Keep only last 20 log entries
            log_entries = log_entries[-20:]

        # Update the UI
        with status_placeholder.container():
            st.success(f"Last poll: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Messages processed this session: {len(log_entries)}")

        if log_entries:
            with log_placeholder.container():
                st.text("\n".join(reversed(log_entries)))

    except Exception as e:
        with status_placeholder.container():
            st.warning(f"Error during poll: {e}")

    time.sleep(POLL_INTERVAL)
