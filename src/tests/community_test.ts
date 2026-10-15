import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  createReply,
  createThread,
  decodeCursor,
  encodeCursor,
  listThreads,
  removeOwnCommunityItem,
  reportCommunityItem,
  requireCommunity,
  toReply,
  toThreadDetail,
  toThreadSummary,
  validateReplyBody,
  validateThreadInput,
} from "../controllers/communityController.ts";
import { toNotificationView } from "../controllers/notificationController.ts";
import { toStaffReport } from "../controllers/moderationController.ts";
import { sanitizeSettings } from "../controllers/authController.ts";

const USER = { id: 7, email: "founder@example.com", accountType: "user" as const };
const THREAD_ID = "88888888-8888-4888-8888-888888888888";
const REPLY_ID = "99999999-9999-4999-8999-999999999999";

function queryStub(resolve: (calls: any[][]) => { data: any; error: any }) {
  const calls: any[][] = [];
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (onFulfilled: any, onRejected: any) =>
            Promise.resolve(resolve(calls)).then(onFulfilled, onRejected);
        }
        if (prop === "maybeSingle" || prop === "single") return async () => resolve(calls);
        return (...args: any[]) => {
          calls.push([String(prop), ...args]);
          return proxy;
        };
      },
    },
  );
  return { proxy, calls };
}

function recorder() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(field: string, value: string) {
      this.headers[field] = value;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
    send() {
      this.sent = true;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any; headers: Record<string, string> };
}

// ─── Validation ──────────────────────────────────────────────────────────────
assert.ok(validateThreadInput({ topic: "crypto-pump", title: "Hello there", body: "x".repeat(20) }).error);
assert.ok(validateThreadInput({ topic: "growth", title: "Hey", body: "x".repeat(20) }).error, "short titles are refused");
assert.ok(validateThreadInput({ topic: "growth", title: "t".repeat(141), body: "x".repeat(20) }).error);
assert.ok(validateThreadInput({ topic: "growth", title: "A fine title", body: "too short" }).error);
assert.ok(
  validateThreadInput({
    topic: "growth",
    title: "Links everywhere",
    body: "see https://a.example https://b.example https://c.example https://d.example",
  }).error,
);
const thread = validateThreadInput({
  topic: "pitching",
  title: "  How do you answer\n the TAM question?  ",
  body: "Investors keep challenging my market size. What worked for you?",
});
assert.equal(thread.error, undefined);
assert.equal(thread.title, "How do you answer the TAM question?", "titles collapse to one line");
assert.ok(validateReplyBody("x").error);
assert.equal(validateReplyBody("  Good question  ").body, "Good question");

// ─── Serializers never expose author ids ─────────────────────────────────────
const summaryRow = {
  thread_id: THREAD_ID,
  topic: "pitching",
  title: "How do you answer the TAM question?",
  excerpt: "Investors keep challenging my market size.",
  created_at: "2026-10-15T10:00:00.000Z",
  last_activity_at: "2026-10-15T11:00:00.000Z",
  reply_count: "3",
  author_id: 42,
  author_name: "  Kelvin O.  ",
  email: "must-not-leak@example.com",
};
const summary = toThreadSummary(summaryRow, null);
assert.deepEqual(Object.keys(summary), [
  "id", "topic", "title", "excerpt", "createdAt", "lastActivityAt", "replyCount", "author", "viewerIsAuthor",
]);
assert.equal(summary.replyCount, 3);
assert.equal(summary.author.name, "Kelvin O.");
assert.equal(summary.viewerIsAuthor, false);
assert.equal(JSON.stringify(summary).includes("42"), false);
assert.equal(JSON.stringify(summary).includes("must-not-leak"), false);
assert.equal(toThreadSummary(summaryRow, 42).viewerIsAuthor, true);
assert.equal(toThreadSummary({ ...summaryRow, topic: "nonsense" }, null).topic, "general");
assert.equal(toThreadDetail({ ...summaryRow, body: "Full", author_avatar_url: "javascript:x" }, null).author.avatarUrl, null);
assert.equal(toReply({ reply_id: REPLY_ID, body: "Hi", created_at: "bad", author_id: 7, author_name: null }, 7).author.name, "PitchNest member");

const cursor = { at: "2026-10-15T10:00:00.000Z", id: THREAD_ID };
assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
assert.equal(decodeCursor("tampered"), null);

// ─── Feature flag ────────────────────────────────────────────────────────────
const originalFlag = config.communityEnabled;
try {
  (config as any).communityEnabled = false;
  const off = recorder();
  requireCommunity({} as Request, off, (() => assert.fail("must not continue")) as NextFunction);
  assert.equal(off.statusCode, 404);
  (config as any).communityEnabled = true;
  let passed = false;
  requireCommunity({} as Request, recorder(), (() => { passed = true; }) as NextFunction);
  assert.equal(passed, true);
} finally {
  (config as any).communityEnabled = originalFlag;
}

// ─── Handlers ────────────────────────────────────────────────────────────────
const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalFrom = mutableSupabase.from;

try {
  const calls: Array<{ name: string; args: any }> = [];
  let rpcResult: { data: any; error: any } = { data: { id: THREAD_ID }, error: null };
  mutableSupabase.rpc = async (name: string, args: any) => {
    calls.push({ name, args });
    return rpcResult;
  };

  const created = recorder();
  await createThread(
    {
      body: { topic: "growth", title: "First ten customers?", body: "How did you find your first ten paying customers?", authorId: 999 },
      user: USER,
    } as unknown as Request,
    created,
  );
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.body, { data: { id: THREAD_ID } });
  assert.equal(calls.at(-1)?.name, "create_community_thread");
  assert.equal(calls.at(-1)?.args.p_author_id, 7, "threads belong to the signed-in user");

  rpcResult = { data: null, error: { code: "23505", message: "dup" } };
  const duplicate = recorder();
  await createThread(
    { body: { topic: "growth", title: "First ten customers?", body: "How did you find your first ten paying customers?" }, user: USER } as unknown as Request,
    duplicate,
  );
  assert.equal(duplicate.statusCode, 409);

  const before = calls.length;
  const badThread = recorder();
  await createReply({ params: { threadId: "nope" }, body: { body: "Hello" }, user: USER } as unknown as Request, badThread);
  assert.equal(badThread.statusCode, 404);
  assert.equal(calls.length, before, "malformed ids never reach the database");

  rpcResult = { data: null, error: { code: "P0002", message: "hidden" } };
  const hidden = recorder();
  await createReply({ params: { threadId: THREAD_ID }, body: { body: "Hello there" }, user: USER } as unknown as Request, hidden);
  assert.equal(hidden.statusCode, 404, "replies to hidden threads are refused");

  // Listing never leaks author ids, and personalised responses are not cached publicly.
  rpcResult = { data: [summaryRow], error: null };
  const listed = recorder();
  await listThreads({ query: { topic: "pitching" }, user: { ...USER, id: 42 } } as unknown as Request, listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.data[0].viewerIsAuthor, true);
  assert.equal(listed.headers["Cache-Control"], "private, no-store");
  assert.equal(JSON.stringify(listed.body).includes("author_id"), false);
  const badTopic = recorder();
  await listThreads({ query: { topic: "everything" } } as unknown as Request, badTopic);
  assert.equal(badTopic.statusCode, 400);

  // Reports
  const badType = recorder();
  await reportCommunityItem({ body: { entityType: "business", entityId: THREAD_ID, reason: "spam" }, user: USER } as unknown as Request, badType);
  assert.equal(badType.statusCode, 400);
  rpcResult = { data: [{ report_id: "r", already_reported: false }], error: null };
  const reported = recorder();
  await reportCommunityItem(
    { body: { entityType: "reply", entityId: REPLY_ID, reason: "harassment", reporterId: 999 }, user: USER } as unknown as Request,
    reported,
  );
  assert.equal(reported.statusCode, 201);
  assert.equal(calls.at(-1)?.name, "create_community_report");
  assert.equal(calls.at(-1)?.args.p_reporter_id, 7);

  // Authors remove only their own items.
  let removeCalls: any[][] = [];
  mutableSupabase.from = (table: string) => {
    assert.equal(table, "community_replies");
    return queryStub((callsSoFar) => {
      removeCalls = callsSoFar;
      return { data: null, error: null };
    }).proxy;
  };
  const notMine = recorder();
  await removeOwnCommunityItem("reply")({ params: { id: REPLY_ID }, user: USER } as unknown as Request, notMine);
  assert.equal(notMine.statusCode, 404);
  assert.ok(removeCalls.some(([op, column, value]) => op === "eq" && column === "author_id" && value === 7));
} finally {
  mutableSupabase.rpc = originalRpc;
  mutableSupabase.from = originalFrom;
}

// ─── Notifications, moderation view, settings ────────────────────────────────
const replyNote = toNotificationView({
  notification_id: "n1",
  type: "community_reply",
  created_at: "2026-10-15T10:00:00.000Z",
  read_at: null,
  business_id: null,
  thread_id: THREAD_ID,
  thread_title: "How do you answer the TAM question?",
  excerpt: "Bottom-up sizing worked for me.",
});
assert.equal(replyNote?.link, `/community/${THREAD_ID}#replies`);
assert.match(replyNote!.title, /How do you answer the TAM question\?/);
assert.equal(toNotificationView({ type: "community_reply", thread_id: null }), null);

const communityReport = toStaffReport({
  report_id: "r1",
  entity_type: "reply",
  entity_id: REPLY_ID,
  reason: "spam",
  report_status: "open",
  created_at: "2026-10-15T10:00:00.000Z",
  business_id: null,
  thread_id: THREAD_ID,
  thread_title: "How do you answer the TAM question?",
  community_body: "Buy followers at my site",
  community_status: "visible",
  open_reports_for_entity: 2,
});
assert.equal(communityReport.business, null);
assert.deepEqual(communityReport.community, {
  threadId: THREAD_ID,
  threadTitle: "How do you answer the TAM question?",
  body: "Buy followers at my site",
  status: "visible",
});

assert.equal(
  (sanitizeSettings({ notifications: { communityReplies: false } }).notifications as any).communityReplies,
  false,
);

// ─── Migration guards ────────────────────────────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0023_community.sql", import.meta.url), "utf8");
const functionNames = [...migration.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)\(/g)].map((m) => m[1]);
assert.ok(functionNames.length >= 10);
for (const name of functionNames) {
  assert.match(
    migration,
    new RegExp(`REVOKE ALL ON FUNCTION ${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`),
    `${name} must be revoked from public roles`,
  );
}
assert.match(migration, /notification_enabled\(recipient\.settings, 'communityReplies'\)/);
assert.match(migration, /thread\.author_id <> NEW\.author_id/, "authors are not notified of their own replies");
assert.match(migration, /content_reports_business_required/);
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0023'/);
assert.doesNotMatch(migration, /\bsessions\b|\bdecks\b|transcript|evaluation_report/i);

console.log("Community discussion tests passed.");
process.exit(0);
