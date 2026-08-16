-- Dedup table for the closure-alerts edge function: tracks which NCDR CAP
-- alert IDs have already been sent to Telegram so the /15-min poller never
-- re-notifies on an alert it's already delivered.
create table if not exists closure_alerts_seen (
  id text primary key,
  locality text not null,
  notified_at timestamptz not null default now()
);

alter table closure_alerts_seen enable row level security;
-- No policies: only the service role (used by the edge function) touches
-- this table, and the service role bypasses RLS by default.
