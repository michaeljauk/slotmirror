-- The repeat lock of alerts reads `alert_sent` rows by time. A plain index on `kind` would add a
-- written row to every audit event. This one holds only the few alert rows.
CREATE INDEX audit_events_alert_sent ON audit_events (org_id, created_at DESC)
  WHERE kind = 'alert_sent';
