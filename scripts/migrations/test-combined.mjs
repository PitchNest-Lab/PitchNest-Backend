// Proves migrations/combined/upgrade_0014_to_0031.sql against real Postgres.
// usage: npm run test:migrations   (or: node scripts/migrations/test-combined.mjs [backend dir])
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, readSql, run, snapshot, diff } from "./pglite.mjs";

const repo = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migDir = path.join(repo, "migrations");
const UPGRADE = readSql(path.join(migDir, "combined", "upgrade_0014_to_0031.sql"));
const CHECK = readSql(path.join(migDir, "combined", "check_schema_state.sql"));
const BASE = readSql(path.join(migDir, "0000_complete_fresh_setup.sql"));
const VERSIONS = Array.from({ length: 17 }, (_, i) => String(15 + i).padStart(4, "0"));
const fileFor = (v) => fs.readdirSync(migDir).find((f) => f.startsWith(`${v}_`) && f.endsWith(".sql"));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
const show = (lines, n = 12) => lines.slice(0, n).map((l) => "      " + l).join("\n");

async function base() {
  const db = await freshDb();
  await run(db, "0000", BASE);
  return db;
}
async function sequential(db, upTo = "0031") {
  for (const v of VERSIONS) {
    if (v > upTo) break;
    await run(db, v, readSql(path.join(migDir, fileFor(v))));
  }
}
async function report(db) {
  try {
    const rows = (await db.query(CHECK)).rows;
    return Object.fromEntries(rows.map((r) => [r.section, r]));
  } catch (error) {
    console.log(`FAIL  check script errored: ${error?.message} ${error?.detail ?? ""}`.slice(0, 400));
    failures++;
    return {};
  }
}

// Representative production data, including awkward cases.
const SEED = `
INSERT INTO users (id, name, email, password, "isEmailVerified", plan, plan_expires_at, trial_status, "orgCode", settings) VALUES
  (1, 'Ada Founder', 'ada@example.com', '$2b$10$abcdefghijklmnopqrstuuJ0Tz2c8rVb6Xy8ZQm1fQ4Q8VxQd1W6S', true, 'free', NULL, 'expired', NULL, '{}'),
  (2, 'Ada Again', 'Ada@Example.com', NULL, false, 'free', NULL, 'active', NULL, '{"sttLocale":"en-NG"}'),
  (3, 'Paid Pro', 'pro@example.com', '$2b$10$abcdefghijklmnopqrstuuJ0Tz2c8rVb6Xy8ZQm1fQ4Q8VxQd1W6S', true, 'pro', now() + interval '20 days', 'expired', '1111', '{}'),
  (4, 'Google User', 'g@example.com', NULL, true, 'enterprise', NULL, 'active', '1111', '{}');
SELECT setval(pg_get_serial_sequence('users', 'id'), 10);
INSERT INTO profiles (user_id, startup_name, industry) VALUES (1, 'Ada Co', 'Fintech');
INSERT INTO decks (id, user_id, name, file_url, status) VALUES
  (1, 1, 'Deck', 'decks/1700000000000_deck.pdf', 'ready'),
  (2, 3, 'Old deck', 'https://x.supabase.co/storage/v1/object/public/pitchnest-media/decks/1_old.pdf', 'ready');
INSERT INTO sessions (id, user_id, summary, evaluation_report, video_url, business_name, share_id, mode, pitch_root_id, attempt_number) VALUES
  (1, 1, 'ok', '{"scores":{"clarity":10}}', 'pitches/1700000000001_legacy.webm', 'Ada Co', 'share-abc', 'panel', 1, 1),
  (2, 1, NULL, NULL, '/uploads/1700000000002_local.webm', 'Ada Co', NULL, 'coach', 1, 2),
  (3, 3, 'pro', '{}', 'pitches/3/1700000000003_x.webm', 'Pro Co', NULL, 'panel', 3, 1);
INSERT INTO session_starts (user_id, started_at) VALUES (1, now() - interval '1 day'), (3, now());
INSERT INTO email_verification_tokens (user_id, token, code, expires_at) VALUES (2, 'tok-1', '123456', now() + interval '1 day');
INSERT INTO password_resets (user_id, token, expires_at) VALUES (1, 'reset-1', now() + interval '1 hour');
INSERT INTO payments (user_id, tx_ref, status, amount, currency, granted_days, plan, term) VALUES
  (3, 'pn-3-1', 'successful', 15, 'USD', 30, 'pro', 'monthly'),
  (1, 'pn-1-1', 'pending', 15, 'USD', 30, 'pro', 'monthly'),
  (1, 'pn-1-2', 'failed', 9.99, 'USD', 30, 'prep', 'monthly');
INSERT INTO "Organizations" (id, org_code, org_name, email, password, plan) VALUES
  (1, 1111, 'Alpha Accelerator', 'alpha@example.com', '$2b$10$abcdefghijklmnopqrstuuJ0Tz2c8rVb6Xy8ZQm1fQ4Q8VxQd1W6S', 'enterprise'),
  (2, 2222, 'Plaintext Org', 'Plain@Example.com', 'plaintext123', 'enterprise'),
  (3, 3333, 'No Password Org', 'nopass@example.com', NULL, NULL);
INSERT INTO waitlist (email, pitch_type) VALUES ('w@example.com', 'seed');
`;

// ── 1. The combined script matches the 17 migrations run one by one ────────
const seqDb = await base();
await sequential(seqDb);
const seqSnap = await snapshot(seqDb);

const combDb = await base();
const before = await report(combDb);
check("check script on the 0014 schema: prerequisites ok", before.prerequisites?.status === "ok", before.prerequisites?.objects);
check(
  "check script on the 0014 schema: every migration missing",
  VERSIONS.every((v) => before[v]?.status === "missing"),
  VERSIONS.filter((v) => before[v]?.status !== "missing").map((v) => `${v}=${before[v]?.status}`).join(" "),
);
await run(combDb, "combined", UPGRADE);
const combSnap = await snapshot(combDb);
const d1 = diff(seqSnap, combSnap);
check("combined upgrade == 0015..0031 applied one by one", d1.onlyA.length === 0 && d1.onlyB.length === 0,
  d1.onlyA.length || d1.onlyB.length ? `\n    only sequential:\n${show(d1.onlyA)}\n    only combined:\n${show(d1.onlyB)}` : `${combSnap.length} schema lines`);

const after = await report(combDb);
check(
  "check script after the upgrade: all applied, ledger recorded for 0018+",
  VERSIONS.every((v) => after[v]?.status === "applied" && (v < "0018" || after[v]?.ledger === "recorded")),
  VERSIONS.filter((v) => after[v]?.status !== "applied" || (v >= "0018" && after[v]?.ledger !== "recorded")).map((v) => `${v}=${after[v]?.status}/${after[v]?.ledger}`).join(" "),
);
const ledger = (await combDb.query(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => r.version);
check("ledger records 0015-0031", VERSIONS.every((v) => ledger.includes(v)), ledger.join(","));

// ── 2. Re-running changes nothing ──────────────────────────────────────────
await run(combDb, "combined (second run)", UPGRADE);
const again = await snapshot(combDb);
const d2 = diff(combSnap, again);
check("second run is a no-op", d2.onlyA.length === 0 && d2.onlyB.length === 0, `${d2.onlyA.length + d2.onlyB.length} differences`);

// ── 3. A partially upgraded database (0015-0021 already applied) ───────────
const partDb = await base();
await sequential(partDb, "0021");
const partial = await report(partDb);
check(
  "check script on a partial database: 0015-0021 applied, 0022+ missing",
  VERSIONS.every((v) => partial[v]?.status === (v <= "0021" ? "applied" : "missing")),
  VERSIONS.map((v) => `${v}=${partial[v]?.status}`).join(" "),
);
await run(partDb, "combined on partial", UPGRADE);
const d3 = diff(seqSnap, await snapshot(partDb));
check("combined upgrade completes a partial database to the same schema", d3.onlyA.length === 0 && d3.onlyB.length === 0, `${d3.onlyA.length + d3.onlyB.length} differences`);

// ── 4. Existing data survives ──────────────────────────────────────────────
const dataDb = await base();
await run(dataDb, "seed", SEED);
const counts = async (db) =>
  Object.fromEntries(
    await Promise.all(
      ["users", "profiles", "decks", "sessions", "session_starts", "email_verification_tokens", "password_resets", "payments", '"Organizations"', "waitlist"].map(
        async (t) => [t, Number((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)],
      ),
    ),
  );
const beforeCounts = await counts(dataDb);
const dataReport = await report(dataDb);
check("check script counts the organization passwords the upgrade will clear",
  dataReport["data: organization passwords"]?.status === "will be cleared" && dataReport["data: organization passwords"]?.objects === "1 not bcrypt",
  JSON.stringify(dataReport["data: organization passwords"]));
check("check script reports clean auth_provider and failed_login_attempts data",
  dataReport["data: users.auth_provider"]?.status === "ok" && dataReport["data: users.failed_login_attempts"]?.status === "ok");
let dataError = null;
try {
  await run(dataDb, "combined with data", UPGRADE);
} catch (error) {
  dataError = error;
}
check("upgrade succeeds on a database holding representative data", !dataError, dataError ? "\n" + String(dataError.message).slice(0, 1500) : "");
if (!dataError) {
  const afterCounts = await counts(dataDb);
  check("no rows lost", JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), JSON.stringify(afterCounts));
  const orgs = (await dataDb.query(`SELECT id, password, org_users_enrolled FROM "Organizations" ORDER BY id`)).rows;
  check("bcrypt organization password kept; plaintext one cleared; missing one stays missing",
    orgs[0]?.password?.startsWith("$2b$") && orgs[1]?.password === null && orgs[2]?.password === null);
  check("0030 backfilled organization enrolment counts", orgs[0]?.org_users_enrolled === 2, `org 1111 enrolled=${orgs[0]?.org_users_enrolled}`);
  const users = (await dataDb.query(`SELECT id, auth_provider, auth_version FROM users ORDER BY id`)).rows;
  check("existing users keep their sign-in method and start at auth_version 0",
    users.every((u) => ["form", "google"].includes(u.auth_provider) && u.auth_version === 0), JSON.stringify(users));
  const postReport = await report(dataDb);
  check("check script after a data upgrade: all applied, data ok",
    VERSIONS.every((v) => postReport[v]?.status === "applied") && postReport["data: organization passwords"]?.status === "ok");
  // Joining an organization fires the 0030 enrolment trigger on the org row.
  let joinError = null;
  try {
    await dataDb.exec(`UPDATE users SET "orgCode" = '2222' WHERE id = 1;`);
  } catch (error) {
    joinError = error;
  }
  check("a user can join the organization whose password was cleared", !joinError, joinError?.message ?? "");
}

// ── 4b. Values 0030 would reject stop the upgrade before any change ─────────
const providerDb = await base();
await run(providerDb, "seed bad auth_provider", `
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;
  INSERT INTO users (name, email, auth_provider) VALUES ('Legacy', 'legacy@example.com', 'email');
`);
const providerBefore = await snapshot(providerDb);
let providerError = null;
try {
  await run(providerDb, "combined with bad auth_provider", UPGRADE);
} catch (error) {
  providerError = error;
}
// A failed BEGIN...COMMIT leaves the session's transaction aborted; the SQL editor discards it.
await providerDb.exec("ROLLBACK").catch(() => {});
check("upgrade refuses an auth_provider 0030 would reject", !!providerError && /auth_provider other than form or google/.test(providerError.message), providerError?.message?.split("\n")[0]?.slice(0, 160));
const dp = diff(providerBefore, await snapshot(providerDb));
check("nothing changed after that refusal", dp.onlyA.length === 0 && dp.onlyB.length === 0, `${dp.onlyA.length + dp.onlyB.length} differences`);
const providerReport = await report(providerDb);
check("check script flags the auth_provider value", providerReport["data: users.auth_provider"]?.status === "blocks upgrade");

// ── 5. Pre-flight stops a database that is missing part of the 0014 schema ─
const gapDb = await base();
await run(gapDb, "remove a prerequisite", `ALTER TABLE sessions DROP COLUMN pitch_root_id CASCADE;`);
const gapBefore = await snapshot(gapDb);
let gapError = null;
try {
  await run(gapDb, "combined on gap", UPGRADE);
} catch (error) {
  gapError = error;
}
await gapDb.exec("ROLLBACK").catch(() => {});
check("pre-flight refuses and names the missing column", !!gapError && /sessions\.pitch_root_id/.test(gapError.message), gapError ? gapError.message.split("\n")[0].slice(0, 200) : "no error");
const gapAfter = await snapshot(gapDb);
const d5 = diff(gapBefore, gapAfter);
check("nothing changed after the refusal", d5.onlyA.length === 0 && d5.onlyB.length === 0, `${d5.onlyA.length + d5.onlyB.length} differences`);
const gapReport = await report(gapDb);
check("check script reports the gap", gapReport.prerequisites?.status === "partial" && /sessions\.pitch_root_id/.test(gapReport.prerequisites?.missing_items ?? ""), gapReport.prerequisites?.missing_items);

// ── 6. An older schema_migrations table (no description column) ───────────
// The shape found on the team's DEV and PROD databases before the upgrade.
const LEGACY_LEDGER = `
  CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "schema_migrations_deny_anon" ON schema_migrations
    FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
`;
const ledgerDb = await base();
await run(ledgerDb, "legacy ledger", LEGACY_LEDGER + `INSERT INTO schema_migrations (version) VALUES ('0007');`);
const ledgerReport = await report(ledgerDb);
check("check script shows 0018 partial (5 / 8), as on the team databases",
  ledgerReport["0018"]?.status === "partial" && ledgerReport["0018"]?.objects === "5 / 8", JSON.stringify(ledgerReport["0018"]));
await run(ledgerDb, "combined on legacy ledger", UPGRADE);
const d6 = diff(seqSnap, await snapshot(ledgerDb));
check("upgrade brings a database with the older ledger to the same schema", d6.onlyA.length === 0 && d6.onlyB.length === 0,
  d6.onlyA.length || d6.onlyB.length ? `\n${show(d6.onlyA)}\n${show(d6.onlyB)}` : "");
const ledgerRows = (await ledgerDb.query(`SELECT version, description FROM schema_migrations ORDER BY version`)).rows;
check("the older row is kept and labelled; 0015-0031 are recorded",
  ledgerRows.find((r) => r.version === "0007")?.description === "Recorded before the ledger had descriptions" &&
    VERSIONS.every((v) => ledgerRows.some((r) => r.version === v)),
  ledgerRows.map((r) => r.version).join(","));
await run(ledgerDb, "combined on legacy ledger (second run)", UPGRADE);
const d6b = diff(seqSnap, await snapshot(ledgerDb));
check("a second run on it is a no-op", d6b.onlyA.length === 0 && d6b.onlyB.length === 0);

// ── 7. An older ledger that already claims a version this upgrade applies ──
const claimDb = await base();
await run(claimDb, "legacy ledger claiming 0019", LEGACY_LEDGER + `INSERT INTO schema_migrations (version) VALUES ('0019');`);
const claimBefore = await snapshot(claimDb);
let claimError = null;
try {
  await run(claimDb, "combined on claimed ledger", UPGRADE);
} catch (error) {
  claimError = error;
}
await claimDb.exec("ROLLBACK").catch(() => {});
check("upgrade refuses an older ledger that records 0015+ versions", !!claimError && /records version\(s\) 0019/.test(claimError.message),
  claimError ? claimError.message.split("\n")[0].slice(0, 200) : "no error");
const d7 = diff(claimBefore, await snapshot(claimDb));
check("nothing changed after that refusal", d7.onlyA.length === 0 && d7.onlyB.length === 0, `${d7.onlyA.length + d7.onlyB.length} differences`);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll combined-migration checks passed.");
process.exit(failures ? 1 : 0);
