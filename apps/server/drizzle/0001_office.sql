CREATE TABLE products (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, name text NOT NULL UNIQUE);
ALTER TABLE repositories ADD COLUMN product_id text REFERENCES products(id);
ALTER TABLE repositories ADD COLUMN connected boolean NOT NULL DEFAULT true;
CREATE TABLE office_desks (employee_id text PRIMARY KEY REFERENCES employees(id), seat serial UNIQUE NOT NULL);
CREATE TABLE github_installations (id bigint PRIMARY KEY, login text NOT NULL, enabled boolean NOT NULL DEFAULT true, synced_at timestamptz);
