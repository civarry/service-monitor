-- One-time cleanup: clear the fixed-id manual test alert so the next
-- {"test":true} run (verifying the new bilingual translation format)
-- isn't skipped by dedup.
delete from closure_alerts_seen where id = 'test_manual_alert';
