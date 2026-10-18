// Builds migrations/combined/upgrade_0014_to_0031.sql and check_schema_state.sql
// from the numbered migrations, using a PGlite run of 0000 + 0015..0031 to learn
// which objects each migration introduces.
//
// usage: npm run migrations:combined   (or: node scripts/migrations/build-combined.mjs [backend dir])
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, readSql, run, snapshot } from "./pglite.mjs";

const repo = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migDir = path.join(repo, "migrations");
const outDir = path.join(migDir, "combined");
const VERSIONS = Array.from({ length: 17 }, (_, i) => String(15 + i).padStart(4, "0"));
const fileFor = (v) => fs.readdirSync(migDir).find((f) => f.startsWith(`${v}_`) && f.endsWith(".sql"));

const PRE_LEDGER = {
  "0015": "Session sharing",
  "0016": "Trial email log",
  "0017": "Founder profiles",
};

// ── 1. Learn the schema: 0000 baseline, then what each migration adds ───────
const db = await freshDb();
await run(db, "0000", readSql(path.join(migDir, "0000_complete_fresh_setup.sql")));

const q = async (sql) => (await db.query(sql)).rows;
async function objects() {
  const out = new Set();
  for (const r of await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)) out.add(`table|${r.table_name}`);
  for (const r of await q(`SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`)) out.add(`column|${r.table_name}.${r.column_name}`);
  for (const r of await q(`SELECT DISTINCT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind IN ('f','p')`)) out.add(`function|${r.proname}`);
  for (const r of await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)) out.add(`index|${r.indexname}`);
  for (const r of await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'storage.%'`)) out.add(`trigger|${r.tgname}`);
  for (const r of await q(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`)) out.add(`policy|${r.tablename}.${r.policyname}`);
  for (const r of await q(`SELECT conrelid::regclass::text AS t, conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('c','f','u','x')`)) out.add(`constraint|${String(r.t).replace(/"/g, "")}.${r.conname}`);
  for (const r of await q(`SELECT id FROM storage.buckets`)) out.add(`bucket|${r.id}`);
  return out;
}

const baseline = await objects();
const added = {};
let before = baseline;
for (const v of VERSIONS) {
  await run(db, v, readSql(path.join(migDir, fileFor(v))));
  const after = await objects();
  added[v] = [...after].filter((o) => !before.has(o)).sort();
  before = after;
}

// ── 2. Upgrade script ──────────────────────────────────────────────────────
const prereqTables = [...baseline].filter((o) => o.startsWith("table|")).map((o) => o.slice(6)).sort();
const prereqColumns = [...baseline].filter((o) => o.startsWith("column|")).map((o) => o.slice(7)).sort();
const prereqBuckets = [...baseline].filter((o) => o.startsWith("bucket|")).map((o) => o.slice(7)).sort();

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;
const valuesList = (rows, indent = "    ") => rows.map((r) => `${indent}(${r.map(sqlString).join(", ")})`).join(",\n");

/** Drop a migration's own top-level BEGIN;/COMMIT; so the whole upgrade is one transaction. */
function unwrap(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*(--.*)?$/i.test(line))
    .join("\n")
    .trim();
}

const generatedOn = new Date().toISOString().slice(0, 10);
const parts = [];
parts.push(`-- PitchNest database upgrade: schema 0014 -> 0031
--
-- GENERATED FILE (${generatedOn}). Do not edit by hand: change the numbered
-- migrations in this folder's parent, then run npm run migrations:combined
-- and npm run test:migrations in the backend.
--
-- What it does
--   Applies migrations 0015 through 0031, in order, as ONE transaction. Either
--   every change is applied or none is. Each migration is written to be
--   re-runnable, so running this again on an upgraded database changes nothing.
--   A pre-flight check stops before any change if the database is missing part
--   of the 0014 schema these migrations build on, and lists what is missing.
--   Migrations already applied (by ledger row, or for 0015-0017 by their
--   objects) are skipped, so a partly upgraded database is completed safely.
--
--   SCHEMA ALIGNMENT: before 0015, the parts of a dashboard-built database that
--   differ from 0000 in ways the backend depends on are brought in line
--   (Organizations key and password column, users.password and "orgCode",
--   sessions.org_id and visibility, user links on sessions/decks/profiles, and
--   open-access policies on session_pdfs and waitlist). See "Align" below.
--
--   DATA CHANGE: organization passwords that are not bcrypt hashes are cleared
--   (set to NULL). They cannot sign in under the current backend and would
--   stop migration 0030. Affected organizations need a new password afterwards.
--   check_schema_state.sql reports how many there are before you run this.
--
-- Before running
--   1. Take a backup or restorable snapshot of the database.
--   2. Run check_schema_state.sql (read-only) and confirm that the
--      "prerequisites" row says ok.
--   3. Run on the DEV project first, then PROD.
--
-- How to run (Supabase dashboard)
--   SQL Editor -> New query -> paste this whole file -> Run.
--   Success ends with "Success. No rows returned". Any error rolls everything
--   back; read the message, fix the cause, and run the whole file again.
--
-- After running
--   * Run check_schema_state.sql again: every migration row should say applied.
--   * Feature flags stay off until set on the backend (see ../README.md):
--     FEATURE_DISCOVER_ENGAGEMENT, FEATURE_COMMUNITY, FEATURE_PITCH_ARENA.
--   * Organization logins need bcrypt password hashes (see 0018 in ../README.md).

BEGIN;

-- Fail fast instead of queueing behind a long-running lock on a live table.
SET LOCAL lock_timeout = '15s';

-- ── Pre-flight: the 0014 schema these migrations build on ───────────────────
DO $preflight$
DECLARE
  missing TEXT[] := ARRAY[]::TEXT[];
  item RECORD;
  foreign_versions TEXT;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
${valuesList(prereqTables.map((t) => ["table", t]))}
    ) AS expected(kind, name)
  LOOP
    IF to_regclass(format('public.%I', item.name)) IS NULL THEN
      missing := missing || format('table %s', item.name);
    END IF;
  END LOOP;

  FOR item IN
    SELECT * FROM (VALUES
${valuesList(prereqColumns.map((c) => c.split(".")))}
    ) AS expected(table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = item.table_name
        AND c.column_name = item.column_name
    ) THEN
      missing := missing || format('column %s.%s', item.table_name, item.column_name);
    END IF;
  END LOOP;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. The database is missing % item(s) of the 0014 schema: %',
      cardinality(missing), array_to_string(missing, ', ')
      USING HINT = 'Run check_schema_state.sql for the full list, bring those items in line with 0000_complete_fresh_setup.sql, then run this file again.';
  END IF;

  -- Data that 0030 re-validates. Neither should exist; stop rather than guess.
  IF EXISTS (SELECT 1 FROM users WHERE auth_provider IS NOT NULL AND auth_provider NOT IN ('form', 'google')) THEN
    RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. % user(s) have an auth_provider other than form or google, which migration 0030 does not allow.',
      (SELECT count(*) FROM users WHERE auth_provider IS NOT NULL AND auth_provider NOT IN ('form', 'google'))
      USING HINT = 'Inspect them with: SELECT id, email, auth_provider FROM users WHERE auth_provider NOT IN (''form'', ''google''); set each to form (password sign-in) or google, then run this file again.';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE failed_login_attempts < 0) THEN
    RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. % user(s) have a negative failed_login_attempts, which migration 0030 does not allow.',
      (SELECT count(*) FROM users WHERE failed_login_attempts < 0)
      USING HINT = 'Reset them with: UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts < 0; then run this file again.';
  END IF;

  -- A schema_migrations table without a description column was not created by
  -- migration 0018. Its rows decide which migrations this upgrade skips, so any
  -- it holds from 0015 on must be looked at before going further.
  IF to_regclass('public.schema_migrations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'description') THEN
    EXECUTE 'SELECT string_agg(version::text, '', '' ORDER BY version::text) FROM public.schema_migrations WHERE version::text >= ''0015'''
      INTO foreign_versions;
    IF foreign_versions IS NOT NULL THEN
      RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. An existing schema_migrations table (not created by migration 0018) already records version(s) %, which this upgrade would skip as applied.', foreign_versions
        USING HINT = 'Check what those rows record. If those migrations were never applied, delete the rows, then run this file again.';
    END IF;
  END IF;
END
$preflight$;

-- ── Align the 0014 schema with 0000 where the backend depends on it ─────────
-- Databases built through the dashboard differ from 0000_complete_fresh_setup
-- in ways the backend cannot work around. Each step is skipped when the
-- database already matches 0000.
DO $align$
DECLARE
  pk_name TEXT;
  pk_cols TEXT[];
  org_id_type TEXT;
  child RECORD;
  fk RECORD;
  orphans BIGINT;
BEGIN
  -- Organizations is keyed on id alone. A key over several columns (some
  -- databases include password in it) would stop the password being cleared.
  SELECT k.conname, array_agg(a.attname::TEXT ORDER BY a.attnum)
    INTO pk_name, pk_cols
    FROM pg_constraint k
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
   WHERE k.conrelid = '"Organizations"'::regclass AND k.contype = 'p'
   GROUP BY k.conname;
  IF pk_cols IS DISTINCT FROM ARRAY['id'] THEN
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE "Organizations" DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE "Organizations" ADD CONSTRAINT "Organizations_pkey" PRIMARY KEY (id);
    RAISE NOTICE 'PitchNest upgrade: Organizations is now keyed on id.';
  END IF;

  -- Organization login and enrolment look a row up by email and by org_code.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = '"Organizations"'::regclass AND i.indisunique AND i.indnatts = 1 AND a.attname = 'email') THEN
    ALTER TABLE "Organizations" ADD CONSTRAINT "Organizations_email_key" UNIQUE (email);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = '"Organizations"'::regclass AND i.indisunique AND i.indnatts = 1 AND a.attname = 'org_code') THEN
    ALTER TABLE "Organizations" ADD CONSTRAINT "Organizations_org_code_key" UNIQUE (org_code);
  END IF;

  -- NULL is how the backend represents "no password set", for organizations
  -- (the step below clears unusable ones) and for users.
  ALTER TABLE "Organizations" ALTER COLUMN password DROP NOT NULL;
  ALTER TABLE "Organizations" ALTER COLUMN password DROP DEFAULT;
  ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

  -- NULL "orgCode" means "not in an organization"; 0030's enrolment treats
  -- any other value, including '', as already enrolled.
  ALTER TABLE users ALTER COLUMN "orgCode" DROP DEFAULT;
  UPDATE users SET "orgCode" = NULL WHERE "orgCode" = '';

  -- sessions.org_id carries an organization code and visibility may be
  -- 'organization', which is what the backend writes for an organization
  -- member's session. A uuid column tied to another table, or a check that
  -- predates 'organization', would refuse those rows.
  SELECT data_type INTO org_id_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'org_id';
  IF org_id_type IS DISTINCT FROM 'text' THEN
    FOR fk IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'sessions'::regclass AND contype = 'f'
         AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'sessions'::regclass AND attname = 'org_id')]::int2[]
    LOOP
      EXECUTE format('ALTER TABLE sessions DROP CONSTRAINT %I', fk.conname);
    END LOOP;
    ALTER TABLE sessions ALTER COLUMN org_id TYPE TEXT USING org_id::TEXT;
    RAISE NOTICE 'PitchNest upgrade: sessions.org_id is now text.';
  END IF;
  ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_visibility_check;
  ALTER TABLE sessions ALTER COLUMN visibility DROP NOT NULL;

  -- Deleting an account deletes the user row and relies on these cascading.
  -- Rows already pointing at a missing user would fail a checked constraint,
  -- so then it is added NOT VALID: still enforced for every later change.
  FOR child IN SELECT * FROM (VALUES ('sessions'), ('decks'), ('profiles')) AS t(name) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass(child.name) AND contype = 'f'
         AND confrelid = 'users'::regclass
         AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass(child.name) AND attname = 'user_id')]::int2[]) THEN
      EXECUTE format(
        'SELECT count(*) FROM %I c WHERE c.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id)',
        child.name) INTO orphans;
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE%s',
        child.name, child.name || '_user_id_fkey', CASE WHEN orphans > 0 THEN ' NOT VALID' ELSE '' END);
      IF orphans > 0 THEN
        RAISE NOTICE 'PitchNest upgrade: % has % row(s) for users that no longer exist; % now cascades, unvalidated for those rows.', child.name, orphans, child.name || '_user_id_fkey';
      END IF;
    END IF;
  END LOOP;

  -- Pitch-report PDFs and the waitlist are read and written by the backend's
  -- service role only. These policies opened them to anyone holding the
  -- public anon key.
  DROP POLICY IF EXISTS "Allow all access for authenticated users" ON session_pdfs;
  DROP POLICY IF EXISTS "Allow anon waitlist select" ON waitlist;
  DROP POLICY IF EXISTS "Allow anon waitlist updates" ON waitlist;
  DROP POLICY IF EXISTS "Allow anon waitlist inserts" ON waitlist;
END
$align$;

-- ── Organization credentials ────────────────────────────────────────────────
-- 0018 only accepts bcrypt hashes for organization passwords (NOT VALID, so it
-- left existing values alone), and 0030 then updates every organization row,
-- which re-checks each one. Any other stored value would stop the upgrade and,
-- afterwards, block users joining or leaving that organization.
--
-- Such values can never sign in: the backend accepts only bcrypt hashes. They
-- are also not converted, because they are plain or unknown secrets that may
-- already have been exposed. They are cleared, and each affected organization
-- needs a new password set (see README.md, "Organization credentials").
DO $org_credentials$
DECLARE
  cleared INTEGER;
BEGIN
  UPDATE "Organizations"
     SET password = NULL
   WHERE password IS NOT NULL
     AND password !~ '^\\$2[aby]\\$[0-9]{2}\\$.{53}$';
  GET DIAGNOSTICS cleared = ROW_COUNT;
  IF cleared > 0 THEN
    RAISE NOTICE 'PitchNest upgrade: cleared % organization password(s) that were not bcrypt hashes; set new ones before those organizations sign in.', cleared;
  END IF;
END
$org_credentials$;

-- ── Migration ledger ────────────────────────────────────────────────────────
-- Some databases already have a schema_migrations table without 0018's
-- description column. Bring it to 0018's shape so the ledger rows written below
-- fit. Rows already there are kept and labelled.
DO $ledger$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'description') THEN
    ALTER TABLE public.schema_migrations ADD COLUMN description TEXT;
    UPDATE public.schema_migrations
       SET description = 'Recorded before the ledger had descriptions'
     WHERE description IS NULL;
    ALTER TABLE public.schema_migrations ALTER COLUMN description SET NOT NULL;
    RAISE NOTICE 'PitchNest upgrade: added the description column to the existing schema_migrations table.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
      AND column_name = 'applied_at' AND column_default IS NULL) THEN
    ALTER TABLE public.schema_migrations ALTER COLUMN applied_at SET DEFAULT NOW();
  END IF;
END
$ledger$;
`);

// Each migration runs once. A migration is only re-runnable from its own
// position (a later one may change a function it creates), so anything already
// applied is skipped: 0018+ by its ledger row, 0015-0017 (which predate the
// ledger) by the ledger or by all of their tables and columns being present.
const presenceCondition = (v) => {
  const items = added[v].filter((o) => o.startsWith("table|") || o.startsWith("column|"));
  if (!items.length) return null;
  return items
    .map((o) => {
      const [kind, name] = o.split("|");
      if (kind === "table") return `to_regclass(${sqlString(`public."${name}"`)}) IS NOT NULL`;
      const [t, c] = name.split(".");
      return `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${sqlString(t)} AND column_name = ${sqlString(c)})`;
    })
    .join("\n      AND ");
};

for (const v of VERSIONS) {
  const file = fileFor(v);
  const body = unwrap(readSql(path.join(migDir, file)));
  const quote = `$body_${v}$`;
  if (body.includes(quote)) throw new Error(`${file} contains ${quote}`);
  const presence = v < "0018" ? presenceCondition(v) : null;
  parts.push(`
-- ════════════════════════════════════════════════════════════════════════════
-- ${file}
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_${v}$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '${v}';
  END IF;${presence ? `
  -- Applied by hand before the ledger existed?
  already_applied := already_applied OR (
      ${presence}
  );` : ""}
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: ${v} already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying ${v}';
  EXECUTE ${quote}
${body}
${quote};
END
$migration_${v}$;
`);
}

parts.push(`
-- ── Ledger rows for the migrations that predate schema_migrations ───────────
INSERT INTO schema_migrations (version, description) VALUES
${valuesList(Object.entries(PRE_LEDGER), "  ")}
ON CONFLICT (version) DO NOTHING;

COMMIT;
`);

fs.mkdirSync(outDir, { recursive: true });
const upgradePath = path.join(outDir, "upgrade_0014_to_0031.sql");
fs.writeFileSync(upgradePath, parts.join("\n"));

// ── 3. Read-only check script ──────────────────────────────────────────────
// Per migration: the named objects it introduces, plus its ledger row (0018+).
const KIND_ORDER = ["table", "column", "function", "index", "trigger", "policy", "constraint", "bucket"];
const expectedRows = [];
for (const t of prereqTables) expectedRows.push(["prerequisites", "table", t]);
for (const c of prereqColumns) expectedRows.push(["prerequisites", "column", c]);
for (const b of prereqBuckets) expectedRows.push(["prerequisites", "bucket", b]);
for (const v of VERSIONS) {
  for (const o of added[v]) {
    const [kind, name] = o.split("|");
    if (KIND_ORDER.includes(kind)) expectedRows.push([v, kind, name]);
  }
}

const check = `-- PitchNest schema check: READ-ONLY.
--
-- GENERATED FILE (${generatedOn}) by npm run migrations:combined. It changes nothing. Run it in the Supabase
-- SQL Editor (New query -> paste -> Run) and copy the result rows.
--
-- One row for the 0014 prerequisites, then one row per migration 0015-0031:
--   ok / applied  everything expected is present
--   partial       some of it is present (an interrupted or hand-applied run)
--   missing       none of it is present (not applied yet)
-- "ledger" shows whether schema_migrations records the version (0018+ only;
-- 0015-0017 are recorded by the combined upgrade). "missing_items" lists up to
-- 25 absent objects so a partial state can be repaired precisely.
--
-- The "alignment" row lists differences from 0000 that the upgrade fixes before
-- 0015. The last rows count data the upgrade acts on: organization passwords it
-- will clear, and any values that would stop it.

WITH expected(section, kind, name) AS (
  VALUES
${valuesList(expectedRows, "    ")}
),
checked AS (
  SELECT e.section, e.kind, e.name,
    CASE e.kind
      WHEN 'table' THEN to_regclass(format('public.%I', e.name)) IS NOT NULL
      WHEN 'column' THEN EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = split_part(e.name, '.', 1)
          AND c.column_name = split_part(e.name, '.', 2))
      WHEN 'function' THEN EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = e.name)
      WHEN 'index' THEN EXISTS (
        SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = e.name)
      WHEN 'trigger' THEN EXISTS (
        SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = e.name)
      WHEN 'policy' THEN EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = split_part(e.name, '.', 1)
          AND p.policyname = split_part(e.name, '.', 2))
      WHEN 'constraint' THEN EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.connamespace = 'public'::regnamespace AND k.conname = split_part(e.name, '.', 2))
      WHEN 'bucket' THEN CASE
        WHEN to_regclass('storage.buckets') IS NULL THEN false
        ELSE xpath_exists(format('//row[id=%L]', e.name),
          query_to_xml('SELECT id FROM storage.buckets', false, false, ''))
      END
    END AS present
  FROM expected e
),
ledger AS (
  SELECT unnest(xpath('//row/version/text()',
    query_to_xml('SELECT version FROM public.schema_migrations', false, false, '')))::text AS version
  WHERE to_regclass('public.schema_migrations') IS NOT NULL
),
sections(section) AS (
  VALUES ('prerequisites'), ${VERSIONS.map((v) => `('${v}')`).join(", ")}
),
summary AS (
  SELECT section,
    count(*) FILTER (WHERE present) AS present_count,
    count(*) AS expected_count,
    (array_agg(kind || ' ' || name ORDER BY kind, name) FILTER (WHERE NOT present))[1:25] AS missing_items
  FROM checked
  GROUP BY section
),
-- Data the upgrade cares about, counted only when the column exists.
data_counts AS (
  SELECT
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Organizations' AND column_name = 'password')
      THEN (xpath('/table/row/n/text()', query_to_xml(
        $q$SELECT count(*) AS n FROM public."Organizations" WHERE password IS NOT NULL AND password !~ '^\\$2[aby]\\$[0-9]{2}\\$.{53}$'$q$,
        false, false, '')))[1]::text::int
    END AS org_non_bcrypt,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'auth_provider')
      THEN (xpath('/table/row/n/text()', query_to_xml(
        $q$SELECT count(*) AS n FROM public.users WHERE auth_provider IS NOT NULL AND auth_provider NOT IN ('form', 'google')$q$,
        false, false, '')))[1]::text::int
    END AS bad_auth_provider,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'failed_login_attempts')
      THEN (xpath('/table/row/n/text()', query_to_xml(
        $q$SELECT count(*) AS n FROM public.users WHERE failed_login_attempts < 0$q$,
        false, false, '')))[1]::text::int
    END AS negative_attempts
),
data_rows AS (
  SELECT 'data: organization passwords' AS section,
    CASE WHEN org_non_bcrypt IS NULL THEN 'n/a' WHEN org_non_bcrypt = 0 THEN 'ok' ELSE 'will be cleared' END AS status,
    coalesce(org_non_bcrypt || ' not bcrypt', '-') AS objects, '-' AS ledger,
    CASE WHEN org_non_bcrypt > 0 THEN 'the upgrade clears these; give each organization a new password afterwards' ELSE '' END AS missing_items
  FROM data_counts
  UNION ALL
  SELECT 'data: users.auth_provider',
    CASE WHEN bad_auth_provider IS NULL THEN 'n/a' WHEN bad_auth_provider = 0 THEN 'ok' ELSE 'blocks upgrade' END,
    coalesce(bad_auth_provider || ' not form/google', '-'), '-',
    CASE WHEN bad_auth_provider > 0 THEN 'set each to form or google before upgrading' ELSE '' END
  FROM data_counts
  UNION ALL
  SELECT 'data: users.failed_login_attempts',
    CASE WHEN negative_attempts IS NULL THEN 'n/a' WHEN negative_attempts = 0 THEN 'ok' ELSE 'blocks upgrade' END,
    coalesce(negative_attempts || ' negative', '-'), '-',
    CASE WHEN negative_attempts > 0 THEN 'reset them to 0 before upgrading' ELSE '' END
  FROM data_counts
),
-- Differences from 0000 that the upgrade aligns before 0015.
alignment AS (
  SELECT array_remove(ARRAY[
    CASE WHEN to_regclass('public."Organizations"') IS NOT NULL AND (
      SELECT array_agg(a.attname::TEXT ORDER BY a.attnum)
        FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
       WHERE k.conrelid = to_regclass('public."Organizations"') AND k.contype = 'p'
    ) IS DISTINCT FROM ARRAY['id'] THEN 'Organizations primary key is not (id)' END,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Organizations' AND column_name = 'password' AND (is_nullable = 'NO' OR column_default IS NOT NULL))
      THEN 'Organizations.password is not null or has a default' END,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password' AND is_nullable = 'NO')
      THEN 'users.password is not null' END,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'orgCode' AND column_default IS NOT NULL)
      THEN 'users.orgCode has a default' END,
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'org_id' AND data_type <> 'text')
      THEN 'sessions.org_id is not text' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.sessions') AND conname = 'sessions_visibility_check')
      THEN 'sessions.visibility check predates organization' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM (VALUES ('sessions'), ('decks'), ('profiles')) AS t(name)
       WHERE to_regclass('public.' || t.name) IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_constraint k
          WHERE k.conrelid = to_regclass('public.' || t.name) AND k.contype = 'f'
            AND k.confrelid = to_regclass('public.users')))
      THEN 'sessions, decks or profiles not linked to users' END,
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND (
      (tablename = 'session_pdfs' AND policyname = 'Allow all access for authenticated users') OR
      (tablename = 'waitlist' AND policyname IN ('Allow anon waitlist select', 'Allow anon waitlist updates', 'Allow anon waitlist inserts'))))
      THEN 'open-access policies on session_pdfs or waitlist' END
  ], NULL) AS items
),
alignment_rows AS (
  SELECT 'alignment' AS section,
    CASE WHEN cardinality(items) = 0 THEN 'ok' ELSE 'will be aligned' END AS status,
    cardinality(items) || ' difference(s)' AS objects, '-' AS ledger,
    array_to_string(items, ', ') AS missing_items
  FROM alignment
),
schema_rows AS (
SELECT
  sec.section,
  CASE
    -- A migration that only changes existing objects is judged by its ledger row.
    WHEN s.section IS NULL THEN CASE
      WHEN EXISTS (SELECT 1 FROM ledger l WHERE l.version = sec.section) THEN 'applied'
      ELSE 'missing'
    END
    WHEN s.present_count = s.expected_count THEN CASE WHEN sec.section = 'prerequisites' THEN 'ok' ELSE 'applied' END
    WHEN s.present_count = 0 THEN 'missing'
    ELSE 'partial'
  END AS status,
  coalesce(s.present_count || ' / ' || s.expected_count, 'ledger only') AS objects,
  CASE
    WHEN sec.section = 'prerequisites' OR sec.section < '0018' THEN '-'
    WHEN EXISTS (SELECT 1 FROM ledger l WHERE l.version = sec.section) THEN 'recorded'
    ELSE 'not recorded'
  END AS ledger,
  coalesce(array_to_string(s.missing_items, ', '), '') AS missing_items
FROM sections sec
LEFT JOIN summary s ON s.section = sec.section
)
SELECT section, status, objects, ledger, missing_items
FROM (
  SELECT 0 AS block, * FROM schema_rows
  UNION ALL
  SELECT 1, * FROM alignment_rows
  UNION ALL
  SELECT 2, * FROM data_rows
) report
ORDER BY block, section = 'prerequisites' DESC, section;
`;
const checkPath = path.join(outDir, "check_schema_state.sql");
fs.writeFileSync(checkPath, check);

console.log(`wrote ${path.relative(repo, upgradePath)} (${parts.join("\n").split("\n").length} lines)`);
console.log(`wrote ${path.relative(repo, checkPath)} (${expectedRows.length} expected objects)`);
console.log(`prerequisites: ${prereqTables.length} tables, ${prereqColumns.length} columns, buckets ${prereqBuckets.join(", ")}`);
for (const v of VERSIONS) {
  const counts = {};
  for (const o of added[v]) counts[o.split("|")[0]] = (counts[o.split("|")[0]] ?? 0) + 1;
  console.log(`${v}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "(modifies existing objects only)"}`);
}
