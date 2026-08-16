# service-monitor

Backend for [civarry.github.io](https://civarry.github.io) — a Streamlit app that looks like a system status dashboard but is really a free, always-on Python process handling the portfolio's contact form, plus a set of Supabase Edge Functions and a Telegram bot for remote-controlling the site.

## What it does

- **Contact form pipeline**: the portfolio site writes new messages straight to Supabase. This app polls every 10 seconds, sends a Telegram notification for each new message, drafts an AI reply with Groq, and lets me approve/edit/send it from Telegram.
- **Daily briefing**: a Supabase Edge Function (`daily-briefing`) pulls Taipei weather and Taiwan/Philippines news from RSS feeds, clusters same-story coverage across outlets, summarizes each category with Groq, and posts a formatted digest to Telegram every morning.
- **Article embeddings**: a companion function (`embed-articles`) embeds fresh articles with Voyage AI so the briefing can cluster same-event coverage by semantic similarity instead of just keyword overlap.
- **Telegram bot commands**: `/list`, `/approve`, `/edit`, `/drafts` for managing contact-form replies; `/add`, `/remove`, `/update` for live-editing site content; `/audit` for a repo-documentation health check across my GitHub account; `/news`, `/brief` for on-demand digests; `/nextproject`, `/announce`, `/darkmode`, `/synccommands` for other portfolio remote-control bits.
- **Keep-alive**: a GitHub Actions cron pings the Streamlit app and writes an AI-generated one-line status back into `status.json`, which keeps both Streamlit Cloud's free tier and the Supabase project from going idle.

## Stack

Streamlit (backend runtime, not UI), Supabase (Postgres + Edge Functions in Deno/TypeScript), Telegram Bot API, Groq (LLM summaries and reply drafts), Voyage AI (embeddings), Open-Meteo (weather), GitHub Actions (cron scheduling). All free-tier.

## Why Streamlit

GitHub Pages can't run server-side code. Streamlit Community Cloud gives a free always-on Python process that stays alive via scheduled GitHub Actions commits — so this app runs as a hidden backend, not for its UI.
