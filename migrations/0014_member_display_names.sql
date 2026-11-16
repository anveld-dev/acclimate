-- Display only. Membership and operator rights still use the issuer/subject pair.
ALTER TABLE users ADD COLUMN display_name text;
ALTER TABLE users ADD CONSTRAINT users_display_name_length
  CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200);
