CREATE TABLE IF NOT EXISTS atlas_views (
  id TEXT PRIMARY KEY,
  write_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS atlas_views_expiry ON atlas_views(expires);
-- Per-client view creation counts by hour; the client key is a SHA-256 of the caller's IP.
CREATE TABLE IF NOT EXISTS atlas_view_quota (
  client TEXT NOT NULL,
  window INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (client, window)
);
