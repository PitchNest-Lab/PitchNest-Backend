import "../helpers/testEnv.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { TEST_JWT_SECRET } from "../helpers/testEnv.ts";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { signOrgToken, signUserToken } from "../../services/tokenService.ts";

const ORG_A_PASS = "org-a-correct-horse";
const db = new FakeSupabase();
let base = "";
let close: () => Promise<void>;

function seed() {
  db.seed("Organizations", [
    // id 7 deliberately collides with founder users.id 7 (the C2 scenario).
    { id: 7, org_code: 1111, email: "orga@x.test", org_name: "Org A", password: bcrypt.hashSync(ORG_A_PASS, 4) },
    { id: 8, org_code: 2222, email: "orgb@x.test", org_name: "Org B", password: bcrypt.hashSync("org-b-pass", 4) },
    { id: 9, org_code: 3333, email: "nohash@x.test", org_name: "No Hash", password: null },
    { id: 10, org_code: 4444, email: "plain@x.test", org_name: "Plain", password: "plaintext123" },
  ]);
  db.seed("users", [
    { id: 7, email: "victim@x.test", name: "Victim Founder", isEmailVerified: true, orgCode: "9999" },
    { id: 20, email: "a-member@x.test", name: "A Member", isEmailVerified: true, orgCode: "1111", enrolled_at: "2026-09-01T00:00:00Z" },
    { id: 21, email: "b-member@x.test", name: "B Member", isEmailVerified: true, orgCode: "2222", enrolled_at: "2026-09-01T00:00:00Z" },
  ]);
  db.seed("sessions", [
    { id: 501, user_id: 20, business_name: "A Startup", created_at: "2026-10-01T10:00:00Z", summary: "A feedback", evaluation_report: {} },
    { id: 502, user_id: 21, business_name: "B Secret Startup", created_at: "2026-10-02T10:00:00Z", summary: "B private feedback", evaluation_report: {} },
  ]);
}

const ORG_ROUTES: [string, string][] = [
  ["POST", "/api/organization/details"],
  ["POST", "/api/organization/overview"],
  ["POST", "/api/organization/seats"],
  ["POST", "/api/organization/activity"],
  ["POST", "/api/organization/founder-drill"],
  ["POST", "/api/organization/members"],
  ["POST", "/api/organization/reports/weekly"],
  ["POST", "/api/organization/reports/monthly"],
  ["GET", "/api/organization/replays"],
];

before(async () => {
  seed();
  ({ base, close } = await startApp(db));
});
after(async () => close());

// ── C1: unauthenticated organization endpoints ─────────────────────────────

test("C1: every organization endpoint refuses unauthenticated and wrong-principal requests", async () => {
  const founderToken = signUserToken({ id: 20, email: "a-member@x.test" });
  // Shape of a token minted by the pre-fix orgLogin: untyped, Organizations.id.
  const legacyOrgToken = jwt.sign({ id: 7, email: "orga@x.test", rememberMe: false }, TEST_JWT_SECRET!);
  const forgedOrgToken = jwt.sign({ typ: "org", orgId: 7, orgCode: 1111, email: "orga@x.test" }, "attacker-secret");

  for (const [method, path] of ORG_ROUTES) {
    for (const [label, token] of [
      ["no token", undefined],
      ["founder token", founderToken],
      ["legacy untyped org token", legacyOrgToken],
      ["forged org token", forgedOrgToken],
    ] as const) {
      const r = await call(base, method, path, { token, body: method === "POST" ? { orgId: 1111 } : undefined });
      assert.equal(r.status, 401, `${method} ${path} with ${label} → ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes("a-member@x.test"), `${path} leaked data with ${label}`);
    }
  }
});

test("C1: a valid org token sees only its own organization's members", async () => {
  const token = signOrgToken({ id: 7, orgCode: 1111, email: "orga@x.test" });
  for (const [method, path] of ORG_ROUTES) {
    const r = await call(base, method, path, { token, body: method === "POST" ? {} : undefined });
    assert.equal(r.status, 200, `${method} ${path} → ${r.status}`);
    const text = JSON.stringify(r.json);
    assert.ok(!text.includes("b-member@x.test") && !text.includes("B Secret Startup"), `${path} leaked org B data`);
  }
  const members = await call(base, "POST", "/api/organization/members", { token, body: {} });
  assert.deepEqual(members.json.data.members.map((m: any) => m.email), ["a-member@x.test"]);
});

test("C1: cross-organization access is refused even with a valid org token", async () => {
  const tokenA = signOrgToken({ id: 7, orgCode: 1111, email: "orga@x.test" });
  for (const [method, path] of ORG_ROUTES.filter(([m]) => m === "POST")) {
    for (const orgId of [2222, "2222", " 2222 ", "1111 OR 1=1"]) {
      const r = await call(base, method, path, { token: tokenA, body: { orgId } });
      assert.equal(r.status, 403, `${path} orgId=${JSON.stringify(orgId)} → ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes("b-member@x.test"));
    }
  }
  // Matching orgId (what the dashboard sends once it uses its real code) is fine.
  const ok = await call(base, "POST", "/api/organization/members", { token: tokenA, body: { orgId: "1111" } });
  assert.equal(ok.status, 200);
});

test("C1: an org token for a deleted organization, or with a mismatched org_code/email, is refused", async () => {
  const ghost = signOrgToken({ id: 77, orgCode: 7777, email: "ghost@x.test" });
  assert.equal((await call(base, "POST", "/api/organization/members", { token: ghost, body: {} })).status, 401);

  const wrongCode = signOrgToken({ id: 7, orgCode: 2222, email: "orga@x.test" });
  assert.equal((await call(base, "POST", "/api/organization/members", { token: wrongCode, body: {} })).status, 401);

  const wrongEmail = signOrgToken({ id: 7, orgCode: 1111, email: "orgb@x.test" });
  assert.equal((await call(base, "POST", "/api/organization/members", { token: wrongEmail, body: {} })).status, 401);
});

// ── C2: passwordless organization login ────────────────────────────────────

test("C2: organization login requires the correct password", async () => {
  const path = "/api/auth/organization-login";
  assert.equal((await call(base, "POST", path, { body: { email: "orga@x.test" } })).status, 400);
  assert.equal((await call(base, "POST", path, { body: { email: "orga@x.test", password: "" } })).status, 400);
  assert.equal((await call(base, "POST", path, { body: { email: "orga@x.test", password: "wrong-password" } })).status, 401);
  assert.equal((await call(base, "POST", path, { body: { email: "nobody@x.test", password: "whatever1" } })).status, 401);
  assert.equal(
    (await call(base, "POST", path, { body: { email: "orga@x.test", password: { $ne: "" } } })).status,
    400,
    "non-string password must not reach bcrypt",
  );

  const ok = await call(base, "POST", path, { body: { email: "ORGA@x.test ", password: ORG_A_PASS } });
  assert.equal(ok.status, 200);
  const claims: any = jwt.decode(ok.json.token);
  assert.equal(claims.typ, "org");
  assert.equal(claims.orgCode, 1111);
  assert.equal(claims.id, undefined, "org token must not carry a users-style id claim");
  assert.equal(ok.json.user.principal, "org");
  assert.equal(ok.json.user.orgCode, 1111);
});

test("C2: organizations without a usable bcrypt hash cannot log in (no silent password creation)", async () => {
  const path = "/api/auth/organization-login";
  const nullHash = await call(base, "POST", path, { body: { email: "nohash@x.test", password: "anything123" } });
  assert.equal(nullHash.status, 401);
  // Plaintext stored value: even the exact stored string must not work.
  const plain = await call(base, "POST", path, { body: { email: "plain@x.test", password: "plaintext123" } });
  assert.equal(plain.status, 401);
  // And nothing was written back to the rows.
  const rows = db.rows("Organizations");
  assert.equal(rows.find((o) => o.id === 9)!.password, null);
  assert.equal(rows.find((o) => o.id === 10)!.password, "plaintext123");
});

test("C2 + logs: organization login never logs the organization row, email or hash", async () => {
  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
    (console as any)[k] = (...args: unknown[]) => captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  try {
    const path = "/api/auth/organization-login";
    await call(base, "POST", path, { body: { email: "orga@x.test", password: ORG_A_PASS } });
    await call(base, "POST", path, { body: { email: "orga@x.test", password: "wrong" } });
    await call(base, "POST", path, { body: { email: "nohash@x.test", password: "x123456" } });
  } finally {
    Object.assign(console, originals);
  }
  const logText = captured.join("\n");
  for (const secret of ["orga@x.test", "nohash@x.test", "$2", ORG_A_PASS, "org_name", "Org A"]) {
    assert.ok(!logText.includes(secret), `log output contained ${JSON.stringify(secret)}`);
  }
});

// ── Identity collision: org token vs founder routes ────────────────────────

test("collision: no organization token — new or legacy — authenticates as the founder sharing its id", async () => {
  const legacyOrgToken = jwt.sign({ id: 7, email: "orga@x.test", rememberMe: true }, TEST_JWT_SECRET!);
  const newOrgToken = signOrgToken({ id: 7, orgCode: 1111, email: "orga@x.test" });
  for (const token of [legacyOrgToken, newOrgToken]) {
    for (const [method, path] of [
      ["GET", "/api/auth/me"],
      ["GET", "/api/sessions"],
      ["GET", "/api/billing/plan"],
      ["POST", "/api/auth/refresh"],
    ] as const) {
      const r = await call(base, method, path, { token });
      assert.equal(r.status, 401, `${method} ${path} → ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes("victim@x.test"));
    }
  }
});

test("compatibility: founders' existing (untyped) and new tokens keep working", async () => {
  const legacyFounder = jwt.sign({ id: 7, email: "victim@x.test", rememberMe: false }, TEST_JWT_SECRET!, { expiresIn: "24h" });
  const me = await call(base, "GET", "/api/auth/me", { token: legacyFounder });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, "victim@x.test");

  const refreshed = await call(base, "POST", "/api/auth/refresh", { token: legacyFounder });
  assert.equal(refreshed.status, 200);
  assert.equal((jwt.decode(refreshed.json.token) as any).typ, "user");
  assert.equal((await call(base, "GET", "/api/auth/me", { token: refreshed.json.token })).status, 200);
});
