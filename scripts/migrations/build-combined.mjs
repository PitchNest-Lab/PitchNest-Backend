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
-- The last rows count data the upgrade acts on: organization passwords it will
-- clear, and any values that would stop it.

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
  SELECT 1, * FROM data_rows
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
