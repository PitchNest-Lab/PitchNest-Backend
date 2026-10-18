import "../helpers/testEnv.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { TEST_JWT_SECRET } from "../helpers/testEnv.ts";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { signOrgToken, signUserToken } from "../helpers/tokens.ts";

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
      // 401 for a missing or invalid token, 403 for a valid founder token.
      assert.ok([401, 403].includes(r.status), `${method} ${path} with ${label} → ${r.status}`);
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

test("C1: a client-supplied orgId never widens an org token's scope", async () => {
  // Handlers scope every query to the organization row behind the token; any
  // orgId in the body is ignored rather than trusted.
  const tokenA = signOrgToken({ id: 7, orgCode: 1111, email: "orga@x.test" });
  for (const [method, path] of ORG_ROUTES.filter(([m]) => m === "POST")) {
    for (const orgId of [2222, "2222", " 2222 ", "1111 OR 1=1"]) {
      const r = await call(base, method, path, { token: tokenA, body: { orgId } });
      assert.equal(r.status, 200, `${path} orgId=${JSON.stringify(orgId)} → ${r.status}`);
      const text = JSON.stringify(r.json);
      assert.ok(!text.includes("b-member@x.test") && !text.includes("B Secret Startup"), `${path} leaked org B data`);
    }
  }
  const members = await call(base, "POST", "/api/organization/members", { token: tokenA, body: { orgId: 2222 } });
  assert.deepEqual(members.json.data.members.map((m: any) => m.email), ["a-member@x.test"]);
});

test("C1: an org token for a deleted organization is refused; stale claims cannot change scope", async () => {
  const ghost = signOrgToken({ id: 77, orgCode: 7777, email: "ghost@x.test" });
  assert.equal((await call(base, "POST", "/api/organization/members", { token: ghost, body: {} })).status, 401);

  // The organization row, not the token's claims, decides the scope.
  for (const token of [
    signOrgToken({ id: 7, orgCode: 2222, email: "orga@x.test" }),
    signOrgToken({ id: 7, orgCode: 1111, email: "orgb@x.test" }),
  ]) {
    const r = await call(base, "POST", "/api/organization/members", { token, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.members.map((m: any) => m.email), ["a-member@x.test"]);
  }

  // Bumping the organization's auth_version revokes every outstanding token.
  const orgA = db.rows("Organizations").find((o) => o.id === 7)!;
  orgA.auth_version = 1;
  try {
    const revoked = signOrgToken({ id: 7, orgCode: 1111, email: "orga@x.test" });
    assert.equal((await call(base, "POST", "/api/organization/members", { token: revoked, body: {} })).status, 401);
  } finally {
    orgA.auth_version = 0;
  }
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
  assert.equal(claims.kind, "access");
  assert.equal(claims.accountType, "organization", "org tokens are typed so founder routes refuse them");
  assert.equal(claims.orgCode, "1111");
  assert.equal(ok.json.user.accountType, "organization");
  assert.equal(String(ok.json.user.orgCode), "1111");
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
  const founderOnly = [
    ["GET", "/api/sessions"],
    ["GET", "/api/billing/plan"],
  ] as const;
  const accountRoutes = [
    ["GET", "/api/auth/me"],
    ["POST", "/api/auth/refresh"],
  ] as const;

  // Untyped tokens from before the fix are not access tokens at all.
  for (const [method, path] of [...founderOnly, ...accountRoutes]) {
    const r = await call(base, method, path, { token: legacyOrgToken });
    assert.equal(r.status, 401, `legacy org token: ${method} ${path} → ${r.status}`);
    assert.ok(!JSON.stringify(r.json).includes("victim@x.test"));
  }
  // A current org token is refused on founder routes...
  for (const [method, path] of founderOnly) {
    const r = await call(base, method, path, { token: newOrgToken });
    assert.ok([401, 403].includes(r.status), `org token: ${method} ${path} → ${r.status}`);
    assert.ok(!JSON.stringify(r.json).includes("victim@x.test"));
  }
  // ...and on account routes it is the organization, never founder 7.
  for (const [method, path] of accountRoutes) {
    const r = await call(base, method, path, { token: newOrgToken });
    assert.equal(r.status, 200, `org token: ${method} ${path} → ${r.status}`);
    assert.ok(!JSON.stringify(r.json).includes("victim@x.test"), `${path} answered as the colliding founder`);
  }
});

test("compatibility: current founder tokens work and refresh; untyped legacy tokens need a new login", async () => {
  const founder = signUserToken({ id: 7, email: "victim@x.test" });
  const me = await call(base, "GET", "/api/auth/me", { token: founder });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, "victim@x.test");

  const refreshed = await call(base, "POST", "/api/auth/refresh", { token: founder });
  assert.equal(refreshed.status, 200);
  const claims = jwt.decode(refreshed.json.token) as any;
  assert.equal(claims.kind, "access");
  assert.notEqual(claims.accountType, "organization");
  assert.equal((await call(base, "GET", "/api/auth/me", { token: refreshed.json.token })).status, 200);

  // Tokens issued before this release carry no issuer, audience or kind, so
  // they are refused once and the founder signs in again.
  const legacyFounder = jwt.sign({ id: 7, email: "victim@x.test", rememberMe: false }, TEST_JWT_SECRET!, { expiresIn: "24h" });
  assert.equal((await call(base, "GET", "/api/auth/me", { token: legacyFounder })).status, 401);
});
