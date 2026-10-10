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
import { signOrgToken, signUserToken } from "../../services/tokenService.ts";

/**
 * End-to-end over a real WebSocket against the real restSocket handler, with
 * Supabase faked and no AI/speech provider configured (so no external calls).
 */

const db = new FakeSupabase();
let server: Server;
let wss: WebSocketServer;
let url = "";

const FREE_USER_ROW = {
  isEmailVerified: true,
  plan: "free",
  plan_expires_at: null,
  trial_started_at: "2026-01-01T00:00:00Z",
  trial_expires_at: "2026-01-31T00:00:00Z",
  trial_status: "expired",
};
const EXHAUSTED = { id: 41, email: "exhausted@x.test" };
const FRESH = { id: 42, email: "fresh@x.test" };
const COLLIDER = { id: 43, email: "founder43@x.test" };

const startsFor = (uid: number) => db.rows("session_starts").filter((r) => r.user_id === uid).length;

before(async () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.seed("users", [
    { ...EXHAUSTED, ...FREE_USER_ROW },
    { ...FRESH, ...FREE_USER_ROW },
    { ...COLLIDER, ...FREE_USER_ROW },
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
  closed: Promise<{ code: number }>;
  waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
  send: (m: unknown) => void;
}

function connect(token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    const messages: any[] = [];
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    let closeInfo: { code: number } | null = null;
    const closed = new Promise<{ code: number }>((r) =>
      ws.on("close", (code) => {
        closeInfo = { code };
        r(closeInfo);
      }),
    );
    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return; // binary audio
      }
      messages.push(m);
      for (const w of [...waiters]) if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    });
    ws.on("error", reject);
    const conn: Conn = {
      ws,
      messages,
      closed,
      send: (m) => ws.send(JSON.stringify(m)),
      waitFor: (pred, ms = 15000) => {
        const hit = messages.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timed out; got ${JSON.stringify(messages.map((x) => x.type))}${closeInfo ? ` closed ${closeInfo.code}` : ""}`)), ms);
          waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
        });
      },
    };
    ws.on("open", () => resolve(conn));
  });
}

/** Fails (instead of hanging) when the server never closes the socket. */
function closedWithin(c: Conn, ms = 10000): Promise<{ code: number }> {
  return Promise.race([
    c.closed,
    new Promise<never>((_, rej) =>
      setTimeout(() => {
        c.ws.terminate();
        rej(new Error(`socket was not closed by the server within ${ms}ms`));
      }, ms),
    ),
  ]);
}

const READY = (extra: Record<string, unknown> = {}) => ({
  type: "client_ready",
  config: { businessName: "Test Co", mode: "panel", duration: 10, industry: "SaaS" },
  ...extra,
});
const setupDone = (m: any) => m.type === "time_sync";

async function closeAndWait(c: Conn) {
  c.ws.close();
  await closedWithin(c);
  await new Promise((r) => setTimeout(r, 50));
}

// ── Principal checks on the socket ─────────────────────────────────────────

test("WS: organization tokens cannot open a Live Pitch socket", async () => {
  const c = await connect(signOrgToken({ id: 43, orgCode: 1111, email: "org@x.test" }));
  const { code } = await closedWithin(c);
  assert.equal(code, 4001);
});

test("WS: a legacy org token colliding with a founder id is refused at client_ready", async () => {
  const legacyOrg = jwt.sign({ id: COLLIDER.id, email: "org-contact@x.test" }, TEST_JWT_SECRET!);
  const c = await connect(legacyOrg);
  c.send(READY());
  // (An AI_NOT_CONFIGURED notice is sent on connect in this test env; match the code.)
  const err = await c.waitFor((m) => m.type === "error" && m.code === "USER_DELETED");
  assert.ok(err);
  await closedWithin(c);
  assert.equal(startsFor(COLLIDER.id), 0, "no quota may be claimed for the collided founder");
});

// ── H5: resume quota bypass ────────────────────────────────────────────────

test("H5: a quota-exhausted free user is refused — with or without resume: true", async () => {
  for (const extra of [
    {},
    { resume: true, transcript: [], timeLeftSeconds: 600 },
    {
      resume: true,
      transcript: [],
      timeLeftSeconds: 600,
      resumeToken: jwt.sign({ typ: "resume", sid: "x", uid: EXHAUSTED.id, att: null, min: 40, dl: Date.now() + 3.6e6 }, "attacker"),
    },
  ]) {
    const c = await connect(signUserToken(EXHAUSTED));
    c.send(READY(extra));
    const err = await c.waitFor((m) => m.type === "error" && m.code === "PLAN_QUOTA_EXCEEDED");
    assert.ok(err, `extra=${JSON.stringify(Object.keys(extra))}`);
    const { code } = await closedWithin(c);
    assert.equal(code, 4005);
  }
  assert.equal(startsFor(EXHAUSTED.id), 2, "refused claims must not leave rows behind");
});

test("H5: legitimate reconnects resume without spending quota; an ended session cannot be resumed", async () => {
  const token = signUserToken(FRESH);

  // 1. Fresh admission: one quota slot, and a resume grant is issued.
  const first = await connect(token);
  first.send(READY());
  const grant = await first.waitFor((m) => m.type === "session_grant");
  assert.equal(typeof grant.resumeToken, "string");
  await first.waitFor(setupDone);
  assert.equal(startsFor(FRESH.id), 1);
  await closeAndWait(first);

  // 2. Page refresh with today's client (resume: true, no token) → same admission.
  const second = await connect(token);
  second.send(READY({ resume: true, transcript: [], timeLeftSeconds: 590 }));
  await second.waitFor(setupDone);
  assert.ok(!second.messages.some((m) => m.type === "session_grant"), "resume must not mint a new admission");
  assert.equal(startsFor(FRESH.id), 1, "reconnect must not consume quota");
  await closeAndWait(second);

  // 3. Reconnect presenting the signed resume token → same admission.
  const third = await connect(token);
  third.send(READY({ resume: true, transcript: [], timeLeftSeconds: 580, resumeToken: grant.resumeToken }));
  await third.waitFor(setupDone);
  assert.equal(startsFor(FRESH.id), 1);

  // H6 over the socket: a foreign recording key is refused, an owned one is kept.
  third.send({ type: "set_video_url", url: "decks/1700000000000_victim_deck.pdf" });
  const bad = await third.waitFor((m) => m.type === "error" && m.code === "INVALID_RECORDING");
  assert.ok(bad);
  const ownKey = `pitches/${FRESH.id}/1700000000000_pitch.webm`;
  third.send({ type: "set_video_url", url: ownKey });

  // 4. End the session: exactly one session row, carrying only the owned key.
  third.send({ type: "end_session", transcript: [], duration: 30 });
  const report = await third.waitFor((m) => m.type === "report", 30000);
  assert.ok(report.sessionId);
  const rows = db.rows("sessions").filter((r) => r.user_id === FRESH.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].video_url, ownKey);
  await closeAndWait(third);

  // 5. "Resuming" the ended session is a NEW admission and pays the claims.
  const fourth = await connect(token);
  fourth.send(READY({ resume: true, transcript: [], timeLeftSeconds: 500, resumeToken: grant.resumeToken }));
  await fourth.waitFor((m) => m.type === "session_grant");
  await fourth.waitFor(setupDone);
  assert.equal(startsFor(FRESH.id), 2, "resuming an ended session must consume a new slot");
  await closeAndWait(fourth);

  // 6. Free weekly cap (2) now reached: resume flag cannot bypass it.
  const fifth = await connect(token);
  fifth.send(READY({ resume: true, transcript: [], timeLeftSeconds: 500 }));
  // Registry still holds admission #4 (un-ended) → this is a legitimate resume of it.
  await fifth.waitFor(setupDone);
  assert.equal(startsFor(FRESH.id), 2);
  fifth.send({ type: "end_session", transcript: [], duration: 10 });
  await fifth.waitFor((m) => m.type === "report", 30000);
  await closeAndWait(fifth);

  const sixth = await connect(token);
  sixth.send(READY({ resume: true, transcript: [], timeLeftSeconds: 500 }));
  const err = await sixth.waitFor((m) => m.type === "error" && m.code === "PLAN_QUOTA_EXCEEDED");
  assert.ok(err);
  assert.equal((await closedWithin(sixth)).code, 4005);
  assert.equal(startsFor(FRESH.id), 2);
});
