-- Guided metadata contains planned names/checklists only; media remains peer-to-peer.
-- NULL workshop preserves the original blank canvas protocol and response shapes.
ALTER TABLE common_rooms ADD COLUMN workshop JSONB;
ALTER TABLE common_members ADD COLUMN checklist JSONB;
