import "./helpers/testEnv.ts";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config/env.ts";
import { __setSupabaseForTests } from "../config/supabase.ts";
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, ACCESS_TOKEN_KIND } from "../utils/accessToken.ts";
import { entitlementsForPlan } from "../services/entitlementService.ts";
import { FakeSupabase } from "./helpers/fakeSupabase.ts";

/**
 * Live pitch actions require admission. verdict_request, prepare_evaluation,
 * end_session and set_video_url must not run unless client_ready passed every
 * gate, and an action racing a client_ready still in progress waits for it.
 * Scenarios follow the B1 regression tests on aws-prod-migration.
 */

const db = new FakeSupabase();
// The weekly quota is claimed through one database function. Answer it the way
// the migration does: count this user's starts in the last seven days.
(db as any).rpc = async (name: string, args: any) => {
  if (name !== "claim_weekly_session_slot") return { data: null, error: null };
  const windowStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const used = db
    .rows("session_starts")
    .filter((r) => r.user_id === args.p_user_id && Date.parse(r.started_at) > windowStart).length;
  if (used >= args.p_limit) {
    return { data: [{ allowed: false, used, remaining: 0, resets_at: null }], error: null };
  }
  db.rows("session_starts").push({ id: db.allocId(), user_id: args.p_user_id, started_at: new Date().toISOString() });
  return { data: [{ allowed: true, used: used + 1, remaining: args.p_limit - used - 1, resets_at: null }], error: null };
};

const FREE = {
  plan: "free",
  plan_expires_at: null,
  trial_started_at: "2026-01-01T00:00:00Z",
  trial_expires_at: "2026-01-31T00:00:00Z",
  trial_status: "expired",
  auth_version: 0,
};
const freeLimit = entitlementsForPlan("free", null, FREE.trial_expires_at, "expired", FREE.trial_started_at).maxWeeklySessions;
assert.ok(Number.isFinite(freeLimit) && freeLimit > 0, "the free plan has a weekly limit to exhaust");

const EXHAUSTED = { id: 61, email: "exhausted@x.test" };
const UNVERIFIED = { id: 62, email: "unverified@x.test" };
const LEGIT = { id: 64, email: "legit@x.test" };
const RACER = { id: 65, email: "racer@x.test" };
const DELETED_ID = 66;
const REVOKED = { id: 67, email: "revoked@x.test" };

const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
db.seed("users", [
  { ...EXHAUSTED, ...FREE, isEmailVerified: true },
  { ...UNVERIFIED, ...FREE, isEmailVerified: false },
  { ...LEGIT, ...FREE, isEmailVerified: true },
  { ...RACER, ...FREE, isEmailVerified: true },
  { ...REVOKED, ...FREE, isEmailVerified: true },
]);
db.seed(
  "session_starts",
  Array.from({ length: freeLimit }, (_, i) => ({ id: i + 1, user_id: EXHAUSTED.id, started_at: recent })),
);
db.seed("sessions", []);
db.seed("decks", []);
__setSupabaseForTests(db);

const rowsFor = (uid: number) => db.rows("sessions").filter((r) => r.user_id === uid).length;
const startsFor = (uid: number) => db.rows("session_starts").filter((r) => r.user_id === uid).length;

function tokenFor(id: number): string {
  return jwt.sign(
    { kind: ACCESS_TOKEN_KIND, id, accountType: "user", authVersion: 0 },
    config.jwtSecret,
    { algorithm: "HS256", issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE, expiresIn: "1h" },
  );
}

const { initRestSocket } = await import("../sockets/restSocket.ts");
const server = http.createServer();
const wss = new WebSocketServer({ server });
initRestSocket(wss);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

interface Conn {
  ws: WebSocket;
  messages: any[];
  closed: Promise<number>;
  send: (m: unknown) => void;
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
}

function connect(token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, ["pitchnest-v1", `pitchnest-auth.${token}`]);
    const messages: any[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch {}
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        messages,
        closed,
        send: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
        waitFor: (pred, ms = 15_000) =>
          new Promise((res, rej) => {
            const started = Date.now();
            const tick = () => {
              const hit = messages.find(pred);
              if (hit) return res(hit);
              if (Date.now() - started > ms) {
                return rej(new Error(`timed out; got ${JSON.stringify(messages.map((m) => m.code || m.type))}`));
              }
              setTimeout(tick, 25);
            };
            tick();
          }),
      }),
    );
  });
}

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
const FAKE_TRANSCRIPT = Array.from({ length: 30 }, (_, i) => ({
  type: "user",
  text: `We are building an AI platform for founders; segment ${i} covers market size, traction, revenue and our go-to-market plan in detail.`,
}));
const READY = { type: "client_ready", config: { businessName: "Admission Co", mode: "panel", duration: 10 } };
const END = { type: "end_session", transcript: FAKE_TRANSCRIPT, duration: 600 };
const BILLABLE = [
  { type: "prepare_evaluation", transcript: FAKE_TRANSCRIPT },
  { type: "verdict_request" },
  END,
  { type: "set_video_url", url: `pitches/${EXHAUSTED.id}/1700000000000_x.webm` },
];

try {
  // A verified founder cannot run billable actions without client_ready.
  {
    const c = await connect(tokenFor(EXHAUSTED.id));
    for (const m of BILLABLE) c.send(m);
    await settle();
    assert.ok(!c.messages.some((m) => m.type === "report"), "no report without admission");
    assert.equal(rowsFor(EXHAUSTED.id), 0, "no session row without admission");
    assert.equal(startsFor(EXHAUSTED.id), freeLimit, "quota ledger untouched");
    c.ws.terminate();
  }

  // A quota-refused client_ready does not admit actions racing behind it.
  {
    const c = await connect(tokenFor(EXHAUSTED.id));
    c.send(READY);
    for (const m of BILLABLE) c.send(m);
    assert.equal(await c.closed, 4005);
    await settle(500);
    assert.ok(c.messages.some((m) => m.code === "PLAN_QUOTA_EXCEEDED"));
    assert.ok(!c.messages.some((m) => m.type === "report"));
    assert.equal(rowsFor(EXHAUSTED.id), 0);
    assert.equal(startsFor(EXHAUSTED.id), freeLimit);
  }

  // Unverified founders are closed at connect, even with client_ready first.
  {
    const c = await connect(tokenFor(UNVERIFIED.id));
    for (const m of [READY, ...BILLABLE]) c.send(m);
    assert.equal(await c.closed, 4001);
    assert.ok(!c.messages.some((m) => m.type === "report"));
    assert.equal(rowsFor(UNVERIFIED.id), 0);
    assert.equal(startsFor(UNVERIFIED.id), 0);
  }

  // A token for a deleted user is closed at connect.
  {
    const c = await connect(tokenFor(DELETED_ID));
    c.send(END);
    assert.equal(await c.closed, 4001);
    assert.equal(rowsFor(DELETED_ID), 0);
  }

  // Lambda logout/reset increments the durable auth version in a different
  // process. An already-open Render socket must observe that change and close.
  {
    const c = await connect(tokenFor(REVOKED.id));
    await settle(250);
    const row = db.rows("users").find((user) => user.id === REVOKED.id);
    assert.ok(row, "revocation test user exists");
    row.auth_version += 1;
    const closeCode = await Promise.race([
      c.closed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("revoked socket stayed open")), 2_000),
      ),
    ]);
    assert.equal(closeCode, 4001);
  }

  // Positive control: an admitted founder gets exactly one report and one slot,
  // and a second end_session on the same admission is ignored.
  {
    const c = await connect(tokenFor(LEGIT.id));
    c.send(READY);
    await settle(1000);
    c.send(END);
    const report = await c.waitFor((m) => m.type === "report", 30_000);
    assert.ok(report.sessionId);
    c.send(END);
    await settle(800);
    assert.equal(c.messages.filter((m) => m.type === "report").length, 1);
    assert.equal(rowsFor(LEGIT.id), 1);
    assert.equal(startsFor(LEGIT.id), 1);
    c.ws.terminate();
  }

  // Legitimate race: end_session sent straight after client_ready waits for
  // admission instead of being dropped.
  {
    const c = await connect(tokenFor(RACER.id));
    c.send(READY);
    c.send(END);
    const report = await c.waitFor((m) => m.type === "report", 30_000);
    assert.ok(report.sessionId);
    assert.equal(rowsFor(RACER.id), 1);
    assert.equal(startsFor(RACER.id), 1, "exactly one slot claimed");
    c.ws.terminate();
  }
} finally {
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close();
}

console.log("WebSocket admission tests passed.");
// restSocket starts background timers on import; exit explicitly.
process.exit(0);
