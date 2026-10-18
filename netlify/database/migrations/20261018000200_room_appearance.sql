-- Room styling is bounded JSON metadata; older rooms keep the default appearance.
ALTER TABLE common_rooms ADD COLUMN appearance JSONB;
