import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER, ACCESS_TOKEN_KIND } from "../utils/accessToken.ts";
import { supabase } from "../config/supabase.ts";
import {
  createBusinessComment,
  createContentReport,
  decodeCommentCursor,
  encodeCommentCursor,
  listBusinessComments,
  normalizeCommentBody,
  normalizeReportDetails,
  normalizeSlug,
  requireDiscoverEngagement,
  setBusinessEngagement,
  stripInvisible,
  toPublicComment,
  toPublicEngagement,
} from "../controllers/discoverEngagementController.ts";
import { resolveReport, toStaffReport } from "../controllers/moderationController.ts";
import { optionalUserAuth, requireStaff } from "../middleware/authMiddleware.ts";

type RecordedResponse = Response & {
  statusCode: number;
  body?: any;
  headers: Record<string, string>;
  sent?: boolean;
};

function responseRecorder(): RecordedResponse {
  const response: Partial<RecordedResponse> = {
    statusCode: 200,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this as RecordedResponse;
    },
    set(field: string | Record<string, string>, value?: string | string[]) {
      if (typeof field === "string" && value !== undefined) {
        this.headers![field] = Array.isArray(value) ? value.join(", ") : value;
      } else if (field && typeof field === "object") {
        Object.assign(this.headers!, field);
      }
      return this as RecordedResponse;
    },
    json(body: any) {
      this.body = body;
      return this as RecordedResponse;
    },
    send() {
      this.sent = true;
      return this as RecordedResponse;
    },
  };
  return response as RecordedResponse;
}

const USER = { id: 7, email: "founder@example.com", accountType: "user" as const };
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

// ─── Comment normalization ───────────────────────────────────────────────────
const zeroWidth = String.fromCodePoint(0x200b);
const bidiOverride = String.fromCodePoint(0x202e);
const lineSeparator = String.fromCodePoint(0x2028);

assert.equal(stripInvisible(`a${zeroWidth}b${bidiOverride}c${lineSeparator}d`), "abcd");
assert.equal(stripInvisible("tab\tand\nnewline survive"), "tab\tand\nnewline survive");

const clean = normalizeCommentBody(`  What proves buyers will pay?${zeroWidth}\r\n\r\n\r\n\r\nThanks  `);
assert.equal(clean.error, undefined);
assert.equal(clean.body, "What proves buyers will pay?\n\nThanks");

assert.ok(normalizeCommentBody("x").error);
assert.ok(normalizeCommentBody(`${zeroWidth}${zeroWidth} `).error, "invisible-only text is empty");
assert.ok(normalizeCommentBody("y".repeat(1001)).error);
assert.equal(normalizeCommentBody("y".repeat(1000)).error, undefined);
assert.ok(normalizeCommentBody(42).error);
assert.ok(
  normalizeCommentBody("see https://a.example and http://b.example and www.c.example").error,
  "more than two links is rejected",
);
assert.equal(normalizeCommentBody("see https://a.example and www.b.example").error, undefined);

assert.deepEqual(normalizeReportDetails(undefined), { details: null });
assert.deepEqual(normalizeReportDetails("   "), { details: null });
assert.ok(normalizeReportDetails("z".repeat(1001)).error);

assert.equal(normalizeSlug("  Market-Bridge "), "market-bridge");
assert.equal(normalizeSlug("../etc/passwd"), null);
assert.equal(normalizeSlug(undefined), null);

// ─── Serializers never leak identities ───────────────────────────────────────
const commentRow = {
  comment_id: COMMENT_ID,
  comment_business_id: BUSINESS_ID,
  body: "Great idea",
  created_at: "2026-10-14T10:00:00.000Z",
  author_id: 99,
  author_name: "  Ada  ",
  author_avatar_url: "javascript:alert(1)",
  author_is_member: true,
  email: "must-not-leak@example.com",
};
const anonymousView = toPublicComment(commentRow, { userId: null, canModerate: false });
assert.deepEqual(Object.keys(anonymousView), [
  "id",
  "body",
  "createdAt",
  "author",
  "viewerCanRemove",
  "category",
  "onPitch",
]);
assert.equal(anonymousView.category, null);
assert.equal(anonymousView.onPitch, false);
assert.equal(toPublicComment({ ...commentRow, category: "evidence", on_pitch: true }, { userId: null, canModerate: false }).category, "evidence");
assert.equal(toPublicComment({ ...commentRow, category: "gossip" }, { userId: null, canModerate: false }).category, null);
assert.deepEqual(Object.keys(anonymousView.author), ["name", "avatarUrl", "isBusinessMember"]);
assert.equal(anonymousView.author.name, "Ada");
assert.equal(anonymousView.author.avatarUrl, null, "non-http avatar URLs are dropped");
assert.equal(anonymousView.viewerCanRemove, false);
assert.equal(JSON.stringify(anonymousView).includes("99"), false, "author id never serialized");
assert.equal(JSON.stringify(anonymousView).includes("must-not-leak"), false);
assert.equal(toPublicComment(commentRow, { userId: 99, canModerate: false }).viewerCanRemove, true);
assert.equal(toPublicComment(commentRow, { userId: 5, canModerate: true }).viewerCanRemove, true);
assert.equal(toPublicComment({ ...commentRow, author_name: null }, { userId: null, canModerate: false }).author.name, "PitchNest member");
assert.equal(toPublicComment({ ...commentRow, created_at: "garbage" }, { userId: null, canModerate: false }).createdAt, "");

const engagementRow = {
  engaged_business_id: BUSINESS_ID,
  support_count: "12",
  follower_count: 3,
  comment_count: null,
  viewer_supports: true,
  viewer_follows: false,
  viewer_is_member: false,
};
assert.deepEqual(toPublicEngagement(engagementRow, false), {
  supportCount: 12,
  followerCount: 3,
  commentCount: 0,
  viewer: null,
});
assert.deepEqual(toPublicEngagement(engagementRow, true).viewer, {
  supports: true,
  follows: false,
  isMember: false,
});

const cursor = { createdAt: "2026-10-14T10:00:00.000Z", commentId: COMMENT_ID };
assert.deepEqual(decodeCommentCursor(encodeCommentCursor(cursor)), cursor);
assert.equal(decodeCommentCursor("tampered"), null);

// ─── Feature flag gate ───────────────────────────────────────────────────────
const originalFlag = config.discoverEngagementEnabled;
try {
  (config as any).discoverEngagementEnabled = false;
  const off = responseRecorder();
  requireDiscoverEngagement({} as Request, off, (() => assert.fail("must not continue")) as NextFunction);
  assert.equal(off.statusCode, 404);

  (config as any).discoverEngagementEnabled = true;
  let passed = false;
  requireDiscoverEngagement({} as Request, responseRecorder(), (() => { passed = true; }) as NextFunction);
  assert.equal(passed, true);
} finally {
  (config as any).discoverEngagementEnabled = originalFlag;
}

// ─── Handlers use the authenticated user, never body-supplied ids ───────────
const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalFrom = mutableSupabase.from;

try {
  const calls: Array<{ name: string; args: any }> = [];
  let rpcResult: { data: any; error: any } = { data: [{ total_count: 5 }], error: null };
  mutableSupabase.rpc = async (name: string, args: any) => {
    calls.push({ name, args });
    return rpcResult;
  };

  const supportResponse = responseRecorder();
  await setBusinessEngagement("support", true)(
    {
      params: { slug: "Market-Bridge" },
      body: { userId: 999 },
      user: USER,
    } as unknown as Request,
    supportResponse,
  );
  assert.equal(supportResponse.statusCode, 200);
  assert.deepEqual(supportResponse.body, { data: { active: true, count: 5 } });
  assert.equal(calls.at(-1)?.name, "set_business_engagement");
  assert.deepEqual(calls.at(-1)?.args, {
    p_slug: "market-bridge",
    p_user_id: 7,
    p_kind: "support",
    p_active: true,
  });

  rpcResult = { data: null, error: { code: "42501", message: "member" } };
  const selfSupport = responseRecorder();
  await setBusinessEngagement("follow", true)(
    { params: { slug: "market-bridge" }, user: USER } as unknown as Request,
    selfSupport,
  );
  assert.equal(selfSupport.statusCode, 403);

  rpcResult = { data: null, error: { code: "P0002", message: "missing" } };
  const missing = responseRecorder();
  await setBusinessEngagement("support", false)(
    { params: { slug: "private-draft" }, user: USER } as unknown as Request,
    missing,
  );
  assert.equal(missing.statusCode, 404);

  const callCountBeforeInvalid = calls.length;
  const badSlug = responseRecorder();
  await setBusinessEngagement("support", true)(
    { params: { slug: "../../admin" }, user: USER } as unknown as Request,
    badSlug,
  );
  assert.equal(badSlug.statusCode, 404);
  assert.equal(calls.length, callCountBeforeInvalid, "malformed slugs never reach the database");

  // Comment validation happens before the database.
  const tooShort = responseRecorder();
  await createBusinessComment(
    { params: { slug: "market-bridge" }, body: { body: "x" }, user: USER } as unknown as Request,
    tooShort,
  );
  assert.equal(tooShort.statusCode, 400);
  assert.equal(calls.length, callCountBeforeInvalid);

  rpcResult = { data: null, error: { code: "23505", message: "dup" } };
  const duplicate = responseRecorder();
  await createBusinessComment(
    {
      params: { slug: "market-bridge" },
      body: { body: "What proves demand?", authorId: 999 },
      user: USER,
    } as unknown as Request,
    duplicate,
  );
  assert.equal(duplicate.statusCode, 409);
  assert.equal(calls.at(-1)?.args.p_author_id, 7);

  // Reports
  const badReason = responseRecorder();
  await createContentReport(
    { body: { entityType: "business", slug: "market-bridge", reason: "boring" }, user: USER } as unknown as Request,
    badReason,
  );
  assert.equal(badReason.statusCode, 400);

  const badComment = responseRecorder();
  await createContentReport(
    {
      body: { entityType: "comment", slug: "market-bridge", commentId: "1 OR 1=1", reason: "spam" },
      user: USER,
    } as unknown as Request,
    badComment,
  );
  assert.equal(badComment.statusCode, 404);

  rpcResult = { data: [{ report_id: "r", already_reported: true }], error: null };
  const report = responseRecorder();
  await createContentReport(
    {
      body: {
        entityType: "comment",
        slug: "market-bridge",
        commentId: COMMENT_ID,
        reason: "spam",
        details: "  repeated links  ",
        reporterId: 999,
      },
      user: USER,
    } as unknown as Request,
    report,
  );
  assert.equal(report.statusCode, 201);
  assert.deepEqual(report.body, { data: { received: true, alreadyReported: true } });
  assert.equal(calls.at(-1)?.args.p_reporter_id, 7);
  assert.equal(calls.at(-1)?.args.p_details, "repeated links");
  assert.equal("report_id" in report.body.data, false, "report ids are not returned");

  // Comment list: author ids are dropped, owner/admin may moderate.
  rpcResult = { data: [commentRow], error: null };
  mutableSupabase.from = (table: string) => {
    assert.equal(table, "business_members");
    const query: any = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { role: "owner" }, error: null }),
    };
    return query;
  };
  const listing = responseRecorder();
  await listBusinessComments(
    { params: { slug: "market-bridge" }, query: {}, user: { ...USER, id: 5 } } as unknown as Request,
    listing,
  );
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.body.data[0].viewerCanRemove, true);
  assert.equal(listing.headers["Cache-Control"], "private, no-store");
  assert.equal(JSON.stringify(listing.body).includes("author_id"), false);

  const anonymousListing = responseRecorder();
  await listBusinessComments(
    { params: { slug: "market-bridge" }, query: {} } as unknown as Request,
    anonymousListing,
  );
  assert.equal(anonymousListing.body.data[0].viewerCanRemove, false);
  assert.match(anonymousListing.headers["Cache-Control"], /^public/);

  // Moderation
  const badAction = responseRecorder();
  await resolveReport(
    { params: { reportId: COMMENT_ID }, body: { action: "delete-everything" }, user: USER } as unknown as Request,
    badAction,
  );
  assert.equal(badAction.statusCode, 400);

  rpcResult = { data: null, error: { code: "55000", message: "resolved" } };
  const alreadyResolved = responseRecorder();
  await resolveReport(
    { params: { reportId: COMMENT_ID }, body: { action: "dismiss" }, user: USER } as unknown as Request,
    alreadyResolved,
  );
  assert.equal(alreadyResolved.statusCode, 409);
  assert.equal(calls.at(-1)?.args.p_actor_id, 7);
} finally {
  mutableSupabase.rpc = originalRpc;
  mutableSupabase.from = originalFrom;
}

const staffView = toStaffReport({
  report_id: "r1",
  entity_type: "business",
  entity_id: BUSINESS_ID,
  reason: "misleading",
  details: null,
  report_status: "open",
  created_at: "2026-10-14T10:00:00.000Z",
  resolved_at: null,
  resolution_note: null,
  business_id: BUSINESS_ID,
  business_name: "Market Bridge",
  business_slug: "market-bridge",
  business_status: "published",
  comment_body: null,
  comment_status: null,
  open_reports_for_entity: "2",
  reporter_id: 55,
});
assert.equal(staffView.comment, null);
assert.equal(staffView.openReportsForEntity, 2);
assert.equal(JSON.stringify(staffView).includes("55"), false, "reporter identity is not exposed");

// ─── Staff gate and optional auth ────────────────────────────────────────────
try {
  let isStaff: boolean | null = false;
  mutableSupabase.from = (table: string) => {
    assert.equal(table, "users");
    const query: any = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data: isStaff === null ? null : { is_staff: isStaff, id: 7, email: USER.email, isEmailVerified: true },
        error: null,
      }),
    };
    return query;
  };

  const denied = responseRecorder();
  await requireStaff({ user: USER } as unknown as Request, denied, (() => assert.fail("not staff")) as NextFunction);
  assert.equal(denied.statusCode, 404);

  const orgDenied = responseRecorder();
  await requireStaff(
    { user: { ...USER, accountType: "organization" } } as unknown as Request,
    orgDenied,
    (() => assert.fail("org tokens are never staff")) as NextFunction,
  );
  assert.equal(orgDenied.statusCode, 404);

  isStaff = true;
  let staffPassed = false;
  await requireStaff({ user: USER } as unknown as Request, responseRecorder(), (() => { staffPassed = true; }) as NextFunction);
  assert.equal(staffPassed, true);

  // optionalUserAuth never rejects and never trusts organization tokens.
  const anonymous: any = { headers: {} };
  let continued = 0;
  await optionalUserAuth(anonymous, responseRecorder(), (() => { continued += 1; }) as NextFunction);
  assert.equal(anonymous.user, undefined);

  const garbage: any = { headers: { authorization: "Bearer not-a-jwt" } };
  await optionalUserAuth(garbage, responseRecorder(), (() => { continued += 1; }) as NextFunction);
  assert.equal(garbage.user, undefined);

  const tokenOptions = { algorithm: "HS256" as const, issuer: ACCESS_TOKEN_ISSUER, audience: ACCESS_TOKEN_AUDIENCE };
  const orgToken = jwt.sign({ kind: ACCESS_TOKEN_KIND, id: 7, accountType: "organization" }, config.jwtSecret, tokenOptions);
  const org: any = { headers: { authorization: `Bearer ${orgToken}` } };
  await optionalUserAuth(org, responseRecorder(), (() => { continued += 1; }) as NextFunction);
  assert.equal(org.user, undefined);

  const userToken = jwt.sign({ kind: ACCESS_TOKEN_KIND, id: 7, accountType: "user" }, config.jwtSecret, tokenOptions);
  const signedIn: any = { headers: { authorization: `Bearer ${userToken}` } };
  await optionalUserAuth(signedIn, responseRecorder(), (() => { continued += 1; }) as NextFunction);
  assert.equal(signedIn.user?.id, 7);
  assert.equal(continued, 4);
} finally {
  mutableSupabase.from = originalFrom;
}

// ─── Migration guards ────────────────────────────────────────────────────────
const migration = readFileSync(
  new URL("../../migrations/0021_discover_engagement.sql", import.meta.url),
  "utf8",
);
const functionNames = [...migration.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
assert.ok(functionNames.length >= 10);
for (const name of functionNames) {
  assert.match(
    migration,
    new RegExp(`REVOKE ALL ON FUNCTION ${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`),
    `${name} must be revoked from public roles`,
  );
}
assert.match(migration, /resolve_public_business_id/);
assert.match(migration, /Members cannot support or follow their own business/);
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0021'/);
assert.doesNotMatch(migration, /\bsessions\b|\bdecks\b|transcript|evaluation_report/i);

console.log("Discover engagement, moderation and optional-auth tests passed.");
