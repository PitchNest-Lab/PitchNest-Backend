// Executes the full 0040 transaction against PostgreSQL (PGlite), including
// the strict migration ledger and incompatible legacy organization tables.
// Nothing here connects to an environment database.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, readSql, run, snapshot } from "./pglite.mjs";

const repo = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migDir = path.join(repo, "migrations");
const migration = readSql(path.join(migDir, "0040_organization_lifecycle.sql"));
const prerequisites = fs.readdirSync(migDir)
  .filter((file) => /^00(1[5-9]|[23][0-9])_.*\.sql$/.test(file))
  .sort();
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const check = (name, condition) => {
  assert.ok(condition, name);
  console.log(`PASS  ${name}`);
};

async function preparedDb() {
  const db = await freshDb();
  await run(db, "0000", readSql(path.join(migDir, "0000_complete_fresh_setup.sql")));
  for (const file of prerequisites) await run(db, file, readSql(path.join(migDir, file)));
  return db;
}

// A clean environment must commit with 0018's required ledger description.
const cleanDb = await preparedDb();
try {
  await run(cleanDb, "0040 on a clean schema", migration);
  const ledger = await one(cleanDb, `SELECT description FROM schema_migrations WHERE version = '0040'`);
  check("0040 commits on a clean schema with a nonempty ledger description", !!ledger?.description?.trim());
} finally {
  await cleanDb.close();
}

const db = await preparedDb();
try {
  // These legacy tables intentionally lack both email and organization_id.
  await db.exec(`
    CREATE TABLE organizations (id UUID PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE organization_members (
      id UUID PRIMARY KEY, org_id UUID REFERENCES organizations(id), user_id INTEGER, role TEXT
    );
    CREATE TABLE organization_invites (
      id UUID PRIMARY KEY, org_id UUID REFERENCES organizations(id), recipient TEXT
    );
    INSERT INTO organizations VALUES ('11111111-1111-4111-8111-111111111111', 'Legacy cohort');
    INSERT INTO organization_members VALUES (
      '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 42, 'owner'
    );
    INSERT INTO organization_invites VALUES (
      '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'legacy@example.com'
    );
  `);
  const legacySchema = async () => (await snapshot(db))
    .filter((line) => /\b(?:organizations|organization_members|organization_invites)\b/.test(line));
  const legacyData = async () => (await db.query(`
    SELECT 'organizations' AS source, row_to_json(o)::text AS data FROM organizations o
    UNION ALL SELECT 'members', row_to_json(m)::text FROM organization_members m
    UNION ALL SELECT 'invites', row_to_json(i)::text FROM organization_invites i
    ORDER BY source, data
  `)).rows;
  const schemaBefore = await legacySchema();
  const dataBefore = await legacyData();
  const passwordHash = "$2b$12$kFlQPn/NVygvSVn3YgGLfOEaKPwEO0Ls5BRjKBpQIZqO7aCSazdia";
  const org = await one(db, `
    INSERT INTO "Organizations" (org_code, org_name, email, password, auth_version)
    VALUES (910040, 'Regression cohort', 'Owner@Example.com', $1, 7) RETURNING id
  `, [passwordHash]);

  // Reproduce the reported failure at the last statement and prove rollback.
  const invalidLedger = migration.replace(
    /INSERT INTO schema_migrations \(version, description\)[\s\S]*?ON CONFLICT \(version\) DO NOTHING;/,
    "INSERT INTO schema_migrations (version) VALUES ('0040') ON CONFLICT (version) DO NOTHING;",
  );
  assert.notEqual(invalidLedger, migration, "the rollback fixture must omit the required description");
  await assert.rejects(() => db.exec(invalidLedger), (error) => error.code === "23502");
  await db.exec("ROLLBACK");
  const rolledBack = await one(db, `
    SELECT to_regclass('public.pitchnest_org_staff_accounts') AS staff,
           (SELECT COUNT(*)::int FROM schema_migrations WHERE version = '0040') AS ledger_count,
           password, auth_version FROM "Organizations" WHERE id = $1
  `, [org.id]);
  check("a final ledger failure rolls back the new tables, ledger entry, and credential changes",
    rolledBack.staff === null && rolledBack.ledger_count === 0 &&
    rolledBack.password === passwordHash && rolledBack.auth_version === 7);

  await run(db, "0040 alongside legacy tables", migration);
  const ledger = await one(db, `SELECT description FROM schema_migrations WHERE version = '0040'`);
  check("0040 commits alongside incompatible legacy tables and records its description", !!ledger?.description?.trim());
  assert.deepEqual(await legacySchema(), schemaBefore);
  assert.deepEqual(await legacyData(), dataBefore);
  check("legacy organization schemas and rows are preserved", true);
  const owner = await one(db, `
    SELECT email, password_hash, role, status FROM pitchnest_org_staff_accounts WHERE organization_id = $1
  `, [org.id]);
  check("a normalized owner account is seeded for password recovery",
    owner?.email === 'owner@example.com' && owner.password_hash === null && owner.role === 'owner' && owner.status === 'active');
  const credentials = await one(db, `SELECT password, auth_version FROM "Organizations" WHERE id = $1`, [org.id]);
  check("the old shared credential and sessions are invalidated", credentials.password === null && credentials.auth_version === 8);
  const tables = (await db.query(`
    SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('pitchnest_org_staff_accounts', 'pitchnest_org_cohort_invites',
                      'pitchnest_org_password_resets', 'pitchnest_org_reports')
  `)).rows;
  check("all four lifecycle tables exist with RLS enabled", tables.length === 4 && tables.every((row) => row.relrowsecurity));

  await run(db, "0040 rerun", migration);
  const counts = await one(db, `
    SELECT (SELECT COUNT(*)::int FROM schema_migrations WHERE version = '0040') AS ledger_count,
           (SELECT COUNT(*)::int FROM pitchnest_org_staff_accounts WHERE organization_id = $1) AS owner_count
  `, [org.id]);
  check("rerunning 0040 commits without duplicate ledger or owner rows", counts.ledger_count === 1 && counts.owner_count === 1);
} finally {
  await db.close();
}

console.log("\nAll organization lifecycle migration checks passed.");
