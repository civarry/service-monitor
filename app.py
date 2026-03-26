"""
Sneaky Backend - Streamlit as a Backend Service
Polls Supabase for new messages and sends Telegram notifications.
Nobody needs to know this is Streamlit.
"""

import streamlit as st
import requests
import time
from datetime import datetime


# ---------- CONFIGURATION ----------

# Load from Streamlit secrets (.streamlit/secrets.toml or Streamlit Cloud secrets)
SUPABASE_URL = st.secrets["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = st.secrets["SUPABASE_SERVICE_KEY"]
TELEGRAM_BOT_TOKEN = st.secrets["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = st.secrets["TELEGRAM_CHAT_ID"]

# Polling interval in seconds
POLL_INTERVAL = 10

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

while True:
    try:
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
