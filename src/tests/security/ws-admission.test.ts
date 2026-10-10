import "../helpers/testEnv.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";
import { TEST_JWT_SECRET } from "../helpers/testEnv.ts";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { __setSupabaseForTests } from "../../config/supabase.ts";
import { signUserToken } from "../../services/tokenService.ts";

/**
 * B1 — Live Pitch actions must require server-side admission.
 *
 * Before the fix, verdict_request / prepare_evaluation / end_session were
 * processed without client_ready, so any token could obtain an AI evaluation
 * and a saved session row while skipping the quota/attempt claims, the
 * email-verification check and the token↔email binding.
 */

const db = new FakeSupabase();
let server: Server;
let wss: WebSocketServer;
let url = "";

const FREE = {
  plan: "free",
  plan_expires_at: null,
  trial_started_at: "2026-01-01T00:00:00Z",
  trial_expires_at: "2026-01-31T00:00:00Z",
  trial_status: "expired",
};
const EXHAUSTED = { id: 61, email: "exhausted@x.test" };
const UNVERIFIED = { id: 62, email: "unverified@x.test" };
const COLLIDER = { id: 63, email: "founder63@x.test" };
const LEGIT = { id: 64, email: "legit@x.test" };
const RACER = { id: 65, email: "racer@x.test" };
const DELETED_ID = 66;

// A transcript long enough that, if evaluation ran, it would not be skipped
// as "insufficient" — so a missing report proves the gate, not the heuristic.
const FAKE_TRANSCRIPT = Array.from({ length: 30 }, (_, i) => ({
  type: "user",
  text: `We are building an AI platform for founders; segment ${i} covers market size, traction, revenue and our go-to-market plan in detail.`,
}));

const rowsFor = (uid: number) => db.rows("sessions").filter((r) => r.user_id === uid).length;
const startsFor = (uid: number) => db.rows("session_starts").filter((r) => r.user_id === uid).length;

before(async () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.seed("users", [
    { ...EXHAUSTED, ...FREE, isEmailVerified: true },
    { ...UNVERIFIED, ...FREE, isEmailVerified: false },
    { ...COLLIDER, ...FREE, isEmailVerified: true },
    { ...LEGIT, ...FREE, isEmailVerified: true },
    { ...RACER, ...FREE, isEmailVerified: true },
  ]);
  db.seed("session_starts", [
    { id: 1, user_id: EXHAUSTED.id, started_at: recent },
    { id: 2, user_id: EXHAUSTED.id, started_at: recent },
  ]);
  db.seed("sessions", []);
  db.seed("decks", []);
  __setSupabaseForTests(db);
  const { initRestSocket } = await import("../../sockets/restSocket.ts");
  server = createServer();
  wss = new WebSocketServer({ server });
  initRestSocket(wss);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

interface Conn {
  ws: WebSocket;
  messages: any[];
  closed: Promise<number>;
  isClosed: () => boolean;
  send: (m: unknown) => void;
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
}

function connect(token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    const messages: any[] = [];
    let closed = false;
    const closedP = new Promise<number>((r) => ws.on("close", (code) => ((closed = true), r(code))));
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
        closed: closedP,
        isClosed: () => closed,
        send: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
        waitFor: (pred, ms = 15000) =>
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
const READY = { type: "client_ready", config: { businessName: "B1 Co", mode: "panel", duration: 10 } };
const END = { type: "end_session", transcript: FAKE_TRANSCRIPT, duration: 600 };
const BILLABLE = [
  { type: "prepare_evaluation", transcript: FAKE_TRANSCRIPT },
  { type: "verdict_request" },
  END,
  { type: "set_video_url", url: "pitches/61/1700000000000_x.webm" },
];

test("B1: a verified founder cannot run billable actions without client_ready", async () => {
  const c = await connect(signUserToken(EXHAUSTED));
  for (const m of BILLABLE) c.send(m);
  await settle();
  assert.ok(!c.messages.some((m) => m.type === "report"), "no report without admission");
  assert.ok(!c.messages.some((m) => m.type === "turn_complete" || m.type === "verdict_complete"), "no verdict turn without admission");
  assert.equal(rowsFor(EXHAUSTED.id), 0, "no session row without admission");
  assert.equal(startsFor(EXHAUSTED.id), 2, "quota ledger untouched");
  c.ws.terminate();
});

test("B1: a quota-refused client_ready does not admit actions racing behind it", async () => {
  const c = await connect(signUserToken(EXHAUSTED));
  // Back-to-back: end_session arrives while client_ready is still running.
  c.send(READY);
  for (const m of BILLABLE) c.send(m);
  assert.equal(await c.closed, 4005);
  await settle(500);
  assert.ok(c.messages.some((m) => m.code === "PLAN_QUOTA_EXCEEDED"));
  assert.ok(!c.messages.some((m) => m.type === "report"));
  assert.equal(rowsFor(EXHAUSTED.id), 0);
  assert.equal(startsFor(EXHAUSTED.id), 2);
});

test("B1: unverified founders are closed at connect, before any action", async () => {
  const c = await connect(signUserToken(UNVERIFIED));
  for (const m of [READY, ...BILLABLE]) c.send(m);
  assert.equal(await c.closed, 4001);
  assert.ok(c.messages.some((m) => m.code === "EMAIL_NOT_VERIFIED"));
  assert.ok(!c.messages.some((m) => m.type === "report"));
  assert.equal(rowsFor(UNVERIFIED.id), 0);
  assert.equal(startsFor(UNVERIFIED.id), 0);
});

test("B1: a legacy org token colliding with a founder id is closed at connect", async () => {
  const legacyOrg = jwt.sign({ id: COLLIDER.id, email: "org-contact@x.test" }, TEST_JWT_SECRET!);
  const c = await connect(legacyOrg);
  for (const m of BILLABLE) c.send(m);
  assert.equal(await c.closed, 4001);
  assert.ok(c.messages.some((m) => m.code === "USER_DELETED"));
  assert.equal(rowsFor(COLLIDER.id), 0, "nothing written into the founder's account");
  assert.equal(startsFor(COLLIDER.id), 0);
});

test("B1: a token for a deleted user is closed at connect", async () => {
  const c = await connect(signUserToken({ id: DELETED_ID, email: "gone@x.test" }));
  c.send(END);
  assert.equal(await c.closed, 4001);
  assert.equal(rowsFor(DELETED_ID), 0);
});

test("B1 positive control: an admitted founder gets exactly one report and one quota slot", async () => {
  const c = await connect(signUserToken(LEGIT));
  c.send(READY);
  await c.waitFor((m) => m.type === "session_grant");
  c.send(END);
  const report = await c.waitFor((m) => m.type === "report", 30000);
  assert.ok(report.sessionId);
  // A second end_session on the same admission is ignored.
  c.send(END);
  await settle(800);
  assert.equal(c.messages.filter((m) => m.type === "report").length, 1);
  assert.equal(rowsFor(LEGIT.id), 1);
  assert.equal(startsFor(LEGIT.id), 1);
  c.ws.terminate();
});

test("B1 legitimate race: end_session sent immediately after client_ready waits for admission, not dropped", async () => {
  const c = await connect(signUserToken(RACER));
  c.send(READY);
  c.send(END); // arrives while client_ready is still claiming quota
  const report = await c.waitFor((m) => m.type === "report", 30000);
  assert.ok(report.sessionId);
  assert.equal(rowsFor(RACER.id), 1);
  assert.equal(startsFor(RACER.id), 1, "exactly one slot claimed");
  c.ws.terminate();
});
