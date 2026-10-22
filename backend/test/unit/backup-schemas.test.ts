import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRestoreSchemas } from "../../../scripts/backup-schemas.js";

test("restore scopes include only top-level canonical schema declarations", () => {
  assert.deepEqual(extractRestoreSchemas(`
    \\restrict backup_key
    -- CREATE SCHEMA comment_decoy;
    CREATE SCHEMA core;
    CREATE SCHEMA "Assets";
    CREATE SCHEMA IF NOT EXISTS core;
    /* CREATE SCHEMA block_decoy; /* nested */ */
    INSERT INTO core.example VALUES ('CREATE SCHEMA string_decoy; it''s data');
    CREATE FUNCTION core.example() RETURNS void AS $body$
      BEGIN
        CREATE SCHEMA function_decoy;
      END;
    $body$ LANGUAGE plpgsql;
    CREATE SCHEMA tasks;
    \\unrestrict backup_key
  `), ["core", "Assets", "tasks"]);
});

test("COPY data and escaped strings cannot add DROP targets", () => {
  assert.deepEqual(extractRestoreSchemas(`CREATE SCHEMA notes;
COPY notes.example (body) FROM stdin;
CREATE SCHEMA unrelated_live_data;
-- fake comment in data
$not_a_sql_quote$
\\.
INSERT INTO notes.example VALUES (E'backslash \\' CREATE SCHEMA decoy;');
CREATE SCHEMA assets;
`), ["notes", "assets"]);
});

test("system schemas are excluded and noncanonical declarations fail before mutation", () => {
  assert.deepEqual(extractRestoreSchemas("CREATE SCHEMA pg_catalog; CREATE SCHEMA information_schema; CREATE SCHEMA public;"), ["public"]);
  assert.throws(() => extractRestoreSchemas('CREATE SCHEMA "not-canonical";'), /unsupported schema/);
  assert.throws(() => extractRestoreSchemas('CREATE SCHEMA "quoted""name";'), /unsupported schema/);
});

test("ordinary strings preserve trailing backslashes with standard conforming strings", () => {
  const slash = String.fromCharCode(92);
  assert.deepEqual(extractRestoreSchemas(`SET standard_conforming_strings = on;
    CREATE SCHEMA core;
    COMMENT ON SCHEMA core IS 'Windows path C:${slash}';
    CREATE SCHEMA notes;
  `), ["core", "notes"]);
});

test("incomplete SQL containers fail closed", () => {
  for (const sql of ["/* unclosed", "SELECT 'unclosed", "DO $$unclosed", "COPY notes.example FROM stdin;\nmissing terminator"]) {
    assert.throws(() => extractRestoreSchemas(sql), /unterminated/);
  }
});
