import { supabase } from "../config/supabase.ts";

/**
 * Plan entitlements — the single source of truth for "what may this user do".
 *
 * Every paywall decision in the codebase resolves through this module so there
 * is one place to audit and one place to change when a tier moves. Callers must
 * never read users.plan directly.
 *
 * FAILURE POSTURE. Every lookup here fails CLOSED to the free tier: a database
 * problem must never hand out paid capability. The one thing that must not fail
 * closed is a user's ability to finish a session they already started — see the
 * note on hasCapacity().
 */

export type Plan = "free" | "pro";

/** Free tier: 2 session starts per rolling 7 days. */
export const FREE_WEEKLY_SESSIONS = 2;

/** The only duration a free user may run, in minutes. */
export const FREE_DURATION_MINUTES = 10;

/** Durations a paid user may choose, in minutes. */
export const PRO_DURATIONS = [10, 20, 30, 40] as const;

export interface Entitlement {
  plan: Plan;
  /** Session starts allowed per rolling 7 days. Infinity for pro. */
  maxWeeklySessions: number;
  /** Durations (minutes) the user may select. */
  allowedDurations: number[];
  /** May download the full PDF report. */
  pdfDownload: boolean;
  /** May have the panel enriched with live market research. */
  liveResearch: boolean;
}

const FREE: Entitlement = {
  plan: "free",
  maxWeeklySessions: FREE_WEEKLY_SESSIONS,
  allowedDurations: [FREE_DURATION_MINUTES],
  pdfDownload: false,
  liveResearch: false,
};

const PRO: Entitlement = {
  plan: "pro",
  maxWeeklySessions: Infinity,
  allowedDurations: [...PRO_DURATIONS],
  pdfDownload: true,
  liveResearch: true,
};

/**
 * Derives capability from a plan name and its expiry. Pure — no I/O.
 *
 * `expiresAt` null means the period never ends: that is what grandfathered and
 * comped accounts carry, so it must NOT be read as "expired". Anything that is
 * not exactly "pro", or a "pro" whose period has passed, is free.
 */
export function entitlementsForPlan(
  plan: string | null | undefined,
  expiresAt?: string | Date | null,
): Entitlement {
  if (plan !== "pro") return FREE;
  if (expiresAt) {
    const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    // An unparseable date is treated as expired — fail closed.
    if (!Number.isFinite(end.getTime()) || end.getTime() <= Date.now()) return FREE;
  }
  return PRO;
}

/**
 * Resolves the duration a session may actually run, in minutes.
 *
 * This is the authoritative clamp. The client's requested value is a REQUEST,
 * never a grant: restSocket's client_ready handler accepts whatever the browser
 * sends, so without this a crafted payload buys an unlimited session.
 *
 * Free users are pinned to FREE_DURATION_MINUTES regardless of what they ask
 * for. Paid users get the nearest allowed value at or below their request, so
 * a legacy config of 15 becomes 10 rather than being rejected outright.
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

  // Otherwise the largest allowed value that does not exceed the request.
  const atOrBelow = allowed.filter((d) => d <= requested);
  return atOrBelow.length ? Math.max(...atOrBelow) : min;
}

/**
 * Reads a user's plan. Returns the free entitlement on any failure.
 *
 * One indexed lookup by primary key. Callers that already hold the user row
 * (the WebSocket auth block, GET /me) should use entitlementsForPlan() on the
 * plan they already fetched instead of calling this, to avoid a second query.
 */
export async function getEntitlements(userId: number): Promise<Entitlement> {
  if (!userId) return FREE;

  try {
    const { data, error } = await supabase
      .from("users")
      .select("plan, plan_expires_at")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.warn(
        `⚠️ getEntitlements(${userId}) lookup failed, defaulting to free:`,
        error.message,
      );
      return FREE;
    }
    return entitlementsForPlan((data as any)?.plan, (data as any)?.plan_expires_at);
  } catch (err: any) {
    console.warn(`⚠️ getEntitlements(${userId}) threw, defaulting to free:`, err?.message || err);
    return FREE;
  }
}

export interface CapacityResult {
  ok: boolean;
  used: number;
  /** Infinity for pro. */
  remaining: number;
  /** When the oldest counted start ages out, so the UI can say "resets in…". */
  resetsAt: Date | null;
}

/**
 * Checks whether a user may START another session.
 *
 * Counts rows in the session_starts ledger inside the trailing 7 days. The
 * ledger — not the sessions table — is the meter, because a session row is only
 * written at end_session, so an abandoned pitch would otherwise cost real money
 * and consume no quota.
 *
 * ON FAILURE THIS ALLOWS THE SESSION. That is deliberate and is the one place
 * this module does not fail closed: if the ledger is unreadable, blocking every
 * free user from pitching is a worse outcome than letting a few extra sessions
 * through. The cost ceiling is already bounded by MAX_WS_PER_USER.
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
      console.warn(
        `⚠️ hasCapacity(${userId}) lookup failed, allowing the session:`,
        error.message,
      );
      return { ok: true, used: 0, remaining: ent.maxWeeklySessions, resetsAt: null };
    }

    const rows = data ?? [];
    const used = rows.length;
    const remaining = Math.max(0, ent.maxWeeklySessions - used);

    // The oldest start in the window ages out first, freeing one slot.
    const oldest = rows[0]?.started_at as string | undefined;
    const resetsAt = oldest
      ? new Date(new Date(oldest).getTime() + 7 * 24 * 60 * 60 * 1000)
      : null;

    return { ok: used < ent.maxWeeklySessions, used, remaining, resetsAt };
  } catch (err: any) {
    console.warn(`⚠️ hasCapacity(${userId}) threw, allowing the session:`, err?.message || err);
    return { ok: true, used: 0, remaining: ent.maxWeeklySessions, resetsAt: null };
  }
}

/**
 * Records that a session started. Must be called BEFORE any AI work begins —
 * that is the moment the cost is committed, and metering later reopens the
 * abandoned-session hole this ledger exists to close.
 *
 * Never throws: a bookkeeping failure must not stop a user pitching.
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
