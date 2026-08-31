/**
 * PitchAttemptService — the server-side authority for "how many attempts has
 * this pitch used, and may another one start?"
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHAT A "PITCH" IS IN THIS SCHEMA
 * ──────────────────────────────────────────────────────────────────────────────
 * There is no `pitches` table. A pitch is a CHAIN of `sessions` rows linked by
 * `parent_session_id`:
 *
 *     attempt 1 (parent_session_id NULL)
 *       └── attempt 2 (parent_session_id = attempt 1)
 *             └── attempt 3 …
 *
 * Migration 0013 denormalises that chain onto every row as `pitch_root_id`
 * (id of attempt 1) and `attempt_number`, so counting is one indexed query.
 * Rows written before that migration have NULL in both; every function here
 * falls back to walking `parent_session_id`, which stays the source of truth.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES SERVER-SIDE
 * ──────────────────────────────────────────────────────────────────────────────
 * The frontend already walked the chain to show an "Attempt N" badge, but a
 * client-side count cannot enforce anything: refreshing, opening a second tab,
 * logging out and back in, editing client state, or reopening an old session all
 * reset it. Every number the UI shows for attempts now comes from here.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY AN ATTEMPT IS COUNTED AT COMPLETION, NOT AT START
 * ──────────────────────────────────────────────────────────────────────────────
 * A `sessions` row is only inserted when the session ends (restSocket's
 * end_session). So the durable count is "completed attempts". A founder whose
 * connection drops mid-pitch is not charged an attempt — which is the fair
 * direction, and matches how the weekly quota in entitlementService already
 * meters *starts* separately.
 *
 * The gap that leaves is two tabs starting attempt 5 at the same moment: both
 * would pass a purely DB-based check and produce attempts 5 and 6. LIVE_ATTEMPTS
 * below closes that in-process (Render runs a single instance, and
 * MAX_WS_PER_USER caps a user at 3 sockets anyway). It is deliberately a
 * best-effort reservation on top of the durable DB count, never a replacement
 * for it.
 */

import { supabase } from "../config/supabase.ts";

/** Hard ceiling on completed attempts per pitch. */
export const MAX_PITCH_ATTEMPTS = 5;

/**
 * How long a pitch stays "active" (able to accept new attempts).
 *
 * NON-DESTRUCTIVE BY DESIGN: this is a READ-TIME status, not a deletion job.
 * Nothing here or anywhere else removes a session row, its evaluation_report,
 * its cached PDF, or its share_id when this window passes — the report,
 * transcript and audio stay reachable indefinitely. Past this window the pitch
 * simply stops accepting new attempts, exactly like an exhausted one.
 */
export const PITCH_RETENTION_DAYS = 30;

/** Guard against a cycle or a pathological chain while walking parents. */
const MAX_CHAIN_HOPS = 40;

/** Minimal row shape needed to resolve a chain. Anything else is ignored. */
export interface ChainRow {
  id: number;
  parent_session_id?: number | null;
  pitch_root_id?: number | null;
  attempt_number?: number | null;
  created_at?: string | null;
  timestamp?: string | null;
}

export interface PitchAttemptState {
  /** id of attempt 1 of this chain. */
  pitchRootId: number;
  /** 1-based position of THIS session within its chain. */
  attemptNumber: number;
  /** Completed attempts in the chain (what the UI shows as "N of 5"). */
  attemptsUsed: number;
  attemptsRemaining: number;
  maxAttempts: number;
  /** True when another live session may start for this pitch. */
  canStartNewAttempt: boolean;
  attemptsExhausted: boolean;
  /** Replay / transcript / report only — no new live session. */
  isReportOnly: boolean;
  /** When the active window closes. Null when the chain has no usable date. */
  retentionExpiresAt: string | null;
  isPastRetention: boolean;
}

/**
 * In-flight attempts per pitch root, keyed by root id. Incremented when a live
 * session is admitted, decremented when its socket closes. See the header note
 * on why this exists and what it does not replace.
 */
const LIVE_ATTEMPTS = new Map<number, number>();

export function reserveLiveAttempt(rootId: number): void {
  if (!rootId) return;
  LIVE_ATTEMPTS.set(rootId, (LIVE_ATTEMPTS.get(rootId) || 0) + 1);
}

export function releaseLiveAttempt(rootId: number): void {
  if (!rootId) return;
  const next = (LIVE_ATTEMPTS.get(rootId) || 0) - 1;
  if (next > 0) LIVE_ATTEMPTS.set(rootId, next);
  else LIVE_ATTEMPTS.delete(rootId);
}

export function liveAttemptCount(rootId: number): number {
  return LIVE_ATTEMPTS.get(rootId) || 0;
}

/** created_at is the real column; timestamp is the legacy one. Prefer either. */
export function sessionDate(row: ChainRow | null | undefined): string | null {
  if (!row) return null;
  return row.created_at || row.timestamp || null;
}

/**
 * Resolve which chain a row belongs to.
 *
 * Prefers the denormalised pitch_root_id (migration 0013). Falls back to
 * walking parent_session_id through the supplied index, which is what rows
 * written before the migration need. A row whose parent is missing (deleted
 * parent) resolves to itself — the safe direction, since it can only
 * under-count a chain, never lock a founder out of attempts they still have.
 */
function resolveRootId(row: ChainRow, byId: Map<number, ChainRow>): number {
  if (row.pitch_root_id) return row.pitch_root_id;

  let current = row;
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    if (current.pitch_root_id) return current.pitch_root_id;
    const parentId = current.parent_session_id;
    if (!parentId) return current.id;
    const parent = byId.get(Number(parentId));
    if (!parent) return current.id;
    current = parent;
  }
  return current.id;
}

/**
 * Build the attempt state for every row in a set, in memory.
 *
 * Used by the list endpoint (which already holds all of the user's rows) so
 * annotating N sessions costs zero extra queries.
 */
export function computeAttemptStates(
  rows: ChainRow[],
): Map<number, PitchAttemptState> {
  const out = new Map<number, PitchAttemptState>();
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const byId = new Map<number, ChainRow>();
  for (const r of rows) if (r && r.id != null) byId.set(Number(r.id), r);

  // Group every row under its chain root.
  const chains = new Map<number, ChainRow[]>();
  const rootOf = new Map<number, number>();
  for (const row of byId.values()) {
    const rootId = resolveRootId(row, byId);
    rootOf.set(Number(row.id), rootId);
    const bucket = chains.get(rootId);
    if (bucket) bucket.push(row);
    else chains.set(rootId, [row]);
  }

  for (const [rootId, members] of chains) {
    // Oldest first, so position in the sorted list is the attempt number for
    // rows that predate migration 0013 and have no attempt_number stored.
    members.sort((a, b) => {
      const da = Date.parse(sessionDate(a) || "") || 0;
      const db = Date.parse(sessionDate(b) || "") || 0;
      if (da !== db) return da - db;
      return Number(a.id) - Number(b.id);
    });

    const attemptsUsed = members.length;
    const rootRow = byId.get(rootId) || members[0];
    const startedAt = sessionDate(rootRow);
    const expiresAt = startedAt
      ? new Date(
          Date.parse(startedAt) + PITCH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString()
      : null;
    // An unparseable date must never expire a pitch — treat unknown as active.
    const isPastRetention = expiresAt ? Date.parse(expiresAt) < Date.now() : false;
    const attemptsExhausted = attemptsUsed >= MAX_PITCH_ATTEMPTS;

    members.forEach((row, idx) => {
      out.set(Number(row.id), {
        pitchRootId: rootId,
        attemptNumber: row.attempt_number || idx + 1,
        attemptsUsed,
        attemptsRemaining: Math.max(0, MAX_PITCH_ATTEMPTS - attemptsUsed),
        maxAttempts: MAX_PITCH_ATTEMPTS,
        canStartNewAttempt: !attemptsExhausted && !isPastRetention,
        attemptsExhausted,
        isReportOnly: attemptsExhausted || isPastRetention,
        retentionExpiresAt: expiresAt,
        isPastRetention,
      });
    });
  }

  return out;
}

/**
 * Fetch the minimal chain columns for one user's sessions.
 *
 * Tries the indexed 0013 columns first and degrades to the pre-migration column
 * set when they don't exist yet, so the app works whichever order app and
 * migration are deployed in.
 */
async function fetchChainRows(userId: number): Promise<ChainRow[]> {
  const withNewCols =
    "id, parent_session_id, pitch_root_id, attempt_number, created_at, timestamp";
  const primary = await supabase
    .from("sessions")
    .select(withNewCols)
    .eq("user_id", userId);

  let rawData: any[] | null = (primary.data as any[]) || null;
  let queryError = primary.error;

  if (queryError && /column|schema/i.test(queryError.message || "")) {
    const fallback = await supabase
      .from("sessions")
      .select("id, parent_session_id, created_at, timestamp")
      .eq("user_id", userId);
    rawData = (fallback.data as any[]) || null;
    queryError = fallback.error;
  }

  if (queryError) {
    console.error("❌ fetchChainRows failed:", queryError.message);
    throw queryError;
  }
  return (rawData || []) as ChainRow[];
}


/**
 * Attempt state for one user, keyed by session id.
 *
 * One query per call. Callers that already hold the user's rows should use
 * computeAttemptStates directly instead.
 */
export async function loadAttemptStates(
  userId: number,
): Promise<Map<number, PitchAttemptState>> {
  try {
    return computeAttemptStates(await fetchChainRows(userId));
  } catch {
    return new Map();
  }
}

export interface AttemptClaim {
  allowed: boolean;
  /** Root of the chain the new attempt belongs to (0 when unknown). */
  pitchRootId: number;
  /** Position the new attempt will occupy if allowed. */
  attemptNumber: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  maxAttempts: number;
  reason?: "limit_reached" | "retention_expired";
}

/**
 * Decide whether a NEW live attempt may start.
 *
 * `parentSessionId` is the attempt being re-pitched (already ownership-verified
 * by the caller). A null parent means a brand-new pitch — always attempt 1, and
 * always allowed here; the weekly plan quota is a separate gate handled by
 * entitlementService.claimSessionSlot.
 *
 * FAILS OPEN on a database error. A transient Supabase failure must not lock a
 * paying founder out of practising; the same choice entitlementService already
 * makes for the weekly quota. The durable count is unaffected either way, so the
 * next attempt is re-checked against real data.
 */
export async function claimPitchAttempt(
  userId: number | null,
  parentSessionId: number | null,
): Promise<AttemptClaim> {
  const fresh: AttemptClaim = {
    allowed: true,
    pitchRootId: 0,
    attemptNumber: 1,
    attemptsUsed: 0,
    attemptsRemaining: MAX_PITCH_ATTEMPTS,
    maxAttempts: MAX_PITCH_ATTEMPTS,
  };

  if (!userId || !parentSessionId) return fresh;

  let states: Map<number, PitchAttemptState>;
  try {
    states = computeAttemptStates(await fetchChainRows(userId));
  } catch {
    return fresh; // fail open — see the doc comment.
  }

  const parentState = states.get(Number(parentSessionId));
  if (!parentState) return fresh; // parent not in this user's rows: treat as new.

  const rootId = parentState.pitchRootId;
  // Count live sessions already admitted for this chain, so two tabs opened at
  // the same moment cannot both slip past the ceiling.
  const inFlight = liveAttemptCount(rootId);
  const attemptsUsed = parentState.attemptsUsed;
  const projected = attemptsUsed + inFlight;

  const base = {
    pitchRootId: rootId,
    attemptNumber: projected + 1,
    attemptsUsed,
    attemptsRemaining: Math.max(0, MAX_PITCH_ATTEMPTS - attemptsUsed),
    maxAttempts: MAX_PITCH_ATTEMPTS,
  };

  if (projected >= MAX_PITCH_ATTEMPTS) {
    return { ...base, allowed: false, reason: "limit_reached" };
  }
  if (parentState.isPastRetention) {
    return { ...base, allowed: false, reason: "retention_expired" };
  }

  return { ...base, allowed: true };
}

/**
 * Resolve the (pitch_root_id, attempt_number) to stamp on a session row at
 * insert time.
 *
 * Called from end_session with the parent this attempt followed. A root attempt
 * cannot know its own id before the insert, so it stores NULL and the caller
 * patches pitch_root_id = id immediately afterwards (see restSocket).
 */
export function attemptStampFor(
  claim: AttemptClaim | null,
): { pitch_root_id: number | null; attempt_number: number } {
  if (!claim || !claim.pitchRootId) return { pitch_root_id: null, attempt_number: 1 };
  return {
    pitch_root_id: claim.pitchRootId,
    attempt_number: Math.max(1, claim.attemptNumber),
  };
}

/** Shape the frontend consumes. Kept flat and snake_case-free on purpose. */
export function serializeAttemptState(state: PitchAttemptState) {
  return {
    pitchRootId: state.pitchRootId,
    attemptNumber: state.attemptNumber,
    attemptsUsed: state.attemptsUsed,
    attemptsRemaining: state.attemptsRemaining,
    maxAttempts: state.maxAttempts,
    canStartNewAttempt: state.canStartNewAttempt,
    attemptsExhausted: state.attemptsExhausted,
    isReportOnly: state.isReportOnly,
    retentionExpiresAt: state.retentionExpiresAt,
    isPastRetention: state.isPastRetention,
  };
}
