import { supabase } from "../config/supabase.ts";

/**
 * Plan entitlements — the single source of truth for "what may this user do".
 *
 * Every paywall decision in the codebase resolves through this module so there
 * is one place to audit and one place to change when a tier moves. Callers must
 * never read users.plan directly.
 */

export type Plan = "free" | "prep" | "pro" | "founder" | "enterprise";

/** Free tier (post-trial): 2 session starts per rolling 7 days. */
export const FREE_WEEKLY_SESSIONS = 2;

/** Founder tier: unlimited sessions. */
export const FOUNDER_WEEKLY_SESSIONS = Infinity;

/** Prep tier: unlimited sessions (matches advertised Founder/Prep pricing). */
export const PREP_WEEKLY_SESSIONS = Infinity;

/** The standard free duration, in minutes. */
export const FREE_DURATION_MINUTES = 10;

/** Durations a Prep/Founder user may choose, in minutes. */
export const PREP_DURATIONS = [10, 20] as const;

/** Durations a paid Pro user or Trial user may choose, in minutes. */
export const PRO_DURATIONS = [10, 20, 30, 40] as const;

/** Default trial duration in days for new users during testing period. */
export const FREE_TRIAL_DAYS = 30;

export interface Entitlement {
  plan: Plan;
  /** Session starts allowed per rolling 7 days. Infinity for pro/trial. */
  maxWeeklySessions: number;
  /** Durations (minutes) the user may select. */
  allowedDurations: number[];
  /** May download the full PDF report. */
  pdfDownload: boolean;
  /** May have the panel enriched with live market research. */
  liveResearch: boolean;
  /** True when user is in the 30-day full access trial period. */
  isTrial: boolean;
  /** Trial days remaining if active. */
  trialDaysRemaining?: number;
}

export const FREE: Entitlement = {
  plan: "free",
  maxWeeklySessions: FREE_WEEKLY_SESSIONS,
  allowedDurations: [FREE_DURATION_MINUTES],
  pdfDownload: false,
  liveResearch: false,
  isTrial: false,
};

const PREP: Entitlement = {
  plan: "prep",
  maxWeeklySessions: PREP_WEEKLY_SESSIONS,
  allowedDurations: [...PREP_DURATIONS],
  pdfDownload: true,
  liveResearch: false,
  isTrial: false,
};

const PRO: Entitlement = {
  plan: "pro",
  maxWeeklySessions: Infinity,
  allowedDurations: [...PRO_DURATIONS],
  pdfDownload: true,
  liveResearch: true,
  isTrial: false,
};

/** Full Access Trial Entitlement — grants complete Pro capabilities during the 30-day testing period. */
export function getTrialEntitlement(daysRemaining: number = 30): Entitlement {
  return {
    plan: "pro",
    maxWeeklySessions: Infinity,
    allowedDurations: [...PRO_DURATIONS],
    pdfDownload: true,
    liveResearch: true,
    isTrial: true,
    trialDaysRemaining: Math.max(0, Math.round(daysRemaining)),
  };
}

/**
 * Checks whether a trial is active based on expiry timestamp, start timestamp, and status.
 */
export function isTrialActive(
  trialExpiresAt?: string | Date | null,
  trialStatus?: string | null,
  trialStartedAt?: string | Date | null,
): { active: boolean; daysRemaining: number } {
  if (trialStatus === "expired" || trialStatus === "cancelled") {
    return { active: false, daysRemaining: 0 };
  }

  // Derive explicit end date: if trialExpiresAt is present use it;
  // otherwise, if trialStartedAt is present, calculate trialStartedAt + 30 days.
  // If neither timestamp is set, the trial is inactive (prevents perpetual free access).
  let end: Date | null = null;
  if (trialExpiresAt) {
    const parsed = trialExpiresAt instanceof Date ? trialExpiresAt : new Date(trialExpiresAt);
    if (Number.isFinite(parsed.getTime())) {
      end = parsed;
    }
  } else if (trialStartedAt) {
    const started = trialStartedAt instanceof Date ? trialStartedAt : new Date(trialStartedAt);
    if (Number.isFinite(started.getTime())) {
      end = new Date(started.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
    }
  }

  if (!end) {
    return { active: false, daysRemaining: 0 };
  }

  const now = Date.now();
  if (end.getTime() > now) {
    const diffDays = Math.ceil((end.getTime() - now) / (1000 * 60 * 60 * 24));
    return { active: true, daysRemaining: Math.max(1, diffDays) };
  }

  return { active: false, daysRemaining: 0 };
}

/**
 * Derives capability from a plan name, paid expiry, and trial fields.
 */
export function entitlementsForPlan(
  plan: string | null | undefined,
  expiresAt?: string | Date | null,
  trialExpiresAt?: string | Date | null,
  trialStatus?: string | null,
  trialStartedAt?: string | Date | null,
): Entitlement {
  // 1. Paid subscriptions take priority if active. Enterprise (org / cohort
  //    seats) resolves to full PRO capability; prep/founder to PREP. Handling
  //    every paid name here means a granted tier can never silently fall through
  //    to FREE for lack of a mapping.
  if (plan === "pro" || plan === "prep" || plan === "founder" || plan === "enterprise") {
    const paid = plan === "pro" || plan === "enterprise" ? PRO : PREP;
    if (expiresAt) {
      const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
      if (Number.isFinite(end.getTime()) && end.getTime() > Date.now()) {
        return paid;
      }
    } else {
      // Null expiry on paid plan = comped/grandfathered
      return paid;
    }
  }

  // 2. 30-Day Free Trial / Full Access check
  const trial = isTrialActive(trialExpiresAt, trialStatus, trialStartedAt);
  if (trial.active) {
    return getTrialEntitlement(trial.daysRemaining);
  }

  return FREE;
}


/**
 * Resolves the duration a session may actually run, in minutes.
 */
export function resolveDuration(
  requestedMinutes: unknown,
  ent: Entitlement,
): number {
  const allowed = ent.allowedDurations;
  const min = allowed[0];

  const requested = Number(requestedMinutes);
  if (!Number.isFinite(requested) || requested <= 0) return min;

  // Exact match wins.
  if (allowed.includes(requested)) return requested;

  // Otherwise largest allowed value at or below requested.
  const atOrBelow = allowed.filter((d) => d <= requested);
  return atOrBelow.length ? Math.max(...atOrBelow) : min;
}

/**
 * Reads a user's plan and trial status.
 */
export async function getEntitlements(userId: number): Promise<Entitlement> {
  if (!userId) {
    // No authenticated user — fail CLOSED to the free tier. Never hand paid
    // capability to an unidentified caller.
    return FREE;
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("plan, plan_expires_at, trial_started_at, trial_expires_at, trial_status")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.warn(
        `⚠️ getEntitlements(${userId}) lookup failed, failing CLOSED to free:`,
        error.message,
      );
      return FREE;
    }

    return entitlementsForPlan(
      (data as any)?.plan,
      (data as any)?.plan_expires_at,
      (data as any)?.trial_expires_at,
      (data as any)?.trial_status,
      (data as any)?.trial_started_at,
    );
  } catch (err: any) {
    console.warn(`⚠️ getEntitlements(${userId}) threw, failing CLOSED to free:`, err?.message || err);
    return FREE;
  }
}

export interface CapacityResult {
  ok: boolean;
  used: number;
  remaining: number;
  resetsAt: Date | null;
}

/**
 * Checks whether a user may START another session.
 */
export async function hasCapacity(
  userId: number,
  ent: Entitlement,
): Promise<CapacityResult> {
  if (ent.maxWeeklySessions === Infinity) {
    return { ok: true, used: 0, remaining: Infinity, resetsAt: null };
  }

  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const { data, error } = await supabase
      .from("session_starts")
      .select("started_at")
      .eq("user_id", userId)
      .gt("started_at", windowStart.toISOString())
      .order("started_at", { ascending: true });

    if (error) {
      return { ok: true, used: 0, remaining: ent.maxWeeklySessions, resetsAt: null };
    }

    const rows = data ?? [];
    const used = rows.length;
    const remaining = Math.max(0, ent.maxWeeklySessions - used);

    const oldest = rows[0]?.started_at as string | undefined;
    const resetsAt = oldest
      ? new Date(new Date(oldest).getTime() + 7 * 24 * 60 * 60 * 1000)
      : null;

    return { ok: used < ent.maxWeeklySessions, used, remaining, resetsAt };
  } catch (err: any) {
    return { ok: true, used: 0, remaining: ent.maxWeeklySessions, resetsAt: null };
  }
}

/**
 * Records that a session started in the session_starts ledger.
 */
export async function recordSessionStart(userId: number): Promise<void> {
  if (!userId) return;
  try {
    const { error } = await supabase
      .from("session_starts")
      .insert([{ user_id: userId }]);
    if (error) {
      console.error(`❌ recordSessionStart(${userId}) failed:`, error.message);
    }
  } catch (err: any) {
    console.error(`❌ recordSessionStart(${userId}) threw:`, err?.message || err);
  }
}

/**
 * Atomically claims a weekly session slot: checks the quota AND records the
 * start in one operation, closing the check-then-act race where two concurrent
 * `client_ready` connections could both pass a separate hasCapacity() and both
 * record — exceeding the cap.
 *
 * Strategy (insert-then-rank): INSERT my start row first, then rank all of the
 * user's rows in the 7-day window by started_at. If my row's rank exceeds the
 * limit, I lost the race — delete my row and reject. Concurrent claimants each
 * count including the other's just-inserted row, so at most `limit` of them can
 * rank within bounds. Fails OPEN (allows the pitch) on a genuine DB error, so a
 * transient outage never blocks the core action — the same posture as before.
 */
export async function claimSessionSlot(
  userId: number,
  ent: Entitlement,
): Promise<CapacityResult> {
  if (!userId || ent.maxWeeklySessions === Infinity) {
    if (userId) await recordSessionStart(userId);
    return { ok: true, used: 0, remaining: Infinity, resetsAt: null };
  }

  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  try {
    // 1. Claim a slot up-front.
    const { data: mine, error: insErr } = await supabase
      .from("session_starts")
      .insert([{ user_id: userId }])
      .select("id, started_at")
      .single();

    if (insErr || !mine) {
      // Could not record — fail open (allow) rather than block a real pitch on a
      // DB blip. Soft quota bypass only; no paid capability is granted.
      console.error(`❌ claimSessionSlot(${userId}) insert failed:`, insErr?.message);
      return { ok: true, used: 0, remaining: ent.maxWeeklySessions, resetsAt: null };
    }

    // 2. Rank my row among the window's rows.
    const { data: rows, error: cntErr } = await supabase
      .from("session_starts")
      .select("id, started_at")
      .eq("user_id", userId)
      .gt("started_at", windowStart.toISOString())
      .order("started_at", { ascending: true })
      .order("id", { ascending: true });

    if (cntErr || !rows) {
      // Count failed after a successful insert — allow (fail open); the row
      // stays, so it is still metered.
      return { ok: true, used: 1, remaining: ent.maxWeeklySessions - 1, resetsAt: null };
    }

    const rank = rows.findIndex((r: any) => r.id === mine.id) + 1; // 1-based
    const used = rows.length;
    const oldest = rows[0]?.started_at as string | undefined;
    const resetsAt = oldest ? new Date(new Date(oldest).getTime() + WEEK_MS) : null;

    if (rank > ent.maxWeeklySessions) {
      // Lost the race / over the cap — release the slot so it isn't wasted.
      await supabase.from("session_starts").delete().eq("id", mine.id);
      return { ok: false, used: used - 1, remaining: 0, resetsAt };
    }

    return {
      ok: true,
      used,
      remaining: Math.max(0, ent.maxWeeklySessions - used),
      resetsAt,
    };
  } catch (err: any) {
    console.error(`❌ claimSessionSlot(${userId}) threw:`, err?.message || err);
    return { ok: true, used: 0, remaining: ent.maxWeeklySessions, resetsAt: null };
  }
}
