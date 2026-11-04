import crypto from "node:crypto";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { cleanPublicText } from "../utils/publicText.ts";
import { DISCOUNT_COLUMNS, type DiscountCodeRow } from "./discountService.ts";

/**
 * Challenges PitchNest hosts itself (migration 0037): the rules, the founder's
 * entry and what is verified about it.
 *
 * TRUST. Nothing a founder sends is evidence of eligibility. The best score
 * comes from refresh_challenge_scores (their own sessions, written only by the
 * live-pitch server); the plan from users.plan_expires_at plus a settled
 * payment; the business from its active publication snapshot and the founder's
 * membership. A founder only chooses which business, which social post, and
 * whether their name may be shown.
 */

export const CHALLENGE_STATUSES = ["draft", "published", "open", "closed", "judging", "completed", "cancelled"] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];
export const ENTRY_STATUSES = ["in_progress", "submitted", "needs_correction", "approved", "rejected", "disqualified"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
export const SOCIAL_PLATFORMS = ["instagram", "facebook", "x"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const SESSION_MODES = ["solo", "coach", "panel"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
/** The parts of the rules an admin must sign off before a challenge goes public. */
export const CONFIRMATION_ITEMS = ["prizes", "dates", "discount", "social", "judging", "terms"] as const;
export type ConfirmationItem = (typeof CONFIRMATION_ITEMS)[number];
/** The business-profile rubric, each 0-10. */
export const PROFILE_CRITERIA = ["completeness", "problem", "solution", "market", "model", "traction"] as const;
export type ProfileCriterion = (typeof PROFILE_CRITERIA)[number];
/** What a reviewer checks on the social post by hand. */
export const SOCIAL_CHECKS = ["postPublic", "scoreScreenshot", "profileLink", "tagged", "collaboration", "follows"] as const;
export type SocialCheck = (typeof SOCIAL_CHECKS)[number];

export const CHALLENGE_COLUMNS = [
  "id", "slug", "title", "organizer", "tagline", "description", "region", "banner_file", "promo_enabled", "website_url",
  "prize_currency", "prizes", "starts_at", "submission_deadline", "winners_announced_on", "eligibility",
  "requirements", "judging_criteria", "terms", "pitch_weight", "eligible_session_modes",
  "min_completed_sessions", "required_plan", "social_handles", "discount_code_id", "confirmations",
  "status", "results_published_at", "created_at", "updated_at",
].join(", ");

export const PARTICIPANT_COLUMNS = [
  "id", "challenge_id", "user_id", "status", "business_id", "best_session_id", "best_score", "best_score_at",
  "completed_sessions", "score_checked_at", "score_frozen_at", "subscription_verified_at",
  "subscription_tx_ref", "eligible_at", "social_platform", "social_post_url", "evidence_file",
  "profile_link_confirmed", "public_name_consent", "rules_accepted_at", "submitted_at", "review_note",
  "social_checks", "reviewed_at", "profile_scores", "pitch_score_valid", "judge_notes", "shortlisted",
  "judged_at", "placement", "joined_at", "updated_at",
].join(", ");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isChallengeSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && SLUG_PATTERN.test(value);
}

/** Missing tables mean migration 0037 has not run: the feature is simply absent. */
export function isMissingRelation(error: any): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "42883" || error?.code === "PGRST202";
}

// ─── Phase ───────────────────────────────────────────────────────────────────

export type ChallengePhase = "draft" | "upcoming" | "open" | "closed" | "judging" | "completed" | "cancelled";

/**
 * What founders can do right now, from the status and the deadline on every
 * read. An "open" challenge whose deadline has passed reads as closed even
 * before an admin moves it on, so nobody can enter late.
 */
export function challengePhase(
  row: { status?: unknown; submission_deadline?: unknown },
  now = new Date(),
): ChallengePhase {
  switch (row?.status) {
    case "published":
      return "upcoming";
    case "open": {
      const deadline = Date.parse(String(row.submission_deadline));
      return Number.isFinite(deadline) && now.getTime() > deadline ? "closed" : "open";
    }
    case "closed":
    case "judging":
    case "completed":
    case "cancelled":
      return row.status as ChallengePhase;
    default:
      return "draft";
  }
}

/** Whether a founder may change their entry now. A requested correction stays open after the deadline. */
export function entryEditable(phase: ChallengePhase, entryStatus: EntryStatus): boolean {
  if (entryStatus === "disqualified") return false;
  if (phase === "open") return true;
  return entryStatus === "needs_correction" && (phase === "closed" || phase === "judging");
}

// ─── Prizes ──────────────────────────────────────────────────────────────────

export interface Prize {
  place: number;
  amount: number;
}

export function readPrizes(raw: unknown): Prize[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({ place: Number(item?.place), amount: Number(item?.amount) }))
    .filter((item) => Number.isInteger(item.place) && item.place >= 1 && Number.isFinite(item.amount) && item.amount > 0)
    .sort((a, b) => a.place - b.place);
}

export function prizePool(prizes: Prize[]): number {
  return Math.round(prizes.reduce((sum, prize) => sum + prize.amount, 0) * 100) / 100;
}

/** Amounts in place order (1st first) → [{place, amount}]. */
export function parsePrizeInput(raw: unknown): { prizes: Prize[] | null; error?: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) {
    return { prizes: null, error: "prizes must list 1 to 10 amounts, first place first." };
  }
  const prizes: Prize[] = [];
  for (const [index, item] of raw.entries()) {
    const amount = Number(typeof item === "object" && item !== null ? (item as any).amount : item);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || Math.round(amount * 100) !== amount * 100) {
      return { prizes: null, error: "Each prize must be a positive amount with at most two decimals." };
    }
    prizes.push({ place: index + 1, amount });
  }
  return { prizes };
}

// ─── Social handles and posts ────────────────────────────────────────────────

const PLATFORM_HOSTS: Record<SocialPlatform, string[]> = {
  instagram: ["instagram.com", "www.instagram.com", "m.instagram.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.com", "www.fb.com", "fb.watch"],
  x: ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
};

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X (Twitter)",
};

/** Honest per-platform guidance: collaboration is not the same everywhere. */
export const PLATFORM_COLLABORATION: Record<SocialPlatform, "supported" | "limited" | "unsupported"> = {
  instagram: "supported",
  facebook: "limited",
  x: "unsupported",
};

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

function parsedHttpsUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 500 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * A public post URL on the platform the founder chose. Only the shape is
 * checked: PitchNest never fetches the link (no platform API, no crawling), so
 * whether the post is public, tagged and captioned is verified by a reviewer.
 */
export function validateSocialPostUrl(
  platform: SocialPlatform,
  raw: unknown,
): { ok: true; url: string } | { ok: false; error: string } {
  const url = parsedHttpsUrl(raw);
  const label = PLATFORM_LABELS[platform];
  if (!url) return { ok: false, error: "Paste the full https:// link to your post." };
  if (!PLATFORM_HOSTS[platform].includes(url.hostname.toLowerCase())) {
    return { ok: false, error: `That isn't a ${label} link. Choose the platform you posted on.` };
  }
  const path = url.pathname;
  const shapeOk =
    platform === "instagram"
      ? /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]{5,}\/?$/.test(path)
      : platform === "x"
        ? /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/\d{5,25}(?:\/(?:photo|video)\/\d)?\/?$/.test(path)
        : path.length > 1 && (/\d/.test(path + url.search) || /^\/share\//.test(path) || url.hostname === "fb.watch");
  if (!shapeOk) {
    return { ok: false, error: `Use the link to the post itself, not your ${label} profile.` };
  }
  url.hash = "";
  return { ok: true, url: url.toString() };
}

export interface SocialHandle {
  handle: string;
  url: string;
}

export function readSocialHandles(raw: unknown): Partial<Record<SocialPlatform, SocialHandle>> {
  const out: Partial<Record<SocialPlatform, SocialHandle>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const platform of SOCIAL_PLATFORMS) {
    const entry = (raw as Record<string, any>)[platform];
    const handle = typeof entry?.handle === "string" ? entry.handle.trim() : "";
    const url = parsedHttpsUrl(entry?.url);
    if (handle && url && PLATFORM_HOSTS[platform].includes(url.hostname.toLowerCase())) {
      out[platform] = { handle, url: url.toString() };
    }
  }
  return out;
}

function parseSocialHandles(raw: unknown): { handles: Record<string, SocialHandle> | null; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { handles: null, error: "socialHandles must be an object." };
  const handles: Record<string, SocialHandle> = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const entry = (raw as Record<string, any>)[platform];
    if (entry === undefined || entry === null) continue;
    const handle = typeof entry?.handle === "string" ? entry.handle.trim() : "";
    const rawUrl = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (!handle && !rawUrl) continue;
    if (!/^@?[A-Za-z0-9._-]{1,60}$/.test(handle)) {
      return { handles: null, error: `${PLATFORM_LABELS[platform]} handle must be letters, digits, dots, dashes or underscores.` };
    }
    const url = parsedHttpsUrl(rawUrl);
    if (!url || !PLATFORM_HOSTS[platform].includes(url.hostname.toLowerCase())) {
      return { handles: null, error: `${PLATFORM_LABELS[platform]} link must be an https:// link to that platform.` };
    }
    handles[platform] = { handle, url: url.toString() };
  }
  return { handles };
}

// ─── Business profile ────────────────────────────────────────────────────────

export const PROFILE_REQUIRED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["name", "Business name"],
  ["tagline", "Tagline"],
  ["description", "Description"],
  ["industry", "Industry"],
  ["stage", "Stage"],
  ["region", "Region"],
  ["problem", "Problem"],
  ["solution", "Solution"],
  ["targetCustomer", "Target customers"],
];
export const PROFILE_RECOMMENDED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["websiteUrl", "Website"],
  ["logoFile", "Logo"],
];

const filled = (value: unknown) => typeof value === "string" && value.trim().length > 0;

/** What the PUBLIC profile (the active snapshot) has and lacks. */
export function profileCompleteness(snapshot: unknown) {
  const s = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
  const missingRequired = PROFILE_REQUIRED_FIELDS.filter(([key]) => !filled(s[key])).map(([, label]) => label);
  const missingRecommended = PROFILE_RECOMMENDED_FIELDS.filter(([key]) => !filled(s[key])).map(([, label]) => label);
  const total = PROFILE_REQUIRED_FIELDS.length + PROFILE_RECOMMENDED_FIELDS.length;
  const done = total - missingRequired.length - missingRecommended.length;
  return {
    missingRequired,
    missingRecommended,
    complete: missingRequired.length === 0,
    percent: Math.round((done / total) * 100),
  };
}

export interface EligibleBusiness {
  id: string;
  slug: string;
  name: string;
  role: string;
  published: boolean;
  isExample: boolean;
  missingRequired: string[];
  missingRecommended: string[];
  complete: boolean;
  percent: number;
  /** Published, not an example, complete, owned or administered by the founder. */
  eligible: boolean;
}

/**
 * The founder's businesses with what the challenge needs from each. Only
 * owners and admins count: they are the people a business belongs to.
 */
export async function businessesForChallenge(userId: number): Promise<EligibleBusiness[]> {
  const { data: memberships, error: membershipError } = await supabase
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", userId)
    .eq("status", "active");
  if (membershipError) throw membershipError;
  const managed = ((memberships as any[] | null) ?? []).filter((m) => m.role === "owner" || m.role === "admin");
  if (managed.length === 0) return [];
  const ids = managed.map((m) => m.business_id);

  const [{ data: businesses, error: businessError }, { data: publications, error: publicationError }] = await Promise.all([
    supabase.from("businesses").select("id, slug, name, status").in("id", ids).neq("status", "removed"),
    supabase.from("business_publications").select("business_id, public_snapshot").in("business_id", ids).eq("status", "active"),
  ]);
  if (businessError) throw businessError;
  if (publicationError) throw publicationError;

  const snapshots = new Map(((publications as any[] | null) ?? []).map((p) => [p.business_id, p.public_snapshot]));
  const roles = new Map(managed.map((m) => [m.business_id, m.role]));
  return ((businesses as any[] | null) ?? []).map((business) => {
    const snapshot = snapshots.get(business.id);
    const published =
      business.status === "published" && !!snapshot && (snapshot as any)?.slug === business.slug;
    const isExample = String((snapshot as any)?.isExample ?? "false") === "true";
    const completeness = profileCompleteness(published ? snapshot : null);
    return {
      id: business.id,
      slug: business.slug,
      name: typeof (snapshot as any)?.name === "string" ? (snapshot as any).name : business.name,
      role: roles.get(business.id) ?? "owner",
      published,
      isExample,
      ...completeness,
      eligible: published && !isExample && completeness.complete,
    };
  });
}

// ─── Subscription ────────────────────────────────────────────────────────────

const PLAN_RANK: Record<string, number> = { prep: 1, pro: 2, founder: 3, enterprise: 4 };

export interface SubscriptionCheck {
  state: "verified" | "pending" | "missing" | "not_required";
  plan: string | null;
  expiresAt: string | null;
  txRef: string | null;
}

/**
 * Whether the founder holds the required plan RIGHT NOW, paid for: an
 * unexpired paid plan of at least that rank, and a settled payment for that
 * plan behind it. The free trial and comped access are not a subscription;
 * a pending payment is reported so the founder knows it is on its way.
 */
export async function checkChallengeSubscription(userId: number, requiredPlan: string | null): Promise<SubscriptionCheck> {
  if (!requiredPlan) return { state: "not_required", plan: null, expiresAt: null, txRef: null };
  const { data: user, error } = await supabase.from("users").select("plan, plan_expires_at").eq("id", userId).maybeSingle();
  if (error) throw error;
  const plan = (user as any)?.plan ?? null;
  const expires = (user as any)?.plan_expires_at ? new Date((user as any).plan_expires_at) : null;
  const active =
    (PLAN_RANK[String(plan)] ?? 0) >= (PLAN_RANK[requiredPlan] ?? 99) &&
    !!expires &&
    Number.isFinite(expires.getTime()) &&
    expires.getTime() > Date.now();

  const { data: payments, error: paymentError } = await supabase
    .from("payments")
    .select("tx_ref, status, plan, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (paymentError) throw paymentError;
  const rows = (payments as any[] | null) ?? [];
  const qualifying = (row: any) => (PLAN_RANK[String(row.plan)] ?? 0) >= (PLAN_RANK[requiredPlan] ?? 99);
  const settled = rows.find((row) => row.status === "successful" && qualifying(row));
  const expiresAt = expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null;
  if (active && settled) return { state: "verified", plan, expiresAt, txRef: settled.tx_ref };
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const pending = rows.find((row) => row.status === "pending" && qualifying(row) && Date.parse(row.created_at) > dayAgo);
  return { state: pending ? "pending" : "missing", plan, expiresAt, txRef: null };
}

// ─── Scores ──────────────────────────────────────────────────────────────────

/** Recomputes verified scores in the database. False when it could not run. */
export async function refreshChallengeScores(challengeId: string, participantId?: string): Promise<boolean> {
  const { error } = await supabase.rpc("refresh_challenge_scores", {
    p_challenge_id: challengeId,
    p_participant_id: participantId ?? null,
  });
  if (error) {
    console.error("Challenge score refresh failed:", error.message);
    return false;
  }
  return true;
}

/** The rubric total as 0-100, or null until every criterion is scored. */
export function profileRubricScore(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const values = PROFILE_CRITERIA.map((key) => Number((raw as Record<string, unknown>)[key]));
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 10)) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / (PROFILE_CRITERIA.length * 10)) * 1000) / 10;
}

/**
 * The combined judging score: pitch weight × verified best score plus the
 * rest × profile rubric. An invalidated pitch score counts as zero. Null until
 * both parts are known.
 */
export function finalJudgingScore(input: {
  bestScore: number | null;
  pitchScoreValid: boolean;
  profileScore: number | null;
  pitchWeight: number;
}): number | null {
  if (input.bestScore === null || input.profileScore === null) return null;
  const pitch = input.pitchScoreValid ? input.bestScore : 0;
  const weight = Math.min(100, Math.max(0, input.pitchWeight));
  return Math.round(((pitch * weight + input.profileScore * (100 - weight)) / 100) * 10) / 10;
}

export function parseProfileScores(raw: unknown): { scores: Record<ProfileCriterion, number> | null; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { scores: null, error: "profileScores must be an object." };
  const scores = {} as Record<ProfileCriterion, number>;
  for (const key of PROFILE_CRITERIA) {
    const value = Number((raw as Record<string, unknown>)[key]);
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      return { scores: null, error: `Score ${key} as a whole number from 0 to 10.` };
    }
    scores[key] = value;
  }
  return { scores };
}

export function parseSocialChecks(raw: unknown): Record<SocialCheck, boolean> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {} as Record<SocialCheck, boolean>;
  for (const key of SOCIAL_CHECKS) out[key] = (raw as Record<string, unknown>)[key] === true;
  return out;
}

// ─── Confirmations ───────────────────────────────────────────────────────────

/** The values an admin's sign-off covers. Editing any of them makes it stale. */
function confirmationSubject(item: ConfirmationItem, row: any, discount: DiscountCodeRow | null): unknown {
  switch (item) {
    case "prizes":
      return { currency: row.prize_currency, prizes: readPrizes(row.prizes) };
    case "dates":
      return {
        startsAt: new Date(row.starts_at).toISOString(),
        deadline: new Date(row.submission_deadline).toISOString(),
        announced: row.winners_announced_on ?? null,
      };
    case "discount":
      return discount
        ? {
            code: discount.code,
            percentOff: discount.percent_off,
            plans: [...(discount.plans ?? [])].sort(),
            terms: [...(discount.terms ?? [])].sort(),
            periods: discount.periods,
            startsAt: discount.starts_at ? new Date(discount.starts_at).toISOString() : null,
            endsAt: discount.ends_at ? new Date(discount.ends_at).toISOString() : null,
            maxRedemptions: discount.max_redemptions,
            newCustomersOnly: discount.new_customers_only,
            combineWithOffer: discount.combine_with_offer,
          }
        : { code: null };
    case "social":
      return readSocialHandles(row.social_handles);
    case "judging":
      return {
        criteria: row.judging_criteria ?? "",
        pitchWeight: row.pitch_weight,
        modes: [...(row.eligible_session_modes ?? [])].sort(),
        minSessions: row.min_completed_sessions,
      };
    case "terms":
      return {
        terms: row.terms ?? "",
        eligibility: row.eligibility ?? "",
        requirements: row.requirements ?? "",
        requiredPlan: row.required_plan ?? null,
      };
  }
}

export function confirmationHash(item: ConfirmationItem, row: any, discount: DiscountCodeRow | null): string {
  return crypto.createHash("sha256").update(JSON.stringify(confirmationSubject(item, row, discount))).digest("hex");
}

export interface ConfirmationState {
  item: ConfirmationItem;
  confirmed: boolean;
  /** Signed off, but the values changed since. */
  stale: boolean;
  by: number | null;
  at: string | null;
}

export function confirmationStates(row: any, discount: DiscountCodeRow | null): ConfirmationState[] {
  const stored = row?.confirmations && typeof row.confirmations === "object" ? row.confirmations : {};
  return CONFIRMATION_ITEMS.map((item) => {
    const entry = stored[item];
    const hash = typeof entry?.hash === "string" ? entry.hash : null;
    const current = hash ? confirmationHash(item, row, discount) : null;
    return {
      item,
      confirmed: !!hash && hash === current,
      stale: !!hash && hash !== current,
      by: Number.isInteger(entry?.by) ? entry.by : null,
      at: typeof entry?.at === "string" ? entry.at : null,
    };
  });
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export async function loadDiscountForChallenge(row: any): Promise<DiscountCodeRow | null> {
  if (!isUuid(row?.discount_code_id)) return null;
  const { data, error } = await supabase
    .from("discount_codes")
    .select(DISCOUNT_COLUMNS)
    .eq("id", row.discount_code_id)
    .maybeSingle();
  if (error) {
    console.error("Challenge discount lookup failed:", error.message);
    return null;
  }
  return (data as DiscountCodeRow | null) ?? null;
}

export function bannerUrl(row: any): string | null {
  if (!isUuid(row?.id) || typeof row?.banner_file !== "string" || !/^banner-[a-f0-9]{32}\.webp$/.test(row.banner_file)) return null;
  const { data } = supabase.storage.from(config.publicMediaBucket).getPublicUrl(`challenge-media/${row.id}/${row.banner_file}`);
  return data?.publicUrl || null;
}

export function challengePageUrl(origin: string, slug: string): string {
  return `${origin}/opportunities/challenges/${encodeURIComponent(slug)}`;
}

// ─── Notifications and audit ─────────────────────────────────────────────────

export type ChallengeNotification =
  | "challenge_joined"
  | "challenge_eligible"
  | "challenge_submitted"
  | "challenge_correction"
  | "challenge_approved"
  | "challenge_rejected"
  | "challenge_results";

/** Best effort: a notification must never fail the action that caused it. */
export async function notifyChallenge(userIds: number[], type: ChallengeNotification, challengeId: string): Promise<void> {
  const unique = [...new Set(userIds.filter((id) => Number.isInteger(id)))];
  if (unique.length === 0) return;
  const { error } = await supabase
    .from("notifications")
    .insert(unique.map((userId) => ({ user_id: userId, type, entity_id: challengeId })));
  if (error) console.warn(`Challenge notification ${type} failed:`, error.message);
}

export async function recordAdminAudit(entry: {
  actorId: number;
  action: string;
  subjectType: "challenge" | "challenge_participant" | "discount_code";
  subjectId: string;
  challengeId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("admin_audit_log").insert({
    actor_id: entry.actorId,
    action: entry.action,
    subject_type: entry.subjectType,
    subject_id: entry.subjectId,
    challenge_id: entry.challengeId ?? null,
    metadata: entry.metadata ?? {},
  });
  if (error) console.warn(`Admin audit write failed for ${entry.action}:`, error.message);
}

// ─── Admin input ─────────────────────────────────────────────────────────────

export function slugifyChallengeTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return slug || "challenge";
}

const TEXT_FIELDS = {
  title: { column: "title", min: 5, max: 140, required: true, singleLine: true },
  organizer: { column: "organizer", min: 2, max: 120, required: true, singleLine: true },
  tagline: { column: "tagline", min: 10, max: 300, required: true, singleLine: true },
  description: { column: "description", min: 10, max: 5000, required: true, singleLine: false },
  region: { column: "region", min: 0, max: 120, required: false, singleLine: true },
  eligibility: { column: "eligibility", min: 0, max: 3000, required: false, singleLine: false },
  requirements: { column: "requirements", min: 0, max: 5000, required: false, singleLine: false },
  judgingCriteria: { column: "judging_criteria", min: 0, max: 3000, required: false, singleLine: false },
  terms: { column: "terms", min: 0, max: 15000, required: false, singleLine: false },
} as const;

function isoDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Admin edits to a challenge. Status, banner, confirmations and results have
 * their own endpoints, so this never changes them.
 */
export function validateChallengeInput(
  input: unknown,
  options: { partial?: boolean } = {},
): { values: Record<string, unknown>; errors: string[] } {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [field, spec] of Object.entries(TEXT_FIELDS)) {
    if (!(field in body)) {
      if (spec.required && !options.partial) errors.push(`${field} is required.`);
      continue;
    }
    const raw = body[field];
    if (raw === null || raw === "") {
      if (spec.required) errors.push(`${field} is required.`);
      else values[spec.column] = field === "region" ? "Online" : null;
      continue;
    }
    if (typeof raw !== "string") {
      errors.push(`${field} must be text.`);
      continue;
    }
    let text = cleanPublicText(raw);
    if (spec.singleLine) text = text.replace(/\s+/g, " ");
    if (text.length < spec.min) errors.push(`${field} must be at least ${spec.min} characters.`);
    else if (text.length > spec.max) errors.push(`${field} can be up to ${spec.max} characters.`);
    else values[spec.column] = text || null;
  }

  if ("slug" in body) {
    if (isChallengeSlug(body.slug)) values.slug = body.slug;
    else errors.push("slug must be lowercase letters, digits and single dashes.");
  }
  if ("websiteUrl" in body) {
    const raw = typeof body.websiteUrl === "string" ? body.websiteUrl.trim() : "";
    if (!raw) values.website_url = null;
    else {
      const url = parsedHttpsUrl(raw);
      if (url) values.website_url = url.toString();
      else errors.push("websiteUrl must be an https:// link.");
    }
  }
  if ("prizeCurrency" in body || !options.partial) {
    const currency = typeof body.prizeCurrency === "string" ? body.prizeCurrency.trim().toUpperCase() : "";
    if (/^[A-Z]{3}$/.test(currency)) values.prize_currency = currency;
    else errors.push("prizeCurrency must be a three-letter currency code.");
  }
  if ("prizes" in body || !options.partial) {
    const parsed = parsePrizeInput(body.prizes);
    if (parsed.prizes) values.prizes = parsed.prizes;
    else errors.push(parsed.error!);
  }
  for (const [field, column] of [["startsAt", "starts_at"], ["submissionDeadline", "submission_deadline"]] as const) {
    if (!(field in body)) {
      if (!options.partial) errors.push(`${field} is required.`);
      continue;
    }
    const value = isoDateTime(body[field]);
    if (value) values[column] = value;
    else errors.push(`${field} must be a date and time.`);
  }
  if (typeof values.starts_at === "string" && typeof values.submission_deadline === "string" && values.starts_at >= values.submission_deadline) {
    errors.push("startsAt must be before submissionDeadline.");
  }
  if ("winnersAnnouncedOn" in body) {
    const raw = body.winnersAnnouncedOn;
    if (raw === null || raw === "") values.winners_announced_on = null;
    else if (typeof raw === "string" && DATE_PATTERN.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      values.winners_announced_on = raw;
    } else errors.push("winnersAnnouncedOn must be a date (YYYY-MM-DD).");
  }
  if ("pitchWeight" in body) {
    const weight = Number(body.pitchWeight);
    if (Number.isInteger(weight) && weight >= 0 && weight <= 100) values.pitch_weight = weight;
    else errors.push("pitchWeight must be a whole number from 0 to 100.");
  }
  if ("eligibleSessionModes" in body) {
    const modes = Array.isArray(body.eligibleSessionModes) ? [...new Set(body.eligibleSessionModes)] : [];
    if (modes.length > 0 && modes.every((mode) => (SESSION_MODES as readonly unknown[]).includes(mode))) {
      values.eligible_session_modes = modes;
    } else errors.push("eligibleSessionModes must list solo, coach and/or panel.");
  }
  if ("minCompletedSessions" in body) {
    const min = Number(body.minCompletedSessions);
    if (Number.isInteger(min) && min >= 1 && min <= 20) values.min_completed_sessions = min;
    else errors.push("minCompletedSessions must be a whole number from 1 to 20.");
  }
  if ("requiredPlan" in body) {
    const plan = body.requiredPlan;
    if (plan === null || plan === "" || plan === "none") values.required_plan = null;
    else if (plan === "prep" || plan === "pro") values.required_plan = plan;
    else errors.push("requiredPlan must be pro, prep or none.");
  }
  if ("socialHandles" in body) {
    const parsed = parseSocialHandles(body.socialHandles);
    if (parsed.handles) values.social_handles = parsed.handles;
    else errors.push(parsed.error!);
  }
  if ("discountCodeId" in body) {
    const id = body.discountCodeId;
    if (id === null || id === "") values.discount_code_id = null;
    else if (isUuid(id)) values.discount_code_id = id;
    else errors.push("discountCodeId must be a discount code id.");
  }
  if ("promoEnabled" in body) {
    if (typeof body.promoEnabled === "boolean") values.promo_enabled = body.promoEnabled;
    else errors.push("promoEnabled must be true or false.");
  }
  return { values, errors: [...new Set(errors)] };
}

// ─── Batch reads for the staff table ─────────────────────────────────────────

/** checkChallengeSubscription for many founders in three queries. */
export async function subscriptionStates(
  userIds: number[],
  requiredPlan: string | null,
): Promise<Map<number, SubscriptionCheck>> {
  const out = new Map<number, SubscriptionCheck>();
  if (userIds.length === 0) return out;
  if (!requiredPlan) {
    for (const id of userIds) out.set(id, { state: "not_required", plan: null, expiresAt: null, txRef: null });
    return out;
  }
  const [{ data: users, error: userError }, { data: payments, error: paymentError }] = await Promise.all([
    supabase.from("users").select("id, plan, plan_expires_at").in("id", userIds),
    supabase.from("payments").select("user_id, tx_ref, status, plan, created_at").in("user_id", userIds).in("status", ["successful", "pending"]),
  ]);
  if (userError) throw userError;
  if (paymentError) throw paymentError;
  const required = PLAN_RANK[requiredPlan] ?? 99;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const byUser = new Map<number, any[]>();
  for (const row of (payments as any[] | null) ?? []) {
    const list = byUser.get(Number(row.user_id)) ?? [];
    list.push(row);
    byUser.set(Number(row.user_id), list);
  }
  for (const user of (users as any[] | null) ?? []) {
    const expires = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
    const expiresAt = expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null;
    const active = (PLAN_RANK[String(user.plan)] ?? 0) >= required && !!expires && expires.getTime() > Date.now();
    const rows = byUser.get(Number(user.id)) ?? [];
    const qualifying = (row: any) => (PLAN_RANK[String(row.plan)] ?? 0) >= required;
    const settled = rows.find((row) => row.status === "successful" && qualifying(row));
    const pending = rows.some((row) => row.status === "pending" && qualifying(row) && Date.parse(row.created_at) > dayAgo);
    out.set(Number(user.id), active && settled
      ? { state: "verified", plan: user.plan, expiresAt, txRef: settled.tx_ref }
      : { state: pending ? "pending" : "missing", plan: user.plan ?? null, expiresAt, txRef: null });
  }
  return out;
}

export interface BusinessSummary {
  id: string;
  slug: string;
  name: string;
  published: boolean;
  isExample: boolean;
  snapshot: Record<string, unknown> | null;
  missingRequired: string[];
  missingRecommended: string[];
  complete: boolean;
  percent: number;
}

/** Entered businesses as the public sees them (their active snapshot). */
export async function businessSummaries(ids: string[]): Promise<Map<string, BusinessSummary>> {
  const out = new Map<string, BusinessSummary>();
  const wanted = [...new Set(ids.filter(isUuid))];
  if (wanted.length === 0) return out;
  const [{ data: businesses, error: businessError }, { data: publications, error: publicationError }] = await Promise.all([
    supabase.from("businesses").select("id, slug, name, status").in("id", wanted),
    supabase.from("business_publications").select("business_id, public_snapshot").in("business_id", wanted).eq("status", "active"),
  ]);
  if (businessError) throw businessError;
  if (publicationError) throw publicationError;
  const snapshots = new Map(((publications as any[] | null) ?? []).map((p) => [p.business_id, p.public_snapshot]));
  for (const business of (businesses as any[] | null) ?? []) {
    const snapshot = (snapshots.get(business.id) as Record<string, unknown> | undefined) ?? null;
    const published = business.status === "published" && !!snapshot && snapshot.slug === business.slug;
    out.set(business.id, {
      id: business.id,
      slug: business.slug,
      name: typeof snapshot?.name === "string" ? (snapshot.name as string) : business.name,
      published,
      isExample: String(snapshot?.isExample ?? "false") === "true",
      snapshot: published ? snapshot : null,
      ...profileCompleteness(published ? snapshot : null),
    });
  }
  return out;
}
