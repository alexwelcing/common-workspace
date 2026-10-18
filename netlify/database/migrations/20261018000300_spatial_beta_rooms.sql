-- Keep beta admission metadata separate from browser-owned spatial documents.
ALTER TABLE common_rooms ADD COLUMN experience TEXT
  CONSTRAINT common_rooms_experience_check CHECK (experience IS NULL OR experience = 'spatial-beta');
