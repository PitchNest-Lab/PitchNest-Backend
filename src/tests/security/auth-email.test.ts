import "../helpers/testEnv.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { __setResponseFloorForTests } from "../../utils/responseFloor.ts";

// On Lambda the function is frozen as soon as its reply is sent, so an email
// that the provider has not accepted by then waits for some later request to
// wake the function. These tests put a slow stand-in for Resend in front of the
// app and check that each auth email was accepted BEFORE its reply came back,
// and that the outcomes that send nothing still take as long as the floor.
const MAIL_DELAY_MS = 200;
const FLOOR_MS = 500;
// Timers can fire a few milliseconds early against Date.now().
const TIMER_SLACK_MS = 20;

interface AcceptedEmail {
  to: string;
  subject: string;
  acceptedAt: number;
}

const accepted: AcceptedEmail[] = [];
const replies = new Map<string, unknown>();
const db = new FakeSupabase();
let mail: Server;
let base = "";
let close: () => Promise<void>;

function startFakeResend(): Promise<string> {
  mail = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/emails") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ statusCode: 404, name: "not_found", message: `${req.method} ${req.url}` }));
        return;
      }
      const email = JSON.parse(raw || "{}");
      const to = [email.to].flat().join(",");
      setTimeout(() => {
        if (to.startsWith("bounce")) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ statusCode: 422, name: "validation_error", message: "Simulated rejection" }));
          return;
        }
        accepted.push({ to, subject: email.subject, acceptedAt: Date.now() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: `test-email-${accepted.length}` }));
      }, MAIL_DELAY_MS);
    });
  });
  return new Promise((resolve) =>
    mail.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(mail.address() as AddressInfo).port}`);
    }),
  );
}

async function post(path: string, body: unknown) {
  const sentAt = Date.now();
  const r = await call(base, "POST", path, { body });
  const repliedAt = Date.now();
  return { ...r, repliedAt, ms: repliedAt - sentAt };
}

function emailTo(address: string, since: number): AcceptedEmail | undefined {
  return accepted.slice(since).find((e) => e.to === address);
}

before(async () => {
  db.seed("users", [
    { id: 30, email: "pending@x.test", name: "Pending Founder", isEmailVerified: false, auth_provider: "form" },
    { id: 31, email: "member@x.test", name: "Member", isEmailVerified: true, auth_provider: "form" },
    { id: 32, email: "google@x.test", name: "Google Member", isEmailVerified: true, auth_provider: "google" },
    { id: 33, email: "bounce@x.test", name: "Bounce Member", isEmailVerified: true, auth_provider: "form" },
  ]);
  // Resend reads this when each client is constructed, which happens when the
  // app is imported below, so it must be set first.
  process.env.RESEND_BASE_URL = await startFakeResend();
  __setResponseFloorForTests(FLOOR_MS);
  ({ base, close } = await startApp(db));
});

after(async () => {
  await close();
  mail.closeAllConnections();
  await new Promise<void>((resolve) => mail.close(() => resolve()));
});

test("signup: the verification code is stored and accepted by Resend before the reply", async () => {
  const since = accepted.length;
  const r = await post("/api/auth/signup", {
    name: "New Founder",
    email: "New@X.test",
    password: "correct-horse-battery",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.requiresVerification, true);
  replies.set("/api/auth/signup", r.json);

  const email = emailTo("new@x.test", since);
  assert.ok(email, "no verification email reached Resend");
  assert.ok(email.acceptedAt <= r.repliedAt, "the reply came back before Resend accepted the email");
  assert.match(email.subject, /verify/i);

  const user = db.rows("users").find((u) => u.email === "new@x.test");
  assert.ok(user, "the account was not created");
  assert.ok(
    db.rows("email_verification_tokens").some((t) => String(t.user_id) === String(user.id)),
    "the code was not stored before the reply",
  );
});

test("signup again with an unverified address: a fresh code goes out before the reply", async () => {
  const since = accepted.length;
  const r = await post("/api/auth/signup", {
    name: "Pending Founder",
    email: "pending@x.test",
    password: "correct-horse-battery",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, replies.get("/api/auth/signup"));
  const email = emailTo("pending@x.test", since);
  assert.ok(email, "no verification email reached Resend");
  assert.ok(email.acceptedAt <= r.repliedAt, "the reply came back before Resend accepted the email");
});

test("resend-verification: the code is accepted by Resend before the reply", async () => {
  const since = accepted.length;
  const r = await post("/api/auth/resend-verification", { email: "Pending@X.test" });
  assert.equal(r.status, 200);
  replies.set("/api/auth/resend-verification", r.json);
  const email = emailTo("pending@x.test", since);
  assert.ok(email, "no verification email reached Resend");
  assert.ok(email.acceptedAt <= r.repliedAt, "the reply came back before Resend accepted the email");
});

test("forgot-password: the reset link is stored and accepted by Resend before the reply", async () => {
  const since = accepted.length;
  const r = await post("/api/auth/forgot-password", { email: "member@x.test" });
  assert.equal(r.status, 200);
  replies.set("/api/auth/forgot-password", r.json);
  const email = emailTo("member@x.test", since);
  assert.ok(email, "no reset email reached Resend");
  assert.ok(email.acceptedAt <= r.repliedAt, "the reply came back before Resend accepted the email");
  assert.match(email.subject, /reset/i);
  assert.equal(db.rows("password_resets").filter((p) => String(p.user_id) === "31").length, 1);
});

test("outcomes that send nothing get the same reply, no sooner than the floor", async () => {
  const since = accepted.length;
  const cases: [string, { email: string; [key: string]: unknown }][] = [
    ["/api/auth/signup", { name: "Member", email: "member@x.test", password: "correct-horse-battery" }],
    ["/api/auth/resend-verification", { email: "nobody@x.test" }],
    ["/api/auth/resend-verification", { email: "member@x.test" }],
    ["/api/auth/forgot-password", { email: "nobody@x.test" }],
    ["/api/auth/forgot-password", { email: "google@x.test" }],
  ];
  for (const [path, body] of cases) {
    const r = await post(path, body);
    assert.equal(r.status, 200, `${path} for ${body.email}`);
    assert.deepEqual(r.json, replies.get(path), `${path} for ${body.email} replied differently`);
    assert.ok(
      r.ms >= FLOOR_MS - TIMER_SLACK_MS,
      `${path} for ${body.email} replied in ${r.ms}ms, under the ${FLOOR_MS}ms floor`,
    );
  }
  assert.deepEqual(accepted.slice(since), [], "an email went out to an address that should get none");
});

test("forgot-password: a rejected email gets the same reply, and its link stops working", async () => {
  const r = await post("/api/auth/forgot-password", { email: "bounce@x.test" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, replies.get("/api/auth/forgot-password"));
  assert.equal(
    db.rows("password_resets").filter((p) => String(p.user_id) === "33").length,
    0,
    "the reset link stayed valid although its email never went out",
  );
});
