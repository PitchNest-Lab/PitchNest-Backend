// Proves migrations 0037 (no trial for new accounts), 0038 (hosted challenges)
// and 0039 (Founder plan for the challenge) against real
// Postgres (PGlite), on top of 0000 + 0015-0036.
// usage: node scripts/migrations/test-challenges.mjs [backend dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, readSql, run, snapshot, diff } from "./pglite.mjs";

const repo = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migDir = path.join(repo, "migrations");
const fileFor = (v) => fs.readdirSync(migDir).find((f) => f.startsWith(`${v}_`) && f.endsWith(".sql"));
const VERSIONS = Array.from({ length: 24 }, (_, i) => String(15 + i).padStart(4, "0"));
const CHALLENGE_SQL = readSql(path.join(migDir, fileFor("0038")));
const FOUNDER_CHALLENGE_SQL = readSql(path.join(migDir, fileFor("0039")));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
const one = async (db, sql, params) => (await rows(db, sql, params))[0];
async function fails(db, sql, pattern) {
  try {
    await db.exec(sql);
    return { ok: false, message: "no error" };
  } catch (error) {
    await db.exec("ROLLBACK").catch(() => {});
    return { ok: pattern.test(String(error?.message)), message: String(error?.message).split("\n")[0] };
  }
}

const db = await freshDb();
await run(db, "0000", readSql(path.join(migDir, "0000_complete_fresh_setup.sql")));
for (const v of VERSIONS) await run(db, v, readSql(path.join(migDir, fileFor(v))));
check("0000 + 0015-0038 apply in order", true);

// ── 0037: no trial for new rows ────────────────────────────────────────────
const plainUser = await one(db, `
  INSERT INTO users (name, email) VALUES ('Default Row', 'default-row@example.com')
  RETURNING trial_started_at, trial_expires_at, trial_status`);
check("0037: a user row inserted without trial columns has no trial",
  plainUser?.trial_started_at === null && plainUser?.trial_expires_at === null && plainUser?.trial_status === "none");
await db.exec(`DELETE FROM users WHERE email = 'default-row@example.com'`);
check("ledger records 0037", !!(await one(db, `SELECT 1 AS ok FROM schema_migrations WHERE version = '0037'`)));

// ── Idempotent ─────────────────────────────────────────────────────────────
const firstSnap = await snapshot(db);
await run(db, "0037 (second run)", readSql(path.join(migDir, fileFor("0037"))));
await run(db, "0038 (second run)", CHALLENGE_SQL);
const again = diff(firstSnap, await snapshot(db));
check("a second run of 0037 and 0038 changes nothing", again.onlyA.length === 0 && again.onlyB.length === 0,
  `${again.onlyA.length + again.onlyB.length} differences`);
check("ledger records 0038", !!(await one(db, `SELECT 1 AS ok FROM schema_migrations WHERE version = '0038'`)));

// ── The seeded challenge and code are drafts ───────────────────────────────
const seeded = await one(db, `
  SELECT c.id, c.status, c.prizes, c.prize_currency, c.discount_code_id, c.confirmations, c.social_handles,
         d.code, d.active, d.percent_off, d.plans, d.terms, d.periods
    FROM challenges c JOIN discount_codes d ON d.id = c.discount_code_id
   WHERE c.slug = 'pitchnest-challenge'`);
check("seeded challenge is a draft linked to PCHU01", seeded?.status === "draft" && seeded?.code === "PCHU01");
check("seeded prizes 100k / 60k / 40k NGN",
  JSON.stringify(seeded?.prizes) === JSON.stringify([{ place: 1, amount: 100000 }, { place: 2, amount: 60000 }, { place: 3, amount: 40000 }]) &&
    seeded?.prize_currency === "NGN");
check("seeded rules are unconfirmed", JSON.stringify(seeded?.confirmations) === "{}");
check("PCHU01 is 50% off Pro monthly, first period, and NOT active",
  seeded?.active === false && seeded?.percent_off === 50 && JSON.stringify(seeded?.plans) === '["pro"]' &&
    JSON.stringify(seeded?.terms) === '["monthly"]' && seeded?.periods === 1);
const challengeId = seeded.id;
const codeId = seeded.discount_code_id;

// â”€â”€ 0039: Founder plan, preserving the staff's other saved settings â”€â”€â”€â”€â”€â”€
await db.exec(`
  UPDATE challenges
     SET promo_enabled = TRUE,
         confirmations = '{"discount":{"by":5,"at":"2026-11-05T00:00:00Z","hash":"old"},"terms":{"by":5,"at":"2026-11-05T00:00:00Z","hash":"old"},"prizes":{"by":5,"at":"2026-11-05T00:00:00Z","hash":"unchanged"}}'::jsonb
   WHERE id = '${challengeId}';
  UPDATE discount_codes SET active = TRUE, max_redemptions = 8 WHERE id = '${codeId}';
`);
await run(db, "0039", FOUNDER_CHALLENGE_SQL);
const founderChallenge = await one(db, `
  SELECT c.status, c.promo_enabled, c.required_plan, c.eligibility, c.terms, c.confirmations,
         d.active, d.percent_off, d.plans, d.terms AS discount_terms, d.periods, d.max_redemptions, d.description
    FROM challenges c JOIN discount_codes d ON d.id = c.discount_code_id
   WHERE c.id = '${challengeId}'`);
check("0039 switches the challenge requirement to paid Founder", founderChallenge?.required_plan === "prep");
check("0039 limits PCHU01 to Founder and updates its label",
  JSON.stringify(founderChallenge?.plans) === '["prep"]' && founderChallenge?.description?.includes("Founder") && !founderChallenge?.description?.includes("Pro Founder"));
check("0039 updates eligibility and terms to Founder",
  founderChallenge?.eligibility?.includes("Founder") && !founderChallenge?.eligibility?.includes("Pro Founder") &&
    founderChallenge?.terms?.includes("Founder") && !founderChallenge?.terms?.includes("Pro Founder"));
check("0039 clears only the confirmations affected by its changes",
  !founderChallenge?.confirmations?.discount && !founderChallenge?.confirmations?.terms && !!founderChallenge?.confirmations?.prizes);
check("0039 preserves publication, promotion and discount settings",
  founderChallenge?.status === "draft" && founderChallenge?.promo_enabled === true && founderChallenge?.active === true &&
    founderChallenge?.percent_off === 50 && JSON.stringify(founderChallenge?.discount_terms) === '["monthly"]' &&
    founderChallenge?.periods === 1 && founderChallenge?.max_redemptions === 8);
check("ledger records 0039", !!(await one(db, `SELECT 1 AS ok FROM schema_migrations WHERE version = '0039'`)));
const founderSnap = await snapshot(db);
await run(db, "0039 (second run)", FOUNDER_CHALLENGE_SQL);
const founderAgain = diff(founderSnap, await snapshot(db));
check("a second run of 0039 changes nothing", founderAgain.onlyA.length === 0 && founderAgain.onlyB.length === 0,
  `${founderAgain.onlyA.length + founderAgain.onlyB.length} differences`);
await db.exec(`
  UPDATE challenges SET promo_enabled = FALSE WHERE id = '${challengeId}';
  UPDATE discount_codes SET active = FALSE, max_redemptions = NULL WHERE id = '${codeId}';
`);

// ── Accounts, businesses, entries ──────────────────────────────────────────
await db.exec(`
  INSERT INTO users (id, name, email, "isEmailVerified", plan, plan_expires_at) VALUES
    (1, 'Ada Founder', 'ada@example.com', true, 'free', NULL),
    (2, 'Bayo Founder', 'bayo@example.com', true, 'free', NULL),
    (3, 'Chi Founder', 'chi@example.com', true, 'free', NULL),
    (4, 'Dami Founder', 'dami@example.com', true, 'free', NULL),
    (5, 'Staff', 'staff@example.com', true, 'free', NULL);
  SELECT setval(pg_get_serial_sequence('users', 'id'), 10);
  INSERT INTO businesses (id, slug, name, business_type, created_by) VALUES
    ('11111111-1111-4111-8111-111111111111', 'ada-co', 'Ada Co', 'software', 1),
    ('22222222-2222-4222-8222-222222222222', 'bayo-co', 'Bayo Co', 'services', 2);
  UPDATE challenges
     SET starts_at = NOW() - INTERVAL '3 days', submission_deadline = NOW() + INTERVAL '5 days'
   WHERE id = '${challengeId}';
`);
const entry = async (userId) =>
  (await one(db, `INSERT INTO challenge_participants (challenge_id, user_id) VALUES ($1, $2) RETURNING id`, [challengeId, userId])).id;
const p1 = await entry(1);
const p2 = await entry(2);
const p3 = await entry(3);
const p4 = await entry(4);

const dup = await fails(db, `INSERT INTO challenge_participants (challenge_id, user_id) VALUES ('${challengeId}', 1)`, /challenge_participants_one_entry/);
check("a founder cannot enter the same challenge twice", dup.ok, dup.message);
await db.exec(`UPDATE challenge_participants SET business_id = '11111111-1111-4111-8111-111111111111' WHERE id = '${p1}'`);
const sameBusiness = await fails(db,
  `UPDATE challenge_participants SET business_id = '11111111-1111-4111-8111-111111111111' WHERE id = '${p2}'`,
  /challenge_participants_one_per_business/);
check("one business cannot be entered twice in a challenge", sameBusiness.ok, sameBusiness.message);

// ── Verified scores ────────────────────────────────────────────────────────
const report = (scores, status = "complete", extra = {}) => JSON.stringify({ scores, evaluationStatus: status, ...extra });
const sessionsSql = (userId, items) => items.map(([mode, scores, status, ago, extra]) =>
  `INSERT INTO sessions (user_id, mode, evaluation_report, created_at) VALUES (${userId}, ${mode === null ? "NULL" : `'${mode}'`}, '${report(scores, status, extra)}', NOW() - INTERVAL '${ago}');`).join("\n");
await db.exec(sessionsSql(1, [
  ["panel", { delivery: 70, clarity: 72, scalability: 68, readiness: 70 }, "complete", "2 days"],          // 70
  ["coach", { delivery: 95, clarity: 95, scalability: 95, readiness: 95 }, "complete", "2 days"],          // coach: not eligible
  ["panel", { delivery: 0, clarity: 0, scalability: 0, readiness: 0 }, "insufficient_data", "1 day"],     // incomplete
  ["solo", { delivery: 80, clarity: 81, scalability: 79, readiness: 80 }, "complete", "1 day"],            // 80
  ["panel", { delivery: 99, clarity: 99, scalability: 99, readiness: 99 }, "complete", "4 days"],          // before the window
  ["panel", { delivery: 150, clarity: 90, scalability: 90, readiness: 90 }, "complete", "1 day"],          // invalid category
  ["panel", { delivery: "86", clarity: "85", scalability: "84", readiness: "85" }, "complete", "3 hours"], // 85 (string scores)
  ["panel", { delivery: 91, clarity: 91, scalability: 91, readiness: 91 }, "failed", "2 hours"],           // failed evaluation
  [null, { delivery: 60, clarity: 60, scalability: 60, readiness: 60 }, "complete", "5 hours", { mode: "panel" }], // mode only in report
]));
await db.exec(sessionsSql(2, [["panel", { delivery: 97, clarity: 97, scalability: 97, readiness: 97 }, "complete", "1 day"]]));

const updated = await one(db, `SELECT refresh_challenge_scores($1, $2) AS n`, [challengeId, p1]);
let e1 = await one(db, `SELECT best_score, best_session_id, completed_sessions, score_frozen_at, score_checked_at FROM challenge_participants WHERE id = $1`, [p1]);
check("refresh updates only the requested entry", updated?.n === 1);
check("best score = highest complete, eligible-mode session in the window (85)", e1?.best_score === 85, `got ${e1?.best_score}`);
check("count excludes coach, incomplete, failed, invalid, out-of-window and other users' sessions (4)", e1?.completed_sessions === 4, `got ${e1?.completed_sessions}`);
check("not frozen before the deadline", e1?.score_frozen_at === null && e1?.score_checked_at !== null);
const p2Before = await one(db, `SELECT best_score FROM challenge_participants WHERE id = $1`, [p2]);
check("another founder's entry is untouched by a single-entry refresh", p2Before?.best_score === null);

await db.exec(`INSERT INTO sessions (user_id, mode, evaluation_report, created_at) VALUES (1, 'panel', '${report({ delivery: 70, clarity: 71, scalability: 70, readiness: 71 })}', NOW() - INTERVAL '1 hour')`);
const half = await one(db, `SELECT ROUND((70 + 71 + 70 + 71)::NUMERIC / 4)::INTEGER AS v`);
check("rounding matches computeOverallScore (70.5 rounds to 71)", half?.v === 71);

const allUpdated = await one(db, `SELECT refresh_challenge_scores($1) AS n`, [challengeId]);
check("refresh of the whole challenge updates every entry", allUpdated?.n === 4);
const e2 = await one(db, `SELECT best_score, completed_sessions FROM challenge_participants WHERE id = $1`, [p2]);
check("second founder's own session counts for them (97)", e2?.best_score === 97 && e2?.completed_sessions === 1);
const e4 = await one(db, `SELECT best_score, completed_sessions FROM challenge_participants WHERE id = $1`, [p4]);
check("a founder with no sessions has no score", e4?.best_score === null && e4?.completed_sessions === 0);

// Deleting the best session before the deadline lowers the best (it no longer exists).
const bestId = (await one(db, `SELECT best_session_id FROM challenge_participants WHERE id = $1`, [p1])).best_session_id;
await db.exec(`DELETE FROM sessions WHERE id = ${bestId}`);
await db.query(`SELECT refresh_challenge_scores($1, $2)`, [challengeId, p1]);
e1 = await one(db, `SELECT best_score, best_session_id FROM challenge_participants WHERE id = $1`, [p1]);
check("before the deadline a deleted session stops counting (85 → 80)", e1?.best_score === 80, `got ${e1?.best_score}`);
check("deleting the best session clears its link (ON DELETE SET NULL) until refreshed", e1?.best_session_id !== bestId);

// The deadline passes: the first refresh freezes; later changes do nothing.
await db.exec(`UPDATE challenges SET submission_deadline = NOW() - INTERVAL '1 minute' WHERE id = '${challengeId}'`);
await db.exec(`INSERT INTO sessions (user_id, mode, evaluation_report, created_at) VALUES (1, 'panel', '${report({ delivery: 98, clarity: 98, scalability: 98, readiness: 98 })}', NOW())`);
await db.query(`SELECT refresh_challenge_scores($1, $2)`, [challengeId, p1]);
e1 = await one(db, `SELECT best_score, best_session_id, score_frozen_at FROM challenge_participants WHERE id = $1`, [p1]);
check("a session saved after the deadline does not count (still 80)", e1?.best_score === 80, `got ${e1?.best_score}`);
check("the first refresh after the deadline freezes the entry", e1?.score_frozen_at !== null);
await db.exec(`DELETE FROM sessions WHERE id = ${e1.best_session_id}`);
const frozenRefresh = await one(db, `SELECT refresh_challenge_scores($1, $2) AS n`, [challengeId, p1]);
const e1Frozen = await one(db, `SELECT best_score FROM challenge_participants WHERE id = $1`, [p1]);
check("a frozen entry is never recomputed, even after deleting its session", frozenRefresh?.n === 0 && e1Frozen?.best_score === 80);

// A not-yet-frozen entry keeps the higher stored best when the deadline has passed.
await db.exec(`DELETE FROM sessions WHERE user_id = 2`);
await db.query(`SELECT refresh_challenge_scores($1, $2)`, [challengeId, p2]);
const e2Frozen = await one(db, `SELECT best_score, score_frozen_at FROM challenge_participants WHERE id = $1`, [p2]);
check("after the deadline the stored verified best is kept if its session is gone (97)", e2Frozen?.best_score === 97 && e2Frozen?.score_frozen_at !== null);
check("refresh of an unknown challenge returns 0",
  (await one(db, `SELECT refresh_challenge_scores('00000000-0000-4000-8000-000000000000') AS n`))?.n === 0);

// ── Winners ────────────────────────────────────────────────────────────────
await db.exec(`UPDATE challenge_participants SET status = 'approved' WHERE id IN ('${p1}', '${p2}', '${p3}')`);
const placements = (list) => JSON.stringify(list.map(([participantId, place]) => ({ participantId, place })));
const setOk = await one(db, `SELECT set_challenge_placements($1, 5, $2::jsonb) AS n`, [challengeId, placements([[p1, 1], [p2, 2], [p3, 3]])]);
check("three approved entries take places 1-3", setOk?.n === 3);
const placed = await rows(db, `SELECT id, placement FROM challenge_participants WHERE challenge_id = $1 AND placement IS NOT NULL ORDER BY placement`, [challengeId]);
check("placements stored", placed.map((r) => r.id).join() === [p1, p2, p3].join());
const audit = await one(db, `SELECT actor_id, action FROM admin_audit_log WHERE challenge_id = $1 ORDER BY id DESC LIMIT 1`, [challengeId]);
check("placements are written to the audit log", audit?.action === "challenge.placements_set" && audit?.actor_id === 5);

const swap = await one(db, `SELECT set_challenge_placements($1, 5, $2::jsonb) AS n`, [challengeId, placements([[p2, 1], [p1, 2], [p3, 3]])]);
check("places can be swapped in one call", swap?.n === 3 &&
  (await one(db, `SELECT placement FROM challenge_participants WHERE id = $1`, [p2]))?.placement === 1);

for (const [label, list, pattern] of [
  ["the same place twice", [[p1, 1], [p2, 1]], /DUPLICATE_PLACE/],
  ["the same founder twice (two prizes)", [[p1, 1], [p1, 2]], /DUPLICATE_WINNER/],
  ["an entry that is not approved", [[p4, 1]], /WINNER_NOT_ELIGIBLE/],
  ["a place with no prize", [[p1, 4]], /INVALID_PLACE/],
  ["a malformed id", [["not-a-uuid", 1]], /INVALID_PLACEMENTS/],
]) {
  const result = await fails(db, `SELECT set_challenge_placements('${challengeId}', 5, '${placements(list)}'::jsonb)`, pattern);
  check(`placements refuse ${label}`, result.ok, result.message);
}
const kept = await rows(db, `SELECT id FROM challenge_participants WHERE challenge_id = $1 AND placement IS NOT NULL ORDER BY placement`, [challengeId]);
check("a refused call leaves the previous placements intact", kept.map((r) => r.id).join() === [p2, p1, p3].join());
const directDup = await fails(db, `UPDATE challenge_participants SET placement = 1 WHERE id = '${p3}'`, /challenge_participants_one_per_place/);
check("the database itself refuses two winners in one place", directDup.ok, directDup.message);
const unapprove = await fails(db, `UPDATE challenge_participants SET status = 'disqualified' WHERE id = '${p1}'`, /challenge_participants_placement_approved/);
check("a placed winner cannot leave 'approved' without losing the place first", unapprove.ok, unapprove.message);
await db.exec(`UPDATE challenges SET results_published_at = NOW() WHERE id = '${challengeId}'`);
const afterPublish = await fails(db, `SELECT set_challenge_placements('${challengeId}', 5, '${placements([[p1, 1]])}'::jsonb)`, /RESULTS_ALREADY_PUBLISHED/);
check("placements are locked once results are published", afterPublish.ok, afterPublish.message);
await db.exec(`UPDATE challenges SET results_published_at = NULL WHERE id = '${challengeId}'`);
const cleared = await one(db, `SELECT set_challenge_placements($1, 5, '[]'::jsonb) AS n`, [challengeId]);
check("an empty list clears every placement", cleared?.n === 0 &&
  (await one(db, `SELECT count(*)::int AS n FROM challenge_participants WHERE challenge_id = $1 AND placement IS NOT NULL`, [challengeId]))?.n === 0);

// ── Discount redemption ────────────────────────────────────────────────────
let payN = 0;
const pay = async (userId, { amount = 5000, mode = "manual", plan = "prep", term = "monthly", currency = "NGN" } = {}) => {
  const ref = `pn-${userId}-${Date.now()}${String(payN++).padStart(3, "0")}-${"a".repeat(16)}`;
  await db.query(`
    INSERT INTO payments (user_id, tx_ref, status, amount, currency, plan, term, granted_days, kind, billing_mode)
    VALUES ($1, $2, 'pending', $3, $4, $5, $6, 32, 'subscription_initial', $7)`, [userId, ref, amount, currency, plan, term, mode]);
  return ref;
};
const reserve = async (userId, ref, list = 10000, amount = 5000, currency = "NGN") =>
  (await one(db, `SELECT reserve_discount_redemption($1, $2, $3, $4, $5, $6) AS r`, [codeId, userId, ref, list, amount, currency])).r;
const redemption = async (ref) => one(db, `SELECT status, redeemed_at, released_at FROM discount_redemptions WHERE tx_ref = $1`, [ref]);

const inactiveRef = await pay(1);
check("an inactive code is refused", (await reserve(1, inactiveRef)) === "inactive");
await db.exec(`UPDATE discount_codes SET active = TRUE WHERE id = '${codeId}'`);
await db.exec(`UPDATE discount_codes SET starts_at = NOW() + INTERVAL '1 day' WHERE id = '${codeId}'`);
check("a code before its start is refused", (await reserve(1, await pay(1))) === "not_started");
await db.exec(`UPDATE discount_codes SET starts_at = NOW() - INTERVAL '2 days', ends_at = NOW() - INTERVAL '1 day' WHERE id = '${codeId}'`);
check("an expired code is refused", (await reserve(1, await pay(1))) === "expired");
await db.exec(`UPDATE discount_codes SET starts_at = NULL, ends_at = NULL WHERE id = '${codeId}'`);
check("automatic renewal is refused (manual checkout only)", (await reserve(1, await pay(1, { mode: "auto_renew" }))) === "manual_only");
check("another plan is refused", (await reserve(1, await pay(1, { plan: "pro" }))) === "not_applicable");
check("another term is refused", (await reserve(1, await pay(1, { term: "annual" }))) === "not_applicable");
const wrongAmount = await fails(db, `SELECT reserve_discount_redemption('${codeId}', 1, '${await pay(1, { amount: 3000 })}', 10000, 3000, 'NGN')`, /INVALID_DISCOUNT_AMOUNT/);
check("an amount that is not exactly 50% off is refused", wrongAmount.ok, wrongAmount.message);
const otherUser = await fails(db, `SELECT reserve_discount_redemption('${codeId}', 2, '${await pay(1)}', 10000, 5000, 'NGN')`, /DISCOUNT_PAYMENT_MISMATCH/);
check("a payment of another founder cannot be discounted", otherUser.ok, otherUser.message);

const firstRef = await pay(1);
check("a valid checkout reserves the code", (await reserve(1, firstRef)) === "reserved");
check("the redemption starts pending", (await redemption(firstRef))?.status === "pending");
const secondRef = await pay(1);
check("a second attempt by the same founder is allowed", (await reserve(1, secondRef)) === "reserved");
check("…and releases their earlier unfinished one", (await redemption(firstRef))?.status === "released");

const granted = await one(db, `SELECT grant_pro_access($1, '9001', 5000, 'NGN') AS ok`, [secondRef]);
const u1 = await one(db, `SELECT plan, plan_expires_at > NOW() + INTERVAL '30 days' AS covered FROM users WHERE id = 1`);
check("grant_pro_access settles the discounted Founder amount", granted?.ok === true && u1?.plan === "prep" && u1?.covered === true);
check("settling the payment marks the redemption redeemed", (await redemption(secondRef))?.status === "redeemed");
const shortPay = await pay(3);
await reserve(3, shortPay);
const short = await fails(db, `SELECT grant_pro_access('${shortPay}', '9002', 4000, 'NGN')`, /PAYMENT_AMOUNT_MISMATCH/);
check("paying less than the discounted amount still grants nothing", short.ok, short.message);
check("…and the redemption stays pending", (await redemption(shortPay))?.status === "pending");
check("the same founder cannot use a first-period code again", (await reserve(1, await pay(1))) === "already_used");

const failedRef = await pay(2);
check("another founder can use the code", (await reserve(2, failedRef)) === "reserved");
await db.exec(`UPDATE payments SET status = 'failed', completed_at = NOW() WHERE tx_ref = '${failedRef}' AND status = 'pending'`);
check("a failed payment releases its redemption", (await redemption(failedRef))?.status === "released");

await db.exec(`UPDATE discount_codes SET max_redemptions = 1 WHERE id = '${codeId}'`);
check("the usage limit counts settled redemptions", (await reserve(4, await pay(4))) === "exhausted");
await db.exec(`UPDATE discount_codes SET max_redemptions = 3 WHERE id = '${codeId}'`);
const holdRef = await pay(4);
check("below the limit a checkout reserves", (await reserve(4, holdRef)) === "reserved");
check("pending checkouts hold a place against the limit", (await reserve(2, await pay(2))) === "exhausted");
await db.exec(`UPDATE discount_redemptions SET created_at = NOW() - INTERVAL '3 hours' WHERE tx_ref = '${holdRef}'`);
check("an abandoned checkout stops holding a place after two hours", (await reserve(2, await pay(2))) === "reserved");
await db.exec(`UPDATE discount_codes SET max_redemptions = NULL, new_customers_only = TRUE WHERE id = '${codeId}'`);
await db.exec(`UPDATE payments SET status = 'successful', provider_ref = '9100', completed_at = NOW() WHERE tx_ref = '${await pay(3, { amount: 10000 })}'`);
check("a first-time-customers code refuses a founder who has paid before", (await reserve(3, await pay(3))) === "new_customers_only");
await db.exec(`UPDATE discount_codes SET new_customers_only = FALSE WHERE id = '${codeId}'`);

const plainRef = await pay(4, { amount: 10000 });
await db.exec(`UPDATE payments SET status = 'failed' WHERE tx_ref = '${plainRef}'`);
check("payments without a code settle and fail exactly as before",
  (await one(db, `SELECT status FROM payments WHERE tx_ref = $1`, [plainRef]))?.status === "failed" &&
    !(await redemption(plainRef)));
const constraint = await fails(db, `INSERT INTO discount_codes (code, percent_off) VALUES ('BAD', 50)`, /discount_codes_code_format/);
check("codes must be 4-32 capitals and digits", constraint.ok, constraint.message);
const tooBig = await fails(db, `INSERT INTO discount_codes (code, percent_off) VALUES ('FREEALL', 100)`, /discount_codes_percent_range/);
check("a 100% code cannot exist (checkout always charges something)", tooBig.ok, tooBig.message);

// ── Notifications ──────────────────────────────────────────────────────────
await db.exec(`INSERT INTO notifications (user_id, type, entity_id) VALUES (1, 'challenge_joined', '${challengeId}')`);
await db.exec(`UPDATE challenges SET status = 'draft' WHERE id = '${challengeId}'`);
check("challenge notifications are hidden while the challenge is a draft",
  (await rows(db, `SELECT * FROM list_user_notifications(1, 20)`)).length === 0);
await db.exec(`UPDATE challenges SET status = 'open' WHERE id = '${challengeId}'`);
const listed = await rows(db, `SELECT type, challenge_title, challenge_slug FROM list_user_notifications(1, 20)`);
check("challenge notifications list with the challenge title and slug",
  listed.length === 1 && listed[0].challenge_title === "PitchNest Challenge" && listed[0].challenge_slug === "pitchnest-challenge");
await db.exec(`UPDATE challenge_participants SET status = 'needs_correction', review_note = 'Add your Discover link to the caption.' WHERE id = '${p4}'`);
await db.exec(`INSERT INTO notifications (user_id, type, entity_id) VALUES (4, 'challenge_correction', '${challengeId}')`);
const correction = await one(db, `SELECT excerpt FROM list_user_notifications(4, 20)`);
check("a correction notification shows the reviewer's note", correction?.excerpt === "Add your Discover link to the caption.");
const badType = await fails(db, `INSERT INTO notifications (user_id, type) VALUES (1, 'challenge_spam')`, /notifications_type_values/);
check("unknown notification types are still refused", badType.ok, badType.message);

// ── Grants and RLS ─────────────────────────────────────────────────────────
const fnPrivilege = async (role, signature) =>
  (await one(db, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, signature])).ok;
for (const signature of [
  "refresh_challenge_scores(uuid, uuid)",
  "set_challenge_placements(uuid, integer, jsonb)",
  "reserve_discount_redemption(uuid, integer, text, numeric, numeric, text)",
  "list_user_notifications(integer, integer)",
]) {
  check(`${signature.split("(")[0]}: service_role only`,
    (await fnPrivilege("service_role", signature)) === true &&
      (await fnPrivilege("anon", signature)) === false &&
      (await fnPrivilege("authenticated", signature)) === false);
}
const rls = await rows(db, `
  SELECT relname, relrowsecurity FROM pg_class
   WHERE relname IN ('challenges', 'challenge_participants', 'discount_codes', 'discount_redemptions', 'admin_audit_log')`);
check("row-level security is on for every new table", rls.length === 5 && rls.every((r) => r.relrowsecurity));
const policies = await one(db, `
  SELECT count(*)::int AS n FROM pg_policies
   WHERE tablename IN ('challenges', 'challenge_participants', 'discount_codes', 'discount_redemptions', 'admin_audit_log')
     AND qual = 'false' AND with_check = 'false'`);
check("each new table denies anon and authenticated", policies?.n === 5);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll challenge migration checks passed.");
process.exit(failures ? 1 : 0);
