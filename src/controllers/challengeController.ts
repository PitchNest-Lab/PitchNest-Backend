import crypto from "node:crypto";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { MediaError, reencodeImage } from "../services/businessMediaService.ts";
import { countOf, toPublicDiscount, type DiscountCodeRow } from "../services/discountService.ts";
import { renderChallengeShareDocument, type ChallengeShare } from "../utils/publicChallengeMetadata.ts";
import { publicSiteOrigin } from "./publicBusinessController.ts";
import {
  bannerUrl,
  businessesForChallenge,
  CHALLENGE_COLUMNS,
  challengePhase,
  checkChallengeSubscription,
  entryEditable,
  isChallengeSlug,
  isMissingRelation,
  isSocialPlatform,
  isUuid,
  loadDiscountForChallenge,
  notifyChallenge,
  PARTICIPANT_COLUMNS,
  PLATFORM_COLLABORATION,
  PLATFORM_LABELS,
  prizePool,
  readPrizes,
  readSocialHandles,
  refreshChallengeScores,
  shareImageUrl,
  validateSocialPostUrl,
  type ChallengePhase,
  type EligibleBusiness,
  type EntryStatus,
  type SubscriptionCheck,
} from "../services/challengeService.ts";

/**
 * The public challenge page and a founder's own entry (migration 0037).
 *
 * Public reads project field by field (see routes/publicRoutes.ts). Entry
 * routes act only on the signed-in founder's own row: the challenge comes from
 * the URL, the founder from the token, never from the body.
 */

// ─── Loading ─────────────────────────────────────────────────────────────────

/** A challenge the public may see (anything but a draft), or null. */
export async function loadListedChallenge(slug: string): Promise<any | null> {
  if (!isChallengeSlug(slug)) return null;
  const { data, error } = await supabase
    .from("challenges")
    .select(CHALLENGE_COLUMNS)
    .eq("slug", slug)
    .neq("status", "draft")
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
  return data ?? null;
}

async function participantCount(challengeId: string): Promise<number> {
  const result = await supabase
    .from("challenge_participants")
    .select("id", { count: "exact", head: true })
    .eq("challenge_id", challengeId);
  if (result.error) return 0;
  return countOf(result as { count?: number | null; data?: unknown });
}

export interface PublicResult {
  place: number;
  prize: number;
  businessName: string;
  businessSlug: string | null;
  founderName: string | null;
}

/**
 * Published winners only: place, prize, the business's public name and link,
 * and the founder's name only if they agreed to it. Nothing else about an entry.
 */
export async function loadPublicResults(row: any): Promise<PublicResult[] | null> {
  if (!row?.results_published_at) return null;
  const { data: winners, error } = await supabase
    .from("challenge_participants")
    .select("placement, business_id, user_id, public_name_consent")
    .eq("challenge_id", row.id)
    .gt("placement", 0);
  if (error) throw error;
  const placed = ((winners as any[] | null) ?? []).filter((w) => Number.isInteger(w.placement));
  if (placed.length === 0) return [];

  const businessIds = placed.map((w) => w.business_id).filter(isUuid);
  const consenting = placed.filter((w) => w.public_name_consent === true).map((w) => w.user_id);
  const [businesses, publications, users] = await Promise.all([
    businessIds.length
      ? supabase.from("businesses").select("id, slug, name, status").in("id", businessIds)
      : Promise.resolve({ data: [], error: null }),
    businessIds.length
      ? supabase.from("business_publications").select("business_id, public_snapshot").in("business_id", businessIds).eq("status", "active")
      : Promise.resolve({ data: [], error: null }),
    consenting.length
      ? supabase.from("users").select("id, name").in("id", consenting)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const businessById = new Map(((businesses.data as any[] | null) ?? []).map((b) => [b.id, b]));
  const snapshotById = new Map(((publications.data as any[] | null) ?? []).map((p) => [p.business_id, p.public_snapshot]));
  const nameById = new Map(((users.data as any[] | null) ?? []).map((u) => [u.id, u.name]));
  const prizes = readPrizes(row.prizes);

  return placed
    .map((winner) => {
      const business = businessById.get(winner.business_id);
      const snapshot = snapshotById.get(winner.business_id) as any;
      const live = business?.status === "published" && snapshot?.slug === business?.slug;
      return {
        place: winner.placement,
        prize: prizes.find((p) => p.place === winner.placement)?.amount ?? 0,
        businessName: String((live ? snapshot?.name : null) ?? business?.name ?? "A PitchNest founder"),
        businessSlug: live ? String(business.slug) : null,
        founderName: winner.public_name_consent === true ? String(nameById.get(winner.user_id) ?? "") || null : null,
      };
    })
    .sort((a, b) => a.place - b.place);
}

// ─── Public view ─────────────────────────────────────────────────────────────

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function publicSocialHandles(raw: unknown) {
  const handles = readSocialHandles(raw);
  return Object.entries(handles).map(([platform, value]) => ({
    platform,
    label: PLATFORM_LABELS[platform as keyof typeof PLATFORM_LABELS],
    handle: value!.handle,
    url: value!.url,
    collaboration: PLATFORM_COLLABORATION[platform as keyof typeof PLATFORM_COLLABORATION],
  }));
}

export function toPublicChallenge(
  row: any,
  extras: { discount: DiscountCodeRow | null; participantCount: number; results: PublicResult[] | null; now?: Date },
) {
  const prizes = readPrizes(row.prizes);
  const pitchWeight = Number.isInteger(row.pitch_weight) ? row.pitch_weight : 60;
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title ?? ""),
    organizer: String(row.organizer ?? ""),
    tagline: String(row.tagline ?? ""),
    description: String(row.description ?? ""),
    region: String(row.region ?? ""),
    websiteUrl: typeof row.website_url === "string" ? row.website_url : null,
    bannerUrl: bannerUrl(row),
    prizeCurrency: String(row.prize_currency ?? "NGN"),
    prizes,
    prizePool: prizePool(prizes),
    startsAt: isoOrNull(row.starts_at),
    submissionDeadline: isoOrNull(row.submission_deadline),
    winnersAnnouncedOn: dateOnly(row.winners_announced_on),
    eligibility: String(row.eligibility ?? ""),
    requirements: String(row.requirements ?? ""),
    judgingCriteria: String(row.judging_criteria ?? ""),
    terms: String(row.terms ?? ""),
    pitchWeight,
    profileWeight: 100 - pitchWeight,
    eligibleSessionModes: Array.isArray(row.eligible_session_modes) ? row.eligible_session_modes : [],
    minCompletedSessions: Number(row.min_completed_sessions) || 1,
    requiredPlan: row.required_plan ?? null,
    socialHandles: publicSocialHandles(row.social_handles),
    discount: extras.discount ? toPublicDiscount(extras.discount, extras.now) : null,
    phase: challengePhase(row, extras.now),
    participantCount: extras.participantCount,
    resultsPublished: Boolean(row.results_published_at),
    results: extras.results,
  };
}

/** GET /api/public/challenges/:slug — the public challenge page. */
export async function getPublicChallenge(req: Request, res: Response) {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  try {
    const row = await loadListedChallenge(slug);
    if (!row) return res.status(404).json({ error: "Challenge not found." });
    const [discount, count, results] = await Promise.all([
      loadDiscountForChallenge(row),
      participantCount(row.id),
      loadPublicResults(row),
    ]);
    res.set("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.json({ data: toPublicChallenge(row, { discount, participantCount: count, results }) });
  } catch (error) {
    console.error("Public challenge read failed:", error);
    return res.status(500).json({ error: "Failed to load the challenge." });
  }
}

/**
 * GET /api/public/challenges/:slug/share-html — the link preview for a shared
 * challenge page (utils/publicChallengeMetadata.ts). vercel.json sends only
 * link-preview crawlers here; drafts and unknown slugs get a "not found" card.
 */
export async function getChallengeShareHtml(req: Request, res: Response) {
  const slug = String(req.params.slug || "").trim().toLowerCase().slice(0, 80);
  const origin = publicSiteOrigin();
  let share: ChallengeShare | null = null;
  try {
    const row = await loadListedChallenge(slug);
    if (row) {
      share = {
        slug: String(row.slug),
        title: String(row.title ?? ""),
        tagline: String(row.tagline ?? ""),
        description: String(row.description ?? ""),
        imageUrl: shareImageUrl(row, origin),
      };
    }
  } catch (error) {
    console.error("Challenge share preview lookup failed:", error);
  }
  const html = renderChallengeShareDocument(share, origin, share?.slug ?? (isChallengeSlug(slug) ? slug : "unavailable"));
  res.set("Cache-Control", share ? "public, max-age=300, s-maxage=600" : "public, max-age=60");
  return res.status(share ? 200 : 404).type("html").send(html);
}

/**
 * GET /api/public/challenges/promo — the challenge the app shows as a pop-up:
 * the soonest-closing one that is upcoming or open, with its pop-up switched
 * on. data is null when there is none (or before migration 0038).
 */
export async function getChallengePromo(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=60, s-maxage=120");
  try {
    const { data, error } = await supabase
      .from("challenges")
      .select(CHALLENGE_COLUMNS)
      .in("status", ["published", "open"])
      .eq("promo_enabled", true)
      .order("submission_deadline", { ascending: true })
      .limit(5);
    if (error) {
      if (!isMissingRelation(error)) console.error("Challenge promo read failed:", error.message);
      return res.json({ data: null });
    }
    const now = new Date();
    const row = ((data as any[] | null) ?? []).find((r) => ["open", "upcoming"].includes(challengePhase(r, now)));
    if (!row) return res.json({ data: null });
    const prizes = readPrizes(row.prizes);
    return res.json({
      data: {
        slug: String(row.slug),
        title: String(row.title),
        tagline: String(row.tagline ?? ""),
        imageUrl: bannerUrl(row),
        prizePool: prizePool(prizes),
        prizeCurrency: String(row.prize_currency ?? "NGN"),
        phase: challengePhase(row, now),
        submissionDeadline: isoOrNull(row.submission_deadline),
      },
    });
  } catch (error) {
    console.error("Challenge promo read threw:", error);
    return res.json({ data: null });
  }
}

// ─── A founder's entry ───────────────────────────────────────────────────────

export type ChecklistStatus = "not_started" | "in_progress" | "completed" | "pending_verification" | "needs_correction";

export interface ChecklistItem {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail?: string;
}

export function entryChecklist(input: {
  subscription: SubscriptionCheck["state"];
  requiredPlan: string | null;
  completedSessions: number;
  minSessions: number;
  bestScore: number | null;
  business: EligibleBusiness | null;
  hasPublishedBusiness: boolean;
  socialUrl: string | null;
  profileLinkConfirmed: boolean;
  status: EntryStatus;
  submittedAt: string | null;
  reviewNote?: string | null;
}): ChecklistItem[] {
  const reviewed: ChecklistStatus =
    input.status === "approved" ? "completed"
    : input.status === "submitted" ? "pending_verification"
    : input.status === "needs_correction" || input.status === "rejected" ? "needs_correction"
    : "not_started";
  return [
    { key: "joined", label: "Joined the challenge", status: "completed" },
    {
      key: "subscription",
      label: `Eligible ${input.requiredPlan === "prep" ? "Founder" : "Pro Founder"} subscription verified`,
      status:
        input.subscription === "verified" || input.subscription === "not_required" ? "completed"
        : input.subscription === "pending" ? "pending_verification"
        : "not_started",
      detail: input.subscription === "pending" ? "Your payment is being confirmed with Flutterwave." : undefined,
    },
    {
      key: "session",
      label: input.minSessions > 1 ? `Completed at least ${input.minSessions} full pitch sessions` : "Completed at least one full pitch session",
      status: input.completedSessions >= input.minSessions ? "completed" : input.completedSessions > 0 ? "in_progress" : "not_started",
      detail: `${input.completedSessions} of ${input.minSessions}`,
    },
    {
      key: "score",
      label: "Valid pitch readiness score available",
      status: input.bestScore !== null ? "completed" : "not_started",
      detail: input.bestScore !== null ? `Best verified score ${input.bestScore}/100` : undefined,
    },
    {
      key: "business",
      label: "Business published on Discover",
      status: input.business?.eligible ? "completed"
        : input.business || input.hasPublishedBusiness ? "in_progress"
        : "not_started",
      detail: input.business && !input.business.eligible
        ? input.business.isExample ? "Example businesses can't be entered."
          : input.business.missingRequired.length ? `Missing: ${input.business.missingRequired.join(", ")}` : "Publish it on Discover."
        : undefined,
    },
    { key: "socialPost", label: "Social media score post submitted", status: input.socialUrl ? "completed" : "not_started" },
    { key: "profileLink", label: "Business profile link included", status: input.profileLinkConfirmed ? "completed" : "not_started" },
    {
      key: "socialReview",
      label: "Social media requirements reviewed",
      status: reviewed,
      detail: reviewed === "needs_correction" && input.reviewNote ? input.reviewNote : undefined,
    },
    {
      key: "submitted",
      label: "Final entry submitted",
      status: input.submittedAt && (input.status === "submitted" || input.status === "approved") ? "completed"
        : input.status === "needs_correction" ? "needs_correction"
        : "not_started",
    },
  ];
}

/** What still blocks submission, in the founder's words. */
export function submissionBlockers(input: {
  subscription: SubscriptionCheck["state"];
  requiredPlan: string | null;
  completedSessions: number;
  minSessions: number;
  bestScore: number | null;
  business: EligibleBusiness | null;
  socialUrl: string | null;
  profileLinkConfirmed: boolean;
}): string[] {
  const missing: string[] = [];
  const planLabel = input.requiredPlan === "prep" ? "Founder" : "Pro Founder";
  if (input.subscription === "pending") missing.push(`Your ${planLabel} payment is still being confirmed.`);
  else if (input.subscription === "missing") missing.push(`Subscribe to ${planLabel}.`);
  if (input.completedSessions < input.minSessions) missing.push("Complete a full AI investor pitch session.");
  else if (input.bestScore === null) missing.push("Get a valid readiness score from a complete session.");
  if (!input.business) missing.push("Choose the Discover business you are entering.");
  else if (!input.business.eligible) missing.push(`Complete and publish ${input.business.name} on Discover.`);
  if (!input.socialUrl) missing.push("Add the link to your social media post.");
  if (!input.profileLinkConfirmed) missing.push("Confirm your post's caption links to your Discover profile.");
  return missing;
}

async function loadEntry(challengeId: string, userId: number): Promise<any | null> {
  const { data, error } = await supabase
    .from("challenge_participants")
    .select(PARTICIPANT_COLUMNS)
    .eq("challenge_id", challengeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

interface EntryContext {
  challenge: any;
  phase: ChallengePhase;
  entry: any;
  subscription: SubscriptionCheck;
  businesses: EligibleBusiness[];
  business: EligibleBusiness | null;
  scoreFresh: boolean;
}

/**
 * Reloads a founder's entry with everything verified fresh: the score from
 * their sessions, their plan, their businesses. Records the first time the
 * plan is verified and the first time every automatic check passes (and tells
 * them once).
 */
async function buildEntryContext(challenge: any, userId: number): Promise<EntryContext | null> {
  let entry = await loadEntry(challenge.id, userId);
  if (!entry) return null;
  const scoreFresh = await refreshChallengeScores(challenge.id, entry.id);
  if (scoreFresh) entry = (await loadEntry(challenge.id, userId)) ?? entry;

  const [subscription, businesses] = await Promise.all([
    checkChallengeSubscription(userId, challenge.required_plan ?? null),
    businessesForChallenge(userId),
  ]);
  const business = businesses.find((b) => b.id === entry.business_id) ?? null;

  const patch: Record<string, unknown> = {};
  if (subscription.state === "verified" && !entry.subscription_verified_at) {
    patch.subscription_verified_at = new Date().toISOString();
    patch.subscription_tx_ref = subscription.txRef;
  }
  const automaticChecksPass =
    (subscription.state === "verified" || subscription.state === "not_required") &&
    Number(entry.completed_sessions) >= Number(challenge.min_completed_sessions || 1) &&
    entry.best_score !== null &&
    business?.eligible === true;
  const firstEligible = automaticChecksPass && !entry.eligible_at;
  if (firstEligible) patch.eligible_at = new Date().toISOString();
  if (Object.keys(patch).length) {
    let update = supabase.from("challenge_participants").update(patch).eq("id", entry.id);
    // Only the refresh that records eligibility first tells the founder.
    if (firstEligible) update = update.is("eligible_at", null);
    const { data: updated, error } = await update.select("id");
    if (!error) {
      entry = { ...entry, ...patch };
      if (firstEligible && Array.isArray(updated) && updated.length > 0) {
        await notifyChallenge([userId], "challenge_eligible", challenge.id);
      }
    }
  }
  return { challenge, phase: challengePhase(challenge), entry, subscription, businesses, business, scoreFresh };
}

function toEntryView(context: EntryContext) {
  const { challenge, phase, entry, subscription, businesses, business } = context;
  const minSessions = Number(challenge.min_completed_sessions) || 1;
  const status = entry.status as EntryStatus;
  const shared = {
    subscription: subscription.state,
    requiredPlan: challenge.required_plan ?? null,
    completedSessions: Number(entry.completed_sessions) || 0,
    minSessions,
    bestScore: entry.best_score ?? null,
    business,
    socialUrl: entry.social_post_url ?? null,
    profileLinkConfirmed: entry.profile_link_confirmed === true,
  };
  const editable = entryEditable(phase, status) && entry.placement === null;
  const blockers = submissionBlockers(shared);
  return {
    joined: true,
    id: String(entry.id),
    phase,
    status,
    editable,
    joinedAt: entry.joined_at ?? null,
    submittedAt: entry.submitted_at ?? null,
    reviewNote: status === "needs_correction" || status === "rejected" || status === "disqualified" ? entry.review_note ?? null : null,
    bestScore: entry.best_score ?? null,
    bestScoreAt: entry.best_score_at ?? null,
    bestSessionId: entry.best_session_id ?? null,
    completedSessions: shared.completedSessions,
    minSessions,
    scoreFrozen: Boolean(entry.score_frozen_at),
    scoreCheckedAt: entry.score_checked_at ?? null,
    scoreFresh: context.scoreFresh,
    subscription: { state: subscription.state, plan: subscription.plan, expiresAt: subscription.expiresAt },
    businesses: businesses.map((b) => ({ ...b, publicUrl: b.published ? `/businesses/${encodeURIComponent(b.slug)}` : null })),
    businessId: entry.business_id ?? null,
    social: {
      platform: entry.social_platform ?? null,
      url: entry.social_post_url ?? null,
      evidenceUploaded: Boolean(entry.evidence_file),
    },
    profileLinkConfirmed: shared.profileLinkConfirmed,
    publicNameConsent: entry.public_name_consent === true,
    placement: entry.placement ?? null,
    checklist: entryChecklist({ ...shared, hasPublishedBusiness: businesses.some((b) => b.published), status, submittedAt: entry.submitted_at ?? null, reviewNote: entry.review_note }),
    readyToSubmit: editable && blockers.length === 0,
    blockers,
  };
}

async function challengeForFounder(req: Request, res: Response): Promise<any | null> {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const row = await loadListedChallenge(slug);
  if (!row) {
    res.status(404).json({ error: "Challenge not found." });
    return null;
  }
  return row;
}

/** GET /api/challenges/:slug/entry — the founder's entry, verified fresh. */
export async function getMyChallengeEntry(req: Request, res: Response) {
  try {
    const challenge = await challengeForFounder(req, res);
    if (!challenge) return;
    const context = await buildEntryContext(challenge, req.user!.id);
    res.set("Cache-Control", "private, no-store");
    if (!context) {
      return res.json({ data: { joined: false, phase: challengePhase(challenge), canJoin: challengePhase(challenge) === "open" } });
    }
    return res.json({ data: toEntryView(context) });
  } catch (error) {
    console.error("Challenge entry read failed:", error);
    return res.status(500).json({ error: "Failed to load your entry." });
  }
}

/** POST /api/challenges/:slug/join — creates the founder's one entry (idempotent). */
export async function joinChallenge(req: Request, res: Response) {
  try {
    const challenge = await challengeForFounder(req, res);
    if (!challenge) return;
    if (challengePhase(challenge) !== "open") {
      return res.status(409).json({ error: "This challenge isn't accepting new entries right now." });
    }
    const userId = req.user!.id;
    const { error } = await supabase
      .from("challenge_participants")
      .insert({ challenge_id: challenge.id, user_id: userId, status: "in_progress" });
    if (error && error.code !== "23505") {
      console.error("Challenge join failed:", error);
      return res.status(500).json({ error: "Couldn't join the challenge. Please try again." });
    }
    if (!error) await notifyChallenge([userId], "challenge_joined", challenge.id);
    const context = await buildEntryContext(challenge, userId);
    if (!context) return res.status(500).json({ error: "Couldn't join the challenge. Please try again." });
    return res.status(error ? 200 : 201).json({ data: toEntryView(context) });
  } catch (error) {
    console.error("Challenge join threw:", error);
    return res.status(500).json({ error: "Couldn't join the challenge. Please try again." });
  }
}

/**
 * PATCH /api/challenges/:slug/entry — the founder's choices: business, social
 * post, the caption confirmation, and name consent. Changing what was submitted
 * takes the entry back to "in progress" until it is submitted again.
 */
export async function updateChallengeEntry(req: Request, res: Response) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const challenge = await challengeForFounder(req, res);
    if (!challenge) return;
    const userId = req.user!.id;
    const entry = await loadEntry(challenge.id, userId);
    if (!entry) return res.status(404).json({ error: "Join the challenge first." });
    const phase = challengePhase(challenge);

    const patch: Record<string, unknown> = {};
    if ("publicNameConsent" in body) {
      if (typeof body.publicNameConsent !== "boolean") return res.status(400).json({ error: "publicNameConsent must be true or false." });
      patch.public_name_consent = body.publicNameConsent;
    }

    const changesEntry = ["businessId", "socialPlatform", "socialPostUrl", "profileLinkConfirmed"].some((key) => key in body);
    if (changesEntry) {
      if (!entryEditable(phase, entry.status) || entry.placement !== null) {
        return res.status(409).json({ error: "Your entry can't be changed now." });
      }
      if ("businessId" in body) {
        if (body.businessId === null || body.businessId === "") patch.business_id = null;
        else {
          const businesses = await businessesForChallenge(userId);
          const chosen = businesses.find((b) => b.id === body.businessId);
          if (!chosen) return res.status(404).json({ error: "Choose a business you own or manage." });
          if (!chosen.published) return res.status(422).json({ error: "Publish this business on Discover first." });
          if (chosen.isExample) return res.status(422).json({ error: "Example businesses can't be entered." });
          patch.business_id = chosen.id;
        }
      }
      const platform = "socialPlatform" in body ? body.socialPlatform : entry.social_platform;
      if ("socialPostUrl" in body || "socialPlatform" in body) {
        const rawUrl = "socialPostUrl" in body ? body.socialPostUrl : entry.social_post_url;
        if (rawUrl === null || rawUrl === "") {
          patch.social_post_url = null;
          patch.social_platform = platform === null || platform === "" ? null : isSocialPlatform(platform) ? platform : null;
        } else {
          if (!isSocialPlatform(platform)) return res.status(400).json({ error: "Choose Instagram, Facebook or X." });
          const checked = validateSocialPostUrl(platform, rawUrl);
          if ("error" in checked) return res.status(422).json({ error: checked.error });
          patch.social_platform = platform;
          patch.social_post_url = checked.url;
        }
      }
      if ("profileLinkConfirmed" in body) {
        if (typeof body.profileLinkConfirmed !== "boolean") return res.status(400).json({ error: "profileLinkConfirmed must be true or false." });
        patch.profile_link_confirmed = body.profileLinkConfirmed;
      }
      const changed = Object.entries(patch).some(([key, value]) => key !== "public_name_consent" && entry[key] !== value);
      if (changed && ["submitted", "approved", "rejected"].includes(entry.status)) {
        patch.status = "in_progress";
        patch.submitted_at = null;
      }
    }

    if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to update." });
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from("challenge_participants").update(patch).eq("id", entry.id);
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "This business is already entered in this challenge by another member of its team." });
      }
      console.error("Challenge entry update failed:", error);
      return res.status(500).json({ error: "Couldn't save your entry." });
    }
    const context = await buildEntryContext(challenge, userId);
    return res.json({ data: context ? toEntryView(context) : null });
  } catch (error) {
    console.error("Challenge entry update threw:", error);
    return res.status(500).json({ error: "Couldn't save your entry." });
  }
}

/**
 * POST /api/challenges/:slug/entry/submit — the final entry. Every requirement
 * is re-verified here from the server's own records; the founder only confirms
 * the rules. Resubmitting before the deadline (or after a requested
 * correction) replaces the earlier submission.
 */
export async function submitChallengeEntry(req: Request, res: Response) {
  try {
    const challenge = await challengeForFounder(req, res);
    if (!challenge) return;
    const userId = req.user!.id;
    const context = await buildEntryContext(challenge, userId);
    if (!context) return res.status(404).json({ error: "Join the challenge first." });
    const view = toEntryView(context);
    if (!view.editable) {
      return res.status(409).json({
        error: context.phase === "open" ? "Your entry can't be changed now." : "Submissions for this challenge have closed.",
      });
    }
    // Already submitted or approved, unchanged since: nothing to do. (Changing
    // the business or post takes an entry back to "in progress" first.)
    if (context.entry.status === "submitted" || context.entry.status === "approved") {
      return res.json({ data: view });
    }
    if (req.body?.acceptRules !== true) {
      return res.status(422).json({ error: "Confirm that your entry follows the challenge rules.", missing: ["Accept the rules."] });
    }
    if (view.blockers.length) {
      return res.status(422).json({ error: "Your entry isn't complete yet.", missing: view.blockers });
    }
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("challenge_participants")
      .update({ status: "submitted", submitted_at: nowIso, rules_accepted_at: nowIso, updated_at: nowIso })
      .eq("id", context.entry.id)
      .neq("status", "disqualified");
    if (error) {
      console.error("Challenge submission failed:", error);
      return res.status(500).json({ error: "Couldn't submit your entry. Please try again." });
    }
    await notifyChallenge([userId], "challenge_submitted", challenge.id);
    const fresh = await buildEntryContext(challenge, userId);
    return res.json({ data: fresh ? toEntryView(fresh) : null });
  } catch (error) {
    console.error("Challenge submission threw:", error);
    return res.status(500).json({ error: "Couldn't submit your entry. Please try again." });
  }
}

// ─── Optional screenshot evidence ────────────────────────────────────────────

export function evidenceObjectPath(participantId: string, file: string): string {
  return `challenge-evidence/${participantId}/${file}`;
}

/**
 * PUT /api/challenges/:slug/entry/evidence — an optional screenshot of the
 * post. Re-encoded (metadata stripped) and kept in the PRIVATE bucket; only
 * reviewers see it, through a short-lived signed link. The score itself always
 * comes from PitchNest's records, never from this image.
 */
export async function uploadChallengeEvidence(req: Request, res: Response) {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: "Choose an image to upload." });
  try {
    const challenge = await challengeForFounder(req, res);
    if (!challenge) return;
    const entry = await loadEntry(challenge.id, req.user!.id);
    if (!entry) return res.status(404).json({ error: "Join the challenge first." });
    if (!entryEditable(challengePhase(challenge), entry.status) || entry.placement !== null) {
      return res.status(409).json({ error: "Your entry can't be changed now." });
    }
    let buffer: Buffer;
    try {
      buffer = await reencodeImage(req.file.buffer, { width: 1600, height: 1600, fit: "inside", minWidth: 200, minHeight: 200 });
    } catch (error) {
      if (error instanceof MediaError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    const file = `evidence-${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32)}.webp`;
    const { error: uploadError } = await supabase.storage
      .from(config.storageBucket)
      .upload(evidenceObjectPath(entry.id, file), buffer, { contentType: "image/webp", upsert: true, duplex: "half" });
    if (uploadError) {
      console.error("Challenge evidence upload failed:", uploadError.message);
      return res.status(500).json({ error: "Couldn't save the screenshot." });
    }
    const { error } = await supabase
      .from("challenge_participants")
      .update({ evidence_file: file, updated_at: new Date().toISOString() })
      .eq("id", entry.id);
    if (error) {
      console.error("Challenge evidence save failed:", error);
      return res.status(500).json({ error: "Couldn't save the screenshot." });
    }
    if (entry.evidence_file && entry.evidence_file !== file) {
      await supabase.storage.from(config.storageBucket).remove([evidenceObjectPath(entry.id, entry.evidence_file)]);
    }
    return res.json({ data: { evidenceUploaded: true } });
  } catch (error) {
    console.error("Challenge evidence upload threw:", error);
    return res.status(500).json({ error: "Couldn't save the screenshot." });
  }
}

/** DELETE /api/challenges/:slug/entry/evidence */
export async function removeChallengeEvidence(req: Request, res: Response) {
  try {
    const challenge = await challengeForFounder(req, res);
    if (!challenge) return;
    const entry = await loadEntry(challenge.id, req.user!.id);
    if (!entry) return res.status(404).json({ error: "Join the challenge first." });
    if (!entryEditable(challengePhase(challenge), entry.status) || entry.placement !== null) {
      return res.status(409).json({ error: "Your entry can't be changed now." });
    }
    if (entry.evidence_file) {
      const { error } = await supabase
        .from("challenge_participants")
        .update({ evidence_file: null, updated_at: new Date().toISOString() })
        .eq("id", entry.id);
      if (error) return res.status(500).json({ error: "Couldn't remove the screenshot." });
      await supabase.storage.from(config.storageBucket).remove([evidenceObjectPath(entry.id, entry.evidence_file)]);
    }
    return res.json({ data: { evidenceUploaded: false } });
  } catch (error) {
    console.error("Challenge evidence removal threw:", error);
    return res.status(500).json({ error: "Couldn't remove the screenshot." });
  }
}
