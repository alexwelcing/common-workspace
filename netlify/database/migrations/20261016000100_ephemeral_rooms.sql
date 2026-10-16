-- Only rendezvous data lives here. Canvas documents and media stay in browsers.
CREATE TABLE common_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  event_seq BIGINT NOT NULL DEFAULT 0,
  event_floor BIGINT NOT NULL DEFAULT 0,
  chat JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX common_rooms_expiry_idx ON common_rooms (expires_at);

CREATE TABLE common_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES common_rooms(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  connection_id TEXT,
  joined_at TIMESTAMPTZ NOT NULL,
  rate_start TIMESTAMPTZ NOT NULL,
  rate_count INTEGER NOT NULL DEFAULT 0,
  rate_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX common_members_room_idx ON common_members (room_id, lease_until);

CREATE TABLE common_events (
  room_id TEXT NOT NULL REFERENCES common_rooms(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  target_id TEXT,
  except_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE INDEX common_events_expiry_idx ON common_events (room_id, created_at);

CREATE TABLE common_auth_limits (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX common_auth_limits_expiry_idx ON common_auth_limits (expires_at);
