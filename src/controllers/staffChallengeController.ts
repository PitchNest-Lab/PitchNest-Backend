import crypto from "node:crypto";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { MediaError, reencodeImage } from "../services/businessMediaService.ts";
import {
  DISCOUNT_COLUMNS,
  toStaffDiscount,
  validateDiscountInput,
  type DiscountCodeRow,
} from "../services/discountService.ts";
import {
  bannerUrl,
  businessSummaries,
  CHALLENGE_COLUMNS,
  CHALLENGE_STATUSES,
  challengePhase,
  CONFIRMATION_ITEMS,
  confirmationHash,
  confirmationStates,
  finalJudgingScore,
  isMissingRelation,
  isUuid,
  loadDiscountForChallenge,
  notifyChallenge,
  PARTICIPANT_COLUMNS,
  parseProfileScores,
  parseSocialChecks,
  profileRubricScore,
  readPrizes,
  recordAdminAudit,
  refreshChallengeScores,
  slugifyChallengeTitle,
  subscriptionStates,
  validateChallengeInput,
  type ChallengeStatus,
  type ConfirmationItem,
  type EntryStatus,
} from "../services/challengeService.ts";
import { evidenceObjectPath, loadPublicResults, toPublicChallenge } from "./challengeController.ts";

/**
 * Staff tools for hosted challenges and discount codes (migration 0038).
 * Mounted under /api/staff, behind authMiddleware + requireStaff, which
 * re-reads users.is_staff on every request. Every decision is written to
 * admin_audit_log with the staff member who made it.
 */

const noStore = (res: Response) => res.set("Cache-Control", "private, no-store");

async function loadChallengeById(id: string): Promise<any | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase.from("challenges").select(CHALLENGE_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
  return data ?? null;
}

async function requireChallenge(req: Request, res: Response): Promise<any | null> {
  const row = await loadChallengeById(String(req.params.id || ""));
  if (!row) {
    res.status(404).json({ error: "Challenge not found." });
    return null;
  }
  return row;
}

async function discountStats(codeIds: string[]): Promise<Map<string, { redeemed: number; pending: number }>> {
  const out = new Map<string, { redeemed: number; pending: number }>();
  if (codeIds.length === 0) return out;
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("discount_redemptions")
    .select("discount_code_id, status, created_at")
    .in("discount_code_id", codeIds);
  if (error) return out;
  for (const row of (data as any[] | null) ?? []) {
    const stats = out.get(row.discount_code_id) ?? { redeemed: 0, pending: 0 };
    if (row.status === "redeemed") stats.redeemed += 1;
    else if (row.status === "pending" && String(row.created_at) > since) stats.pending += 1;
    out.set(row.discount_code_id, stats);
  }
  return out;
}

function toStaffChallenge(row: any, extras: { discount: DiscountCodeRow | null; counts?: Record<string, number> }) {
  const prizes = readPrizes(row.prizes);
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title ?? ""),
    organizer: String(row.organizer ?? ""),
    tagline: String(row.tagline ?? ""),
    description: String(row.description ?? ""),
    region: String(row.region ?? ""),
    websiteUrl: row.website_url ?? "",
    imageUrl: bannerUrl(row),
    promoEnabled: row.promo_enabled !== false,
    prizeCurrency: String(row.prize_currency ?? "NGN"),
    prizes,
    startsAt: row.starts_at ?? null,
    submissionDeadline: row.submission_deadline ?? null,
    winnersAnnouncedOn: typeof row.winners_announced_on === "string" ? row.winners_announced_on.slice(0, 10) : null,
    eligibility: row.eligibility ?? "",
    requirements: row.requirements ?? "",
    judgingCriteria: row.judging_criteria ?? "",
    terms: row.terms ?? "",
    pitchWeight: Number(row.pitch_weight),
    eligibleSessionModes: Array.isArray(row.eligible_session_modes) ? row.eligible_session_modes : [],
    minCompletedSessions: Number(row.min_completed_sessions) || 1,
    requiredPlan: row.required_plan ?? null,
    socialHandles: row.social_handles && typeof row.social_handles === "object" ? row.social_handles : {},
    discountCodeId: row.discount_code_id ?? null,
    discount: extras.discount ? toStaffDiscount(extras.discount) : null,
    confirmations: confirmationStates(row, extras.discount),
    status: row.status as ChallengeStatus,
    phase: challengePhase(row),
    resultsPublishedAt: row.results_published_at ?? null,
    counts: extras.counts ?? {},
    updatedAt: row.updated_at ?? null,
  };
}

async function participantCounts(challengeIds: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (challengeIds.length === 0) return out;
  const { data, error } = await supabase
    .from("challenge_participants")
    .select("challenge_id, status")
    .in("challenge_id", challengeIds);
  if (error) return out;
  for (const row of (data as any[] | null) ?? []) {
    const counts = out.get(row.challenge_id) ?? { total: 0 };
    counts.total += 1;
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    out.set(row.challenge_id, counts);
  }
  return out;
}

// ─── Challenges ──────────────────────────────────────────────────────────────

export async function listStaffChallenges(_req: Request, res: Response) {
  try {
    const { data, error } = await supabase
      .from("challenges")
      .select(CHALLENGE_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      if (isMissingRelation(error)) return noStore(res).json({ data: [], setupRequired: true });
      throw error;
    }
    const rows = (data as any[] | null) ?? [];
    const counts = await participantCounts(rows.map((row) => row.id));
    const discounts = new Map<string, DiscountCodeRow>();
    const codeIds = [...new Set(rows.map((row) => row.discount_code_id).filter(isUuid))];
    if (codeIds.length) {
      const { data: codes } = await supabase.from("discount_codes").select(DISCOUNT_COLUMNS).in("id", codeIds);
      for (const code of (codes as DiscountCodeRow[] | null) ?? []) discounts.set(code.id, code);
    }
    return noStore(res).json({
      data: rows.map((row) => toStaffChallenge(row, { discount: discounts.get(row.discount_code_id) ?? null, counts: counts.get(row.id) })),
    });
  } catch (error) {
    console.error("Staff challenge list failed:", error);
    return res.status(500).json({ error: "Failed to load challenges." });
  }
}

export async function getStaffChallenge(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const discount = await loadDiscountForChallenge(row);
    const [counts, stats, results] = await Promise.all([
      participantCounts([row.id]),
      discount ? discountStats([discount.id]) : Promise.resolve(new Map()),
      loadPublicResults({ ...row, results_published_at: row.results_published_at ?? "preview" }),
    ]);
    const view = toStaffChallenge(row, { discount, counts: counts.get(row.id) });
    return noStore(res).json({
      data: {
        ...view,
        discount: discount ? toStaffDiscount(discount, stats.get(discount.id)) : null,
        winnersPreview: results ?? [],
      },
    });
  } catch (error) {
    console.error("Staff challenge read failed:", error);
    return res.status(500).json({ error: "Failed to load the challenge." });
  }
}

/** GET /api/staff/challenges/preview/:slug — the public page's data for any status, drafts included. */
export async function previewStaffChallenge(req: Request, res: Response) {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const { data, error } = await supabase.from("challenges").select(CHALLENGE_COLUMNS).eq("slug", slug).maybeSingle();
    if (error && !isMissingRelation(error)) throw error;
    if (!data) return res.status(404).json({ error: "Challenge not found." });
    const discount = await loadDiscountForChallenge(data);
    const counts = await participantCounts([(data as any).id]);
    const results = await loadPublicResults(data);
    return noStore(res).json({
      data: { ...toPublicChallenge(data, { discount, participantCount: counts.get((data as any).id)?.total ?? 0, results }), preview: true },
    });
  } catch (error) {
    console.error("Staff challenge preview failed:", error);
    return res.status(500).json({ error: "Failed to load the challenge." });
  }
}

async function uniqueChallengeSlug(base: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${crypto.randomBytes(2).toString("hex")}`;
    const candidate = `${base.slice(0, 75 - suffix.length)}${suffix}`;
    const { data, error } = await supabase.from("challenges").select("id").eq("slug", candidate).maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error("Unable to allocate a unique challenge URL.");
}

export async function createStaffChallenge(req: Request, res: Response) {
  const { values, errors } = validateChallengeInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  try {
    const slug = typeof values.slug === "string" ? values.slug : await uniqueChallengeSlug(slugifyChallengeTitle(String(values.title)));
    const { data, error } = await supabase
      .from("challenges")
      .insert({ ...values, slug, status: "draft", created_by: req.user!.id, updated_by: req.user!.id })
      .select(CHALLENGE_COLUMNS)
      .single();
    if (error || !data) {
      if (error?.code === "23505") return res.status(409).json({ error: "Another challenge already uses that address." });
      if (error?.code === "23503") return res.status(400).json({ error: "That discount code doesn't exist." });
      console.error("Challenge create failed:", error);
      return res.status(500).json({ error: "Failed to save the challenge." });
    }
    await recordAdminAudit({ actorId: req.user!.id, action: "challenge.created", subjectType: "challenge", subjectId: (data as any).id, challengeId: (data as any).id });
    return res.status(201).json({ data: toStaffChallenge(data, { discount: await loadDiscountForChallenge(data) }) });
  } catch (error) {
    console.error("Challenge create threw:", error);
    return res.status(500).json({ error: "Failed to save the challenge." });
  }
}

export async function updateStaffChallenge(req: Request, res: Response) {
  const { values, errors } = validateChallengeInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (!Object.keys(values).length) return res.status(400).json({ error: "Nothing to update." });
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    if ("slug" in values && values.slug !== row.slug && row.status !== "draft") {
      return res.status(409).json({ error: "The address can only change while the challenge is a draft." });
    }
    if (row.results_published_at && "prizes" in values) {
      return res.status(409).json({ error: "Unpublish the results before changing the prizes." });
    }
    const starts = String(values.starts_at ?? row.starts_at);
    const deadline = String(values.submission_deadline ?? row.submission_deadline);
    if (Date.parse(starts) >= Date.parse(deadline)) return res.status(400).json({ error: "The start must be before the deadline." });

    const { data, error } = await supabase
      .from("challenges")
      .update({ ...values, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      if (error?.code === "23505") return res.status(409).json({ error: "Another challenge already uses that address." });
      if (error?.code === "23503") return res.status(400).json({ error: "That discount code doesn't exist." });
      if (error?.code === "23514") return res.status(400).json({ error: "Check the dates, prizes and texts." });
      console.error("Challenge update failed:", error);
      return res.status(500).json({ error: "Failed to save the challenge." });
    }
    const changed = Object.keys(values).filter((key) => JSON.stringify((row as any)[key]) !== JSON.stringify((data as any)[key]));
    if (changed.length) {
      await recordAdminAudit({ actorId: req.user!.id, action: "challenge.updated", subjectType: "challenge", subjectId: row.id, challengeId: row.id, metadata: { fields: changed } });
    }
    return res.json({ data: toStaffChallenge(data, { discount: await loadDiscountForChallenge(data) }) });
  } catch (error) {
    console.error("Challenge update threw:", error);
    return res.status(500).json({ error: "Failed to save the challenge." });
  }
}

/** POST /api/staff/challenges/:id/confirm {item, confirmed} — an admin's sign-off on one part of the rules. */
export async function confirmStaffChallengeItem(req: Request, res: Response) {
  const item = req.body?.item as ConfirmationItem;
  if (!(CONFIRMATION_ITEMS as readonly string[]).includes(item)) {
    return res.status(400).json({ error: `item must be one of: ${CONFIRMATION_ITEMS.join(", ")}.` });
  }
  const confirmed = req.body?.confirmed !== false;
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const discount = await loadDiscountForChallenge(row);
    const confirmations = { ...(row.confirmations && typeof row.confirmations === "object" ? row.confirmations : {}) };
    if (confirmed) {
      confirmations[item] = { by: req.user!.id, at: new Date().toISOString(), hash: confirmationHash(item, row, discount) };
    } else {
      delete confirmations[item];
    }
    const { data, error } = await supabase
      .from("challenges")
      .update({ confirmations, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      console.error("Challenge confirmation failed:", error);
      return res.status(500).json({ error: "Failed to save the confirmation." });
    }
    await recordAdminAudit({
      actorId: req.user!.id,
      action: confirmed ? "challenge.confirmed" : "challenge.unconfirmed",
      subjectType: "challenge",
      subjectId: row.id,
      challengeId: row.id,
      metadata: { item },
    });
    return res.json({ data: toStaffChallenge(data, { discount }) });
  } catch (error) {
    console.error("Challenge confirmation threw:", error);
    return res.status(500).json({ error: "Failed to save the confirmation." });
  }
}

/**
 * POST /api/staff/challenges/:id/status {status}. Making a challenge public
 * (published or open) needs every part of the rules confirmed, unchanged since;
 * going back to draft is only possible before anyone has joined.
 */
export async function setStaffChallengeStatus(req: Request, res: Response) {
  const status = req.body?.status as ChallengeStatus;
  if (!(CHALLENGE_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${CHALLENGE_STATUSES.join(", ")}.` });
  }
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    if (row.status === status) return res.status(400).json({ error: "The challenge already has that status." });
    const discount = await loadDiscountForChallenge(row);
    if (status === "published" || status === "open") {
      const pending = confirmationStates(row, discount).filter((item) => !item.confirmed);
      if (pending.length) {
        return res.status(409).json({
          error: `Confirm these parts of the rules first: ${pending.map((item) => item.item).join(", ")}.`,
          pending: pending.map((item) => item.item),
        });
      }
      if (readPrizes(row.prizes).length === 0) return res.status(409).json({ error: "Add the prizes first." });
    }
    if (status === "open" && Date.parse(row.submission_deadline) <= Date.now()) {
      return res.status(409).json({ error: "The submission deadline has passed. Move it before opening the challenge." });
    }
    if (status === "draft") {
      const counts = await participantCounts([row.id]);
      if ((counts.get(row.id)?.total ?? 0) > 0) {
        return res.status(409).json({ error: "Founders have joined this challenge, so it can't go back to draft. Close or cancel it instead." });
      }
    }
    const { data, error } = await supabase
      .from("challenges")
      .update({ status, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", row.status)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      console.error("Challenge status change failed:", error);
      return res.status(error ? 500 : 409).json({ error: error ? "Failed to change the status." : "The challenge changed meanwhile. Reload and try again." });
    }
    await recordAdminAudit({
      actorId: req.user!.id,
      action: "challenge.status",
      subjectType: "challenge",
      subjectId: row.id,
      challengeId: row.id,
      metadata: { from: row.status, to: status },
    });
    return res.json({ data: toStaffChallenge(data, { discount }) });
  } catch (error) {
    console.error("Challenge status change threw:", error);
    return res.status(500).json({ error: "Failed to change the status." });
  }
}

function challengeImagePath(challengeId: string, file: string): string {
  return `challenge-media/${challengeId}/${file}`;
}

/**
 * PUT /api/staff/challenges/:id/image — the challenge poster. Decoded and
 * re-encoded as WebP with no metadata, kept whole (never cropped, at most
 * 1600 px a side), and stored in the public media bucket the site's image
 * policy already allows.
 */
export async function uploadStaffChallengeImage(req: Request, res: Response) {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: "Choose an image to upload." });
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    let buffer: Buffer;
    try {
      buffer = await reencodeImage(req.file.buffer, { width: 1600, height: 1600, fit: "inside", minWidth: 400, minHeight: 400 });
    } catch (error) {
      if (error instanceof MediaError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    const file = `banner-${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32)}.webp`;
    const { error: uploadError } = await supabase.storage
      .from(config.publicMediaBucket)
      .upload(challengeImagePath(row.id, file), buffer, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: true,
        duplex: "half",
      });
    if (uploadError) {
      console.error("Challenge image upload failed:", uploadError.message);
      return res.status(500).json({ error: "Failed to save the image." });
    }
    const { data, error } = await supabase
      .from("challenges")
      .update({ banner_file: file, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      console.error("Challenge image save failed:", error);
      return res.status(500).json({ error: "Failed to save the image." });
    }
    if (row.banner_file && row.banner_file !== file) {
      await supabase.storage.from(config.publicMediaBucket).remove([challengeImagePath(row.id, row.banner_file)]);
    }
    await recordAdminAudit({ actorId: req.user!.id, action: "challenge.image", subjectType: "challenge", subjectId: row.id, challengeId: row.id });
    return res.json({ data: toStaffChallenge(data, { discount: await loadDiscountForChallenge(data) }) });
  } catch (error) {
    console.error("Challenge image upload threw:", error);
    return res.status(500).json({ error: "Failed to save the image." });
  }
}

export async function removeStaffChallengeImage(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const { data, error } = await supabase
      .from("challenges")
      .update({ banner_file: null, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (error || !data) return res.status(500).json({ error: "Failed to remove the image." });
    if (row.banner_file) await supabase.storage.from(config.publicMediaBucket).remove([challengeImagePath(row.id, row.banner_file)]);
    await recordAdminAudit({ actorId: req.user!.id, action: "challenge.image_removed", subjectType: "challenge", subjectId: row.id, challengeId: row.id });
    return res.json({ data: toStaffChallenge(data, { discount: await loadDiscountForChallenge(data) }) });
  } catch (error) {
    console.error("Challenge image removal threw:", error);
    return res.status(500).json({ error: "Failed to remove the image." });
  }
}

// ─── Participants ────────────────────────────────────────────────────────────

/**
 * GET /api/staff/challenges/:id/participants — every entry with its verified
 * facts, refreshed now. Search, filters and sorting happen in the browser.
 */
export async function listStaffChallengeParticipants(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const scoresFresh = await refreshChallengeScores(row.id);
    const { data, error } = await supabase
      .from("challenge_participants")
      .select(PARTICIPANT_COLUMNS)
      .eq("challenge_id", row.id)
      .order("joined_at", { ascending: true })
      .limit(2000);
    if (error) throw error;
    const entries = (data as any[] | null) ?? [];
    const userIds = entries.map((e) => Number(e.user_id));
    const loadUsers = async () => {
      if (!userIds.length) return [] as any[];
      const { data: found, error: userError } = await supabase.from("users").select("id, name, email").in("id", userIds);
      if (userError) throw userError;
      return (found as any[] | null) ?? [];
    };
    const [users, subscriptions, businesses] = await Promise.all([
      loadUsers(),
      subscriptionStates(userIds, row.required_plan ?? null),
      businessSummaries(entries.map((e) => e.business_id)),
    ]);
    const userById = new Map(users.map((u) => [Number(u.id), u]));
    const minSessions = Number(row.min_completed_sessions) || 1;
    const pitchWeight = Number(row.pitch_weight);
    return noStore(res).json({
      scoresFresh,
      data: entries.map((entry) => {
        const user = userById.get(Number(entry.user_id));
        const business = entry.business_id ? businesses.get(entry.business_id) ?? null : null;
        const subscription = subscriptions.get(Number(entry.user_id))?.state ?? "missing";
        const profileScore = profileRubricScore(entry.profile_scores);
        const missing: string[] = [];
        if (subscription !== "verified" && subscription !== "not_required") missing.push("subscription");
        if (Number(entry.completed_sessions) < minSessions) missing.push("session");
        if (entry.best_score === null) missing.push("score");
        if (!business?.published || business.isExample || !business.complete) missing.push("business");
        if (!entry.social_post_url) missing.push("social post");
        return {
          id: entry.id,
          userId: entry.user_id,
          name: user?.name ?? "Deleted account",
          email: user?.email ?? "",
          joinedAt: entry.joined_at,
          status: entry.status as EntryStatus,
          subscription,
          completedSessions: Number(entry.completed_sessions) || 0,
          bestScore: entry.best_score ?? null,
          bestScoreAt: entry.best_score_at ?? null,
          pitchScoreValid: entry.pitch_score_valid !== false,
          business: business
            ? { id: business.id, name: business.name, slug: business.slug, published: business.published, complete: business.complete, percent: business.percent, isExample: business.isExample }
            : null,
          socialPlatform: entry.social_platform ?? null,
          socialPostUrl: entry.social_post_url ?? null,
          submittedAt: entry.submitted_at ?? null,
          eligible: missing.length === 0,
          missing,
          profileScore,
          finalScore: finalJudgingScore({ bestScore: entry.best_score ?? null, pitchScoreValid: entry.pitch_score_valid !== false, profileScore, pitchWeight }),
          shortlisted: entry.shortlisted === true,
          placement: entry.placement ?? null,
          reviewedAt: entry.reviewed_at ?? null,
          judgedAt: entry.judged_at ?? null,
        };
      }),
    });
  } catch (error) {
    console.error("Staff participant list failed:", error);
    return res.status(500).json({ error: "Failed to load participants." });
  }
}

async function loadParticipant(challengeId: string, participantId: string): Promise<any | null> {
  if (!isUuid(participantId)) return null;
  const { data, error } = await supabase
    .from("challenge_participants")
    .select(PARTICIPANT_COLUMNS)
    .eq("id", participantId)
    .eq("challenge_id", challengeId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** GET /api/staff/challenges/:id/participants/:pid — one complete submission. */
export async function getStaffChallengeParticipant(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    await refreshChallengeScores(row.id, String(req.params.pid));
    const entry = await loadParticipant(row.id, String(req.params.pid));
    if (!entry) return res.status(404).json({ error: "Entry not found." });
    const [{ data: user }, subscriptions, businesses, { data: sessions }, { data: audit }] = await Promise.all([
      supabase.from("users").select("id, name, email").eq("id", entry.user_id).maybeSingle(),
      subscriptionStates([Number(entry.user_id)], row.required_plan ?? null),
      businessSummaries([entry.business_id]),
      // Scores, dates and modes only: never transcripts or recordings.
      supabase
        .from("sessions")
        .select("id, created_at, mode, scores:evaluation_report->scores, evaluation_status:evaluation_report->>evaluationStatus")
        .eq("user_id", entry.user_id)
        .gt("created_at", new Date(Date.parse(row.starts_at) - 1).toISOString())
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("admin_audit_log")
        .select("id, actor_id, action, metadata, created_at")
        .eq("subject_type", "challenge_participant")
        .eq("subject_id", entry.id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    let evidenceUrl: string | null = null;
    if (entry.evidence_file) {
      const { data: signed } = await supabase.storage
        .from(config.storageBucket)
        .createSignedUrl(evidenceObjectPath(entry.id, entry.evidence_file), 15 * 60);
      evidenceUrl = signed?.signedUrl ?? null;
    }
    const business = entry.business_id ? businesses.get(entry.business_id) ?? null : null;
    const profileScore = profileRubricScore(entry.profile_scores);
    const deadline = Date.parse(row.submission_deadline);
    return noStore(res).json({
      data: {
        id: entry.id,
        name: (user as any)?.name ?? "Deleted account",
        email: (user as any)?.email ?? "",
        status: entry.status,
        joinedAt: entry.joined_at,
        submittedAt: entry.submitted_at,
        subscription: subscriptions.get(Number(entry.user_id)) ?? null,
        subscriptionVerifiedAt: entry.subscription_verified_at ?? null,
        bestScore: entry.best_score ?? null,
        bestScoreAt: entry.best_score_at ?? null,
        bestSessionId: entry.best_session_id ?? null,
        completedSessions: Number(entry.completed_sessions) || 0,
        scoreFrozenAt: entry.score_frozen_at ?? null,
        sessions: ((sessions as any[] | null) ?? []).map((s) => ({
          id: s.id,
          createdAt: s.created_at,
          mode: s.mode,
          status: s.evaluation_status ?? null,
          scores: s.scores && typeof s.scores === "object" ? s.scores : null,
          inWindow: Date.parse(s.created_at) <= deadline,
        })),
        business: business
          ? { ...business, profile: business.snapshot }
          : null,
        socialPlatform: entry.social_platform ?? null,
        socialPostUrl: entry.social_post_url ?? null,
        profileLinkConfirmed: entry.profile_link_confirmed === true,
        publicNameConsent: entry.public_name_consent === true,
        evidenceUrl,
        reviewNote: entry.review_note ?? "",
        socialChecks: entry.social_checks ?? {},
        reviewedAt: entry.reviewed_at ?? null,
        profileScores: entry.profile_scores ?? {},
        profileScore,
        pitchScoreValid: entry.pitch_score_valid !== false,
        finalScore: finalJudgingScore({ bestScore: entry.best_score ?? null, pitchScoreValid: entry.pitch_score_valid !== false, profileScore, pitchWeight: Number(row.pitch_weight) }),
        judgeNotes: entry.judge_notes ?? "",
        shortlisted: entry.shortlisted === true,
        placement: entry.placement ?? null,
        audit: (audit as any[] | null) ?? [],
      },
    });
  } catch (error) {
    console.error("Staff participant read failed:", error);
    return res.status(500).json({ error: "Failed to load the entry." });
  }
}

const REVIEW_ACTIONS = ["approve", "request_correction", "reject", "disqualify", "reopen"] as const;
type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * POST /api/staff/challenges/:id/participants/:pid/review
 * {action, note?, socialChecks?}. Corrections, rejections and
 * disqualifications need a written reason, which the founder sees.
 */
export async function reviewStaffChallengeParticipant(req: Request, res: Response) {
  const action = req.body?.action as ReviewAction;
  if (!(REVIEW_ACTIONS as readonly string[]).includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${REVIEW_ACTIONS.join(", ")}.` });
  }
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
  if ((action === "request_correction" || action === "reject" || action === "disqualify") && note.length < 5) {
    return res.status(400).json({ error: "Write the reason the founder will see (at least 5 characters)." });
  }
  const socialChecks = "socialChecks" in (req.body ?? {}) ? parseSocialChecks(req.body.socialChecks) : undefined;
  if (socialChecks === null) return res.status(400).json({ error: "socialChecks must be an object." });
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const entry = await loadParticipant(row.id, String(req.params.pid));
    if (!entry) return res.status(404).json({ error: "Entry not found." });
    if (entry.placement !== null && action !== "approve") {
      if (row.results_published_at) return res.status(409).json({ error: "This entry is a published winner. Unpublish the results first." });
    }
    if (action === "approve" && !entry.submitted_at) {
      return res.status(409).json({ error: "The founder hasn't submitted this entry yet." });
    }

    const next: EntryStatus =
      action === "approve" ? "approved"
      : action === "request_correction" ? "needs_correction"
      : action === "reject" ? "rejected"
      : action === "disqualify" ? "disqualified"
      : entry.submitted_at ? "submitted" : "in_progress";
    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status: next,
      review_note: action === "approve" || action === "reopen" ? (note || null) : note,
      reviewed_by: req.user!.id,
      reviewed_at: nowIso,
      updated_at: nowIso,
    };
    if (next !== "approved") patch.placement = null;
    if (socialChecks) patch.social_checks = socialChecks;
    const { data, error } = await supabase
      .from("challenge_participants")
      .update(patch)
      .eq("id", entry.id)
      .select(PARTICIPANT_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      console.error("Participant review failed:", error);
      return res.status(500).json({ error: "Failed to save the review." });
    }
    await recordAdminAudit({
      actorId: req.user!.id,
      action: `participant.${action}`,
      subjectType: "challenge_participant",
      subjectId: entry.id,
      challengeId: row.id,
      metadata: { from: entry.status, to: next, ...(note ? { note } : {}), ...(socialChecks ? { socialChecks } : {}) },
    });
    const notice =
      next === "approved" ? "challenge_approved"
      : next === "needs_correction" ? "challenge_correction"
      : next === "rejected" || next === "disqualified" ? "challenge_rejected"
      : null;
    if (notice && entry.status !== next) await notifyChallenge([Number(entry.user_id)], notice, row.id);
    return res.json({ data: { id: entry.id, status: next } });
  } catch (error) {
    console.error("Participant review threw:", error);
    return res.status(500).json({ error: "Failed to save the review." });
  }
}

/**
 * POST /api/staff/challenges/:id/participants/:pid/judging
 * {profileScores?, pitchScoreValid?, judgeNotes?, shortlisted?}
 */
export async function judgeStaffChallengeParticipant(req: Request, res: Response) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const patch: Record<string, unknown> = {};
  if ("profileScores" in body) {
    const parsed = parseProfileScores(body.profileScores);
    if (!parsed.scores) return res.status(400).json({ error: parsed.error });
    patch.profile_scores = parsed.scores;
  }
  if ("pitchScoreValid" in body) {
    if (typeof body.pitchScoreValid !== "boolean") return res.status(400).json({ error: "pitchScoreValid must be true or false." });
    patch.pitch_score_valid = body.pitchScoreValid;
  }
  if ("shortlisted" in body) {
    if (typeof body.shortlisted !== "boolean") return res.status(400).json({ error: "shortlisted must be true or false." });
    patch.shortlisted = body.shortlisted;
  }
  if ("judgeNotes" in body) {
    if (body.judgeNotes !== null && typeof body.judgeNotes !== "string") return res.status(400).json({ error: "judgeNotes must be text." });
    const notes = typeof body.judgeNotes === "string" ? body.judgeNotes.trim() : "";
    if (notes.length > 3000) return res.status(400).json({ error: "judgeNotes can be up to 3000 characters." });
    patch.judge_notes = notes || null;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update." });
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    if (row.results_published_at) return res.status(409).json({ error: "Results are published. Unpublish them before changing scores." });
    const entry = await loadParticipant(row.id, String(req.params.pid));
    if (!entry) return res.status(404).json({ error: "Entry not found." });
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("challenge_participants")
      .update({ ...patch, judged_by: req.user!.id, judged_at: nowIso, updated_at: nowIso })
      .eq("id", entry.id);
    if (error) {
      console.error("Participant judging failed:", error);
      return res.status(500).json({ error: "Failed to save the scores." });
    }
    await recordAdminAudit({
      actorId: req.user!.id,
      action: "participant.judged",
      subjectType: "challenge_participant",
      subjectId: entry.id,
      challengeId: row.id,
      metadata: { fields: Object.keys(patch), ...(patch.profile_scores ? { profileScores: patch.profile_scores } : {}), ...("pitch_score_valid" in patch ? { pitchScoreValid: patch.pitch_score_valid } : {}) },
    });
    const profileScore = profileRubricScore(patch.profile_scores ?? entry.profile_scores);
    const pitchScoreValid = "pitch_score_valid" in patch ? patch.pitch_score_valid === true : entry.pitch_score_valid !== false;
    return res.json({
      data: {
        id: entry.id,
        profileScore,
        finalScore: finalJudgingScore({ bestScore: entry.best_score ?? null, pitchScoreValid, profileScore, pitchWeight: Number(row.pitch_weight) }),
      },
    });
  } catch (error) {
    console.error("Participant judging threw:", error);
    return res.status(500).json({ error: "Failed to save the scores." });
  }
}

// ─── Winners and results ─────────────────────────────────────────────────────

const PLACEMENT_ERRORS: Record<string, string> = {
  DUPLICATE_PLACE: "Each place can have one winner.",
  DUPLICATE_WINNER: "One founder can't win two places.",
  WINNER_NOT_ELIGIBLE: "Only approved entries can win. Approve the entry first.",
  INVALID_PLACE: "Choose a place that has a prize.",
  INVALID_PLACEMENTS: "The winners list wasn't valid.",
  RESULTS_ALREADY_PUBLISHED: "Results are published. Unpublish them before changing the winners.",
};

/** PUT /api/staff/challenges/:id/winners {placements: [{participantId, place}]} */
export async function setStaffChallengeWinners(req: Request, res: Response) {
  const placements = req.body?.placements;
  if (!Array.isArray(placements) || placements.length > 10) {
    return res.status(400).json({ error: "placements must list up to 10 winners." });
  }
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const { data, error } = await supabase.rpc("set_challenge_placements", {
      p_challenge_id: row.id,
      p_actor_id: req.user!.id,
      p_placements: placements.map((item: any) => ({ participantId: String(item?.participantId ?? ""), place: Number(item?.place) })),
    });
    if (error) {
      const key = Object.keys(PLACEMENT_ERRORS).find((code) => String(error.message || "").includes(code));
      if (key) return res.status(409).json({ error: PLACEMENT_ERRORS[key] });
      console.error("Winner selection failed:", error);
      return res.status(500).json({ error: "Failed to save the winners." });
    }
    const results = await loadPublicResults({ ...row, results_published_at: "preview" });
    return res.json({ data: { placed: Number(data) || 0, winnersPreview: results ?? [] } });
  } catch (error) {
    console.error("Winner selection threw:", error);
    return res.status(500).json({ error: "Failed to save the winners." });
  }
}

/** POST /api/staff/challenges/:id/results/publish — every prize place must have a winner. */
export async function publishStaffChallengeResults(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    if (row.results_published_at) return res.status(409).json({ error: "Results are already published." });
    const prizes = readPrizes(row.prizes);
    const { data: winners, error } = await supabase
      .from("challenge_participants")
      .select("id, user_id, placement, status")
      .eq("challenge_id", row.id)
      .gt("placement", 0);
    if (error) throw error;
    const placed = ((winners as any[] | null) ?? []).filter((w) => w.status === "approved");
    const missing = prizes.filter((prize) => !placed.some((w) => w.placement === prize.place)).map((prize) => prize.place);
    if (missing.length) {
      return res.status(409).json({ error: `Choose a winner for every prize place first (missing: ${missing.join(", ")}).` });
    }
    const nowIso = new Date().toISOString();
    const { data, error: updateError } = await supabase
      .from("challenges")
      .update({ results_published_at: nowIso, updated_by: req.user!.id, updated_at: nowIso })
      .eq("id", row.id)
      .is("results_published_at", null)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (updateError || !data) {
      console.error("Publishing results failed:", updateError);
      return res.status(500).json({ error: "Failed to publish the results." });
    }
    await recordAdminAudit({
      actorId: req.user!.id,
      action: "challenge.results_published",
      subjectType: "challenge",
      subjectId: row.id,
      challengeId: row.id,
      metadata: { winners: placed.map((w) => ({ participantId: w.id, place: w.placement })) },
    });
    const { data: everyone } = await supabase.from("challenge_participants").select("user_id").eq("challenge_id", row.id);
    await notifyChallenge(((everyone as any[] | null) ?? []).map((p) => Number(p.user_id)), "challenge_results", row.id);
    return res.json({ data: toStaffChallenge(data, { discount: await loadDiscountForChallenge(data) }) });
  } catch (error) {
    console.error("Publishing results threw:", error);
    return res.status(500).json({ error: "Failed to publish the results." });
  }
}

export async function unpublishStaffChallengeResults(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    if (!row.results_published_at) return res.status(409).json({ error: "Results aren't published." });
    const { data, error } = await supabase
      .from("challenges")
      .update({ results_published_at: null, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select(CHALLENGE_COLUMNS)
      .maybeSingle();
    if (error || !data) return res.status(500).json({ error: "Failed to unpublish the results." });
    await recordAdminAudit({ actorId: req.user!.id, action: "challenge.results_unpublished", subjectType: "challenge", subjectId: row.id, challengeId: row.id });
    return res.json({ data: toStaffChallenge(data, { discount: await loadDiscountForChallenge(data) }) });
  } catch (error) {
    console.error("Unpublishing results threw:", error);
    return res.status(500).json({ error: "Failed to unpublish the results." });
  }
}

/** GET /api/staff/challenges/:id/audit — the decision trail, newest first. */
export async function listStaffChallengeAudit(req: Request, res: Response) {
  try {
    const row = await requireChallenge(req, res);
    if (!row) return;
    const { data, error } = await supabase
      .from("admin_audit_log")
      .select("id, actor_id, action, subject_type, subject_id, metadata, created_at")
      .eq("challenge_id", row.id)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    const rows = (data as any[] | null) ?? [];
    const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((id) => Number.isInteger(id)))];
    const { data: actors } = actorIds.length
      ? await supabase.from("users").select("id, name").in("id", actorIds)
      : { data: [] as any[] };
    const names = new Map(((actors as any[] | null) ?? []).map((a) => [a.id, a.name]));
    return noStore(res).json({
      data: rows.map((r) => ({
        id: r.id,
        actor: names.get(r.actor_id) ?? "Staff",
        action: r.action,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        metadata: r.metadata ?? {},
        createdAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error("Challenge audit read failed:", error);
    return res.status(500).json({ error: "Failed to load the activity." });
  }
}

// ─── Discount codes ──────────────────────────────────────────────────────────

export async function listStaffDiscounts(_req: Request, res: Response) {
  try {
    const { data, error } = await supabase.from("discount_codes").select(DISCOUNT_COLUMNS).order("created_at", { ascending: false }).limit(100);
    if (error) {
      if (isMissingRelation(error)) return noStore(res).json({ data: [] });
      throw error;
    }
    const rows = (data as DiscountCodeRow[] | null) ?? [];
    const stats = await discountStats(rows.map((row) => row.id));
    return noStore(res).json({ data: rows.map((row) => toStaffDiscount(row, stats.get(row.id))) });
  } catch (error) {
    console.error("Staff discount list failed:", error);
    return res.status(500).json({ error: "Failed to load discount codes." });
  }
}

export async function createStaffDiscount(req: Request, res: Response) {
  const { values, errors } = validateDiscountInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  try {
    const { data, error } = await supabase
      .from("discount_codes")
      .insert({ ...values, active: values.active === true, created_by: req.user!.id, updated_by: req.user!.id })
      .select(DISCOUNT_COLUMNS)
      .single();
    if (error || !data) {
      if (error?.code === "23505") return res.status(409).json({ error: "That code already exists." });
      console.error("Discount create failed:", error);
      return res.status(500).json({ error: "Failed to save the code." });
    }
    await recordAdminAudit({ actorId: req.user!.id, action: "discount.created", subjectType: "discount_code", subjectId: (data as any).id, metadata: { code: (data as any).code } });
    return res.status(201).json({ data: toStaffDiscount(data as DiscountCodeRow) });
  } catch (error) {
    console.error("Discount create threw:", error);
    return res.status(500).json({ error: "Failed to save the code." });
  }
}

export async function updateStaffDiscount(req: Request, res: Response) {
  const id = String(req.params.id || "");
  if (!isUuid(id)) return res.status(404).json({ error: "Discount code not found." });
  const { values, errors } = validateDiscountInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (!Object.keys(values).length) return res.status(400).json({ error: "Nothing to update." });
  try {
    const { data: before, error: readError } = await supabase.from("discount_codes").select(DISCOUNT_COLUMNS).eq("id", id).maybeSingle();
    if (readError) throw readError;
    if (!before) return res.status(404).json({ error: "Discount code not found." });
    const starts = values.starts_at !== undefined ? values.starts_at : (before as any).starts_at;
    const ends = values.ends_at !== undefined ? values.ends_at : (before as any).ends_at;
    if (starts && ends && Date.parse(String(starts)) >= Date.parse(String(ends))) {
      return res.status(400).json({ error: "The start must be before the end." });
    }
    const { data, error } = await supabase
      .from("discount_codes")
      .update({ ...values, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(DISCOUNT_COLUMNS)
      .maybeSingle();
    if (error || !data) {
      if (error?.code === "23505") return res.status(409).json({ error: "That code already exists." });
      console.error("Discount update failed:", error);
      return res.status(500).json({ error: "Failed to save the code." });
    }
    const changed = Object.keys(values).filter((key) => JSON.stringify((before as any)[key]) !== JSON.stringify((data as any)[key]));
    await recordAdminAudit({
      actorId: req.user!.id,
      action: "active" in values && changed.includes("active") ? (values.active ? "discount.activated" : "discount.deactivated") : "discount.updated",
      subjectType: "discount_code",
      subjectId: id,
      metadata: { code: (data as any).code, fields: changed },
    });
    const stats = await discountStats([id]);
    return res.json({ data: toStaffDiscount(data as DiscountCodeRow, stats.get(id)) });
  } catch (error) {
    console.error("Discount update threw:", error);
    return res.status(500).json({ error: "Failed to save the code." });
  }
}
