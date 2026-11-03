ALTER TABLE repositories ADD COLUMN poll_cursor timestamptz;
ALTER TABLE repositories ADD COLUMN poll_error text;
