import { WebSocket } from "ws";

// ── Resume grants ──────────────────────────────────────────────────────────
// A client "resume" rejoins a session that was already admitted and metered,
// so it skips the attempt and quota gates. The CLIENT's word is not enough for
// that: a hand-built client_ready with resume:true would otherwise get
// unlimited free sessions. The server issues a grant when a fresh session
// passes the gates, and only a resume backed by a live grant skips them.
//
// A grant is bounded by the original session's deadline plus a short grace
// period, and is held by one connection at a time: a resume takes it over and
// closes any older connection still holding it, so one paid slot cannot run in
// two tabs. A resume without a grant (or after a server restart) is admitted as
// a new session through the normal gates.
export const RESUME_GRACE_MS = 10 * 60 * 1000;

/** The minimal socket surface a grant needs (lets tests pass a stub). */
export type GrantHolder = Pick<WebSocket, "readyState" | "close">;

/**
 * Server-derived session context that must survive a reconnect. The practice
 * draft is single-use, so a resumed connection cannot re-consume it; the link
 * and question ride on the grant instead of being trusted from the client.
 */
export interface ResumeContext {
  businessId: string | null;
  practiceQuestion: string | null;
  /** Server-recorded transcript; the reconnecting browser may not replace it. */
  transcript?: Array<Record<string, unknown>>;
}

export interface ResumeGrant {
  deadlineAt: number;
  expiresAt: number;
  holder: GrantHolder | null;
  context: ResumeContext | null;
}

const resumeGrants = new Map<number, ResumeGrant>();

export function issueResumeGrant(
  userId: number,
  durationSeconds: number,
  holder: GrantHolder | null,
  now = Date.now(),
  context: ResumeContext | null = null,
): ResumeGrant {
  const deadlineAt = now + Math.max(0, durationSeconds) * 1000;
  const grant: ResumeGrant = {
    deadlineAt,
    expiresAt: deadlineAt + RESUME_GRACE_MS,
    holder,
    context,
  };
  resumeGrants.set(userId, grant);
  return grant;
}

/** Hands the user's live grant to this connection for a resume, or null. */
export function takeResumeGrant(
  userId: number,
  ws: GrantHolder,
  now = Date.now(),
): ResumeGrant | null {
  const grant = resumeGrants.get(userId);
  if (!grant) return null;
  if (now >= grant.expiresAt) {
    resumeGrants.delete(userId);
    return null;
  }
  const previous = grant.holder;
  grant.holder = ws;
  if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
    try {
      previous.close(4007, "Session resumed in another window");
    } catch {
      // Already closing.
    }
  }
  return grant;
}

/** Seconds a resumed session may still run, never past the original deadline. */
export function resumeSecondsRemaining(grant: ResumeGrant, now = Date.now()): number {
  return Math.max(0, Math.floor((grant.deadlineAt - now) / 1000));
}

/** Called on socket close: the grant survives for a reconnect, unheld. */
export function releaseResumeGrantHolder(userId: number, ws: GrantHolder) {
  const grant = resumeGrants.get(userId);
  if (grant && grant.holder === ws) grant.holder = null;
}

/** Called when a session ends normally: nothing is left to resume. */
export function revokeResumeGrant(userId: number, ws: GrantHolder) {
  const grant = resumeGrants.get(userId);
  if (grant && (grant.holder === ws || grant.holder === null)) resumeGrants.delete(userId);
}

/** Session modes the server knows how to run. Anything else becomes panel. */
export function normalizeSessionMode(value: unknown): "panel" | "coach" | "solo" {
  return value === "coach" || value === "solo" ? value : "panel";
}

/** Test-only: clear all grants. */
export function resetResumeGrantsForTests() {
  resumeGrants.clear();
}
