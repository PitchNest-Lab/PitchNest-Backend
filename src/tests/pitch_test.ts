import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  decodePitchCursor,
  encodePitchCursor,
  getMemberPitch,
  PITCH_CONSENT_VERSION,
  publishPitch,
  requirePitchArena,
  savePitchDraft,
  toPitchSummary,
  toPublicPitch,
  validatePitchInput,
  withdrawPitch,
} from "../controllers/pitchController.ts";
import { createBusinessComment, createContentReport } from "../controllers/discoverEngagementController.ts";
import { restoreContent, toStaffReport } from "../controllers/moderationController.ts";
import { toNotificationView } from "../controllers/notificationController.ts";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "12121212-1212-4212-8212-121212121212";
const USER = { id: 7, email: "founder@example.com", accountType: "user" as const };
const MEMBERSHIP = { businessId: BUSINESS_ID, userId: 7, role: "owner", publicDisplayConsent: false };
const PITCH_BODY = "We help neighbourhood shops in Lagos restock overnight on credit, so they never lose a sale to an empty shelf.";

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
  return res as Response & { statusCode: number; body: any };
}

// ─── Validation ──────────────────────────────────────────────────────────────
assert.ok(validatePitchInput({ headline: "Hi", body: PITCH_BODY }).error, "headlines need 5+ characters");
assert.ok(validatePitchInput({ headline: "Restock overnight", body: "Too short to be a pitch." }).error);
assert.ok(validatePitchInput({ headline: "Restock overnight", body: "x".repeat(1501) }).error);
assert.ok(validatePitchInput({ headline: "Restock overnight", body: PITCH_BODY, feedbackAsk: "y".repeat(301) }).error);
assert.ok(
  validatePitchInput({ headline: "Restock overnight", body: `${PITCH_BODY} https://a.example https://b.example https://c.example` }).error,
  "at most two links",
);
const good = validatePitchInput({
  headline: "  Restock\n overnight  ",
  body: PITCH_BODY,
  feedbackAsk: "  Is the credit model believable?\n ",
});
assert.equal(good.error, undefined);
assert.equal(good.headline, "Restock overnight");
assert.equal(good.feedbackAsk, "Is the credit model believable?");
assert.equal(validatePitchInput({ headline: "Restock overnight", body: PITCH_BODY, feedbackAsk: "" }).feedbackAsk, null);

// ─── Public shapes never expose ids or approvers ─────────────────────────────
const publicPitch = toPublicPitch({
  pitch_id: DRAFT_ID,
  version: 2,
  headline: "Restock overnight",
  body: PITCH_BODY,
  feedback_ask: null,
  approved_at: "2026-10-15T10:00:00.000Z",
  feedback_count: "3",
  approved_by: 7,
  business_id: BUSINESS_ID,
});
assert.deepEqual(Object.keys(publicPitch), ["version", "headline", "body", "feedbackAsk", "publishedAt", "feedbackCount"]);
assert.equal(publicPitch.feedbackCount, 3);
assert.equal(JSON.stringify(publicPitch).includes(BUSINESS_ID), false);

const summary = toPitchSummary({
  pitch_id: DRAFT_ID,
  headline: "Restock overnight",
  excerpt: "We help...",
  approved_at: "2026-10-15T10:00:00.000Z",
  feedback_count: 1,
  business_slug: "market-bridge",
  business_name: "Market Bridge",
  business_tagline: "Trade rails",
  business_industry: "Commerce",
  business_region: "Lagos",
});
assert.equal(JSON.stringify(summary).includes(DRAFT_ID), false);
assert.equal(summary.business.slug, "market-bridge");
// Pitches from example businesses say so (migration 0034); without it, none are.
assert.equal(summary.business.isExample, false);
assert.equal(toPitchSummary({ business_slug: "x", business_is_example: true }).business.isExample, true);

const cursor = { at: "2026-10-15T10:00:00.000Z", id: DRAFT_ID };
assert.deepEqual(decodePitchCursor(encodePitchCursor(cursor)), cursor);
assert.equal(decodePitchCursor("tampered"), null);

// ─── Feature flag ────────────────────────────────────────────────────────────
const originalFlag = config.pitchArenaEnabled;
try {
  (config as any).pitchArenaEnabled = false;
  const off = recorder();
  requirePitchArena({} as Request, off, (() => assert.fail("must not continue")) as NextFunction);
  assert.equal(off.statusCode, 404);
} finally {
  (config as any).pitchArenaEnabled = originalFlag;
}

// ─── Lifecycle handlers ──────────────────────────────────────────────────────
const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalFrom = mutableSupabase.from;

try {
  const calls: Array<{ name: string; args: any }> = [];
  let rpcResult: { data: any; error: any } = {
    data: { id: DRAFT_ID, status: "draft", version: 0, headline: "Restock overnight", body: PITCH_BODY, feedback_ask: null, updated_at: "2026-10-15T10:00:00.123Z" },
    error: null,
  };
  mutableSupabase.rpc = async (name: string, args: any) => {
    calls.push({ name, args });
    return rpcResult;
  };

  const saved = recorder();
  await savePitchDraft(
    { body: { headline: "Restock overnight", body: PITCH_BODY, businessId: "other" }, user: USER, businessMembership: MEMBERSHIP } as unknown as Request,
    saved,
  );
  assert.equal(saved.statusCode, 200);
  assert.equal(calls.at(-1)?.args.p_business_id, BUSINESS_ID, "drafts belong to the membership's business");
  assert.equal(calls.at(-1)?.args.p_actor_id, 7);
  assert.equal(saved.body.data.updatedAt, "2026-10-15T10:00:00.123Z");

  const before = calls.length;
  for (const body of [
    {},
    { confirmed: true, consentVersion: PITCH_CONSENT_VERSION, draftId: DRAFT_ID },
    { confirmed: true, consentVersion: "old", draftId: DRAFT_ID, updatedAt: "2026-10-15T10:00:00.123Z" },
    { confirmed: false, consentVersion: PITCH_CONSENT_VERSION, draftId: DRAFT_ID, updatedAt: "2026-10-15T10:00:00.123Z" },
  ]) {
    const refused = recorder();
    await publishPitch({ body, user: USER, businessMembership: MEMBERSHIP } as unknown as Request, refused);
    assert.equal(refused.statusCode, 400, "publishing needs the previewed draft and explicit consent");
  }
  assert.equal(calls.length, before, "refused publishes never reach the database");

  const consented = { confirmed: true, consentVersion: PITCH_CONSENT_VERSION, draftId: DRAFT_ID, updatedAt: "2026-10-15T10:00:00.123Z" };
  rpcResult = { data: null, error: { code: "40001", message: "changed" } };
  const stale = recorder();
  await publishPitch({ body: consented, user: USER, businessMembership: MEMBERSHIP } as unknown as Request, stale);
  assert.equal(stale.statusCode, 409);

  rpcResult = { data: null, error: { code: "23514", message: "not published" } };
  const unpublishedBusiness = recorder();
  await publishPitch({ body: consented, user: USER, businessMembership: MEMBERSHIP } as unknown as Request, unpublishedBusiness);
  assert.equal(unpublishedBusiness.statusCode, 422);

  rpcResult = { data: { id: DRAFT_ID, status: "published", version: 1, headline: "Restock overnight", body: PITCH_BODY, updated_at: "2026-10-15T10:00:01Z", approved_at: "2026-10-15T10:00:01Z" }, error: null };
  const published = recorder();
  await publishPitch({ body: consented, user: USER, businessMembership: MEMBERSHIP } as unknown as Request, published);
  assert.equal(published.statusCode, 200);
  assert.equal(calls.at(-1)?.name, "publish_pitch");
  assert.equal(calls.at(-1)?.args.p_consent_version, PITCH_CONSENT_VERSION);

  // Member view: "hidden" reflects only the latest public version.
  let pitchRows: any[] = [];
  const memberQuery: any = {
    select: () => memberQuery,
    eq: () => memberQuery,
    in: () => memberQuery,
    order: () => memberQuery,
    limit: () => memberQuery,
    then: (resolve: (value: unknown) => unknown) => resolve({ data: pitchRows, error: null }),
  };
  mutableSupabase.from = () => memberQuery;
  const row = (status: string, updated: string) => ({ id: DRAFT_ID, status, version: 1, headline: "Restock overnight", body: PITCH_BODY, updated_at: updated });

  pitchRows = [row("hidden", "2026-10-15T12:00:00Z"), row("withdrawn", "2026-10-14T12:00:00Z")];
  const hiddenView = recorder();
  await getMemberPitch({ user: USER, businessMembership: MEMBERSHIP } as unknown as Request, hiddenView);
  assert.equal(hiddenView.body.data.hidden, true);

  pitchRows = [row("withdrawn", "2026-10-16T12:00:00Z"), row("hidden", "2026-10-15T12:00:00Z")];
  const laterWithdrawn = recorder();
  await getMemberPitch({ user: USER, businessMembership: MEMBERSHIP } as unknown as Request, laterWithdrawn);
  assert.equal(laterWithdrawn.body.data.hidden, false, "an old hidden version does not shadow newer ones");

  pitchRows = [row("draft", "2026-10-17T12:00:00Z"), row("published", "2026-10-16T12:00:00Z"), row("hidden", "2026-10-15T12:00:00Z")];
  const liveAgain = recorder();
  await getMemberPitch({ user: USER, businessMembership: MEMBERSHIP } as unknown as Request, liveAgain);
  assert.equal(liveAgain.body.data.hidden, false);
  assert.equal(liveAgain.body.data.published.status, "published");
  assert.equal(liveAgain.body.data.draft.status, "draft");
  mutableSupabase.from = originalFrom;

  rpcResult = { data: null, error: { code: "P0002", message: "none" } };
  const nothing = recorder();
  await withdrawPitch({ user: USER, businessMembership: MEMBERSHIP } as unknown as Request, nothing);
  assert.equal(nothing.statusCode, 404);

  // Comments: category validated; pitch feedback resolved in the database.
  const badCategory = recorder();
  await createBusinessComment(
    { params: { slug: "market-bridge" }, body: { body: "Interesting idea", category: "gossip" }, user: USER } as unknown as Request,
    badCategory,
  );
  assert.equal(badCategory.statusCode, 400);

  rpcResult = { data: null, error: { code: "23505", message: "dup" } };
  const plain = recorder();
  await createBusinessComment({ params: { slug: "market-bridge" }, body: { body: "Plain comment here" }, user: USER } as unknown as Request, plain);
  assert.equal("p_category" in calls.at(-1)!.args, false, "plain comments keep the original call shape");
  assert.equal("p_on_pitch" in calls.at(-1)!.args, false);

  const originalPitchFlag = config.pitchArenaEnabled;
  (config as any).pitchArenaEnabled = true;
  try {
    const feedback = recorder();
    await createBusinessComment(
      {
        params: { slug: "market-bridge" },
        body: { body: "What proves demand at this price?", category: "evidence", onPitch: true, pitchId: "forged" },
        user: USER,
      } as unknown as Request,
      feedback,
    );
    assert.equal(calls.at(-1)?.args.p_category, "evidence");
    assert.equal(calls.at(-1)?.args.p_on_pitch, true);
    assert.equal("p_pitch_id" in calls.at(-1)!.args, false, "the client never chooses the pitch");

    // Reports: the live pitch is resolved from the slug in the database.
    rpcResult = { data: [{ report_id: "r1", already_reported: false }], error: null };
    const pitchReport = recorder();
    await createContentReport(
      { body: { entityType: "pitch", slug: "market-bridge", reason: "misleading", entityId: "forged" }, user: USER } as unknown as Request,
      pitchReport,
    );
    assert.equal(pitchReport.statusCode, 201);
    assert.equal(calls.at(-1)?.name, "create_content_report");
    assert.equal(calls.at(-1)?.args.p_entity_type, "pitch");
    assert.equal(calls.at(-1)?.args.p_comment_id, null, "a pitch report carries no client-chosen id");

    rpcResult = { data: "x", error: null };
    const restore = recorder();
    await restoreContent({ body: { entityType: "pitch", entityId: DRAFT_ID }, user: USER } as unknown as Request, restore);
    assert.equal(restore.statusCode, 200);
    assert.equal(calls.at(-1)?.args.p_entity_type, "pitch");
  } finally {
    (config as any).pitchArenaEnabled = originalPitchFlag;
  }

  (config as any).pitchArenaEnabled = false;
  try {
    const beforeOff = calls.length;
    const offReport = recorder();
    await createContentReport(
      { body: { entityType: "pitch", slug: "market-bridge", reason: "spam" }, user: USER } as unknown as Request,
      offReport,
    );
    assert.equal(offReport.statusCode, 404, "pitch reports need Pitch Arena");
    assert.equal(calls.length, beforeOff);
  } finally {
    (config as any).pitchArenaEnabled = originalPitchFlag;
  }
} finally {
  mutableSupabase.rpc = originalRpc;
  mutableSupabase.from = originalFrom;
}

// ─── Notifications name pitch feedback ───────────────────────────────────────
const feedbackNote = toNotificationView({
  notification_id: "n1",
  type: "business_comment",
  created_at: "2026-10-15T10:00:00.000Z",
  business_id: BUSINESS_ID,
  business_name: "Market Bridge",
  business_slug: "market-bridge",
  comment_category: "evidence",
  excerpt: "What proves demand?",
});
assert.equal(feedbackNote?.title, "New pitch feedback on Market Bridge");
const questionNote = toNotificationView({ ...feedbackNote, notification_id: "n2", type: "business_comment", business_id: BUSINESS_ID, business_name: "Market Bridge", comment_category: "question" });
assert.equal(questionNote?.title, "New question on Market Bridge");

// ─── Moderation queue shows the reported pitch text ─────────────────────────
const pitchQueueItem = toStaffReport({
  report_id: "r1",
  entity_type: "pitch",
  entity_id: DRAFT_ID,
  reason: "misleading",
  report_status: "open",
  business_id: BUSINESS_ID,
  business_name: "Market Bridge",
  business_slug: "market-bridge",
  business_status: "published",
  pitch_headline: "Restock overnight",
  pitch_body: PITCH_BODY,
  pitch_status: "published",
  open_reports_for_entity: 2,
});
assert.deepEqual(pitchQueueItem.pitch, { headline: "Restock overnight", body: PITCH_BODY, status: "published" });
assert.equal(pitchQueueItem.comment, null);
assert.equal(pitchQueueItem.community, null);
assert.equal(toStaffReport({ entity_type: "comment", comment_body: "x" }).pitch, null);

// ─── Migration guards ────────────────────────────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0026_public_pitches.sql", import.meta.url), "utf8");
assert.match(migration, /Publish the business profile before its pitch/);
assert.match(migration, /Pitch changed after preview/);
assert.match(migration, /uq_public_pitches_one_draft/);
assert.match(migration, /uq_public_pitches_one_published/);
assert.match(migration, /resolve_public_business_id\(p_slug\)/, "public reads only see published businesses");
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0026'/);
assert.doesNotMatch(
  migration,
  /\b(FROM|JOIN)\s+(sessions|decks|deck_audits|session_pdfs|founder_profiles)\b|evaluation_report|video_url/i,
  "pitches never draw on practice data",
);
assert.match(migration, /'business', 'comment', 'thread', 'reply', 'pitch'/, "pitches are reportable");
assert.match(
  migration,
  /p_entity_type = 'pitch' THEN[\s\S]*?resolve_public_business_id\(p_slug\)[\s\S]*?status = 'published'/,
  "only the live pitch of a public business can be reported",
);
assert.match(migration, /target\.entity_type = 'pitch' THEN\s*UPDATE public_pitches\s*SET status = 'hidden'/);
assert.match(migration, /p_entity_type = 'pitch' THEN[\s\S]*?restored\.status = 'hidden'/, "restore only undoes a hide");
for (const name of [
  "save_pitch_draft",
  "publish_pitch",
  "withdraw_pitch",
  "get_public_pitch",
  "list_public_pitches",
  "create_content_report",
  "staff_list_reports",
  "staff_resolve_report",
  "staff_restore_content",
]) {
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
}

console.log("Pitch Arena tests passed.");
process.exit(0);
