-- Additive delivery metadata; old clients continue receiving complete rosters.
ALTER TABLE common_rooms ADD COLUMN roster_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE common_rooms ADD COLUMN roster_check_at TIMESTAMPTZ;

-- Targeted reads never fetch another recipient's signaling payload.
CREATE INDEX common_events_recipient_idx ON common_events (room_id, target_id, seq);
ALTER TABLE common_events ADD COLUMN sender_id TEXT;
ALTER TABLE common_events ADD COLUMN connection_id TEXT;
ALTER TABLE common_events ADD COLUMN request_id TEXT;
ALTER TABLE common_events ADD COLUMN request_hash TEXT;
CREATE UNIQUE INDEX common_events_request_idx
  ON common_events (room_id, sender_id, connection_id, request_id)
  WHERE request_id IS NOT NULL;
