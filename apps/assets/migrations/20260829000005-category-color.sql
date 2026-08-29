-- Category presentation color (user-manageable). Values are PixelAccent
-- names validated by the API allowlist; NULL means the default look.
ALTER TABLE categories ADD COLUMN color text;
