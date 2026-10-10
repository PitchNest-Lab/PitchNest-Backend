import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../config/env.ts";

/**
 * Server-side authority for Live Pitch session continuation ("resume").
 *
 * WHY. `client_ready` used to skip BOTH the weekly quota claim and the
 * per-pitch attempt claim whenever the client sent `resume: true` — a flag any
 * client can set — so a free user could run unlimited sessions. A resume is
 * now honoured only when it continues a session the server itself admitted
 * (quota + attempt already claimed), for the same user, before that session's
 * time ran out, and that has not already ended. Anything else is treated as a
 * NEW session and goes through the normal claims.
 *
 * Two ways a reconnect proves which session it continues:
 *   1. A signed resume token (typ:"resume") issued at admission and sent to
 *      the client as a `session_grant` message. Works across processes/tasks.
 *   2. Fallback for clients that do not send a token yet: the user's most
 *      recent un-ended session admitted by THIS process (in-memory registry).
 *      This is what keeps today's web client — which reconnects after a page
 *      refresh with `resume: true` but no token — working without spending a
 *      second quota slot.
 *
 * A resumed connection never gets more time than the original admission had
 * left (deadline is fixed at admission), and only one live connection may hold
 * a grant at a time (a newer resume displaces the older socket).
 *
 * Limits (documented in docs/security/phase-0-remediation.md): the "ended"
 * flag and the single-connection rule are per process. With several Live Pitch
 * processes, a token presented to a process that did not admit the session is
 * accepted on signature + deadline alone. Durable single-use needs a DB column
 * (proposed, not applied).
 */

/** How long after the session deadline a reconnect is still accepted (wrap-up/evaluation). */
export const RESUME_GRACE_MS = 10 * 60 * 1000;

export interface AttemptStamp {
  pitchRootId: number;
  attemptNumber: number;
}

export interface LiveSessionGrant {
  sid: string;
  userId: number;
  /** Attempt position claimed at admission, so a resumed session stamps the same row position. */
  attempt: AttemptStamp | null;
  grantedMinutes: number;
  /** Epoch ms when the admitted session's time runs out. Never extended by a resume. */
  deadlineMs: number;
}

interface Entry {
  grant: LiveSessionGrant;
  ended: boolean;
  /** Opaque handle of the connection currently holding the grant. */
  holder: unknown | null;
}

const registry = new Map<string, Entry>();
const latestByUser = new Map<number, string>();

function expiresAt(grant: LiveSessionGrant): number {
  return grant.deadlineMs + RESUME_GRACE_MS;
}

function prune(now: number): void {
  for (const [sid, entry] of registry) {
    if (now > expiresAt(entry.grant)) {
      registry.delete(sid);
      if (latestByUser.get(entry.grant.userId) === sid) latestByUser.delete(entry.grant.userId);
    }
  }
}

function signResumeToken(grant: LiveSessionGrant): string {
  return jwt.sign(
    {
      typ: "resume",
      sid: grant.sid,
      uid: grant.userId,
      att: grant.attempt ? [grant.attempt.pitchRootId, grant.attempt.attemptNumber] : null,
      min: grant.grantedMinutes,
      dl: grant.deadlineMs,
    },
    config.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: Math.max(1, Math.ceil((expiresAt(grant) - Date.now()) / 1000)),
    },
  );
}

function verifyResumeToken(token: unknown, userId: number): LiveSessionGrant | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const c = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as any;
    if (!c || c.typ !== "resume" || c.uid !== userId || typeof c.sid !== "string") return null;
    if (typeof c.dl !== "number" || typeof c.min !== "number") return null;
    const att =
      Array.isArray(c.att) && c.att.length === 2 && c.att.every((n: unknown) => Number.isInteger(n))
        ? { pitchRootId: c.att[0], attemptNumber: c.att[1] }
        : null;
    return { sid: c.sid, userId, attempt: att, grantedMinutes: c.min, deadlineMs: c.dl };
  } catch {
    return null;
  }
}

/**
 * Records a freshly ADMITTED session (after quota and attempt claims passed)
 * and returns the resume token to hand to the client.
 */
export function issueGrant(params: {
  userId: number;
  attempt: AttemptStamp | null;
  grantedMinutes: number;
  now?: number;
}): { grant: LiveSessionGrant; resumeToken: string } {
  const now = params.now ?? Date.now();
  prune(now);
  const grant: LiveSessionGrant = {
    sid: crypto.randomUUID(),
    userId: params.userId,
    attempt: params.attempt && params.attempt.pitchRootId ? params.attempt : null,
    grantedMinutes: params.grantedMinutes,
    deadlineMs: now + params.grantedMinutes * 60 * 1000,
  };
  registry.set(grant.sid, { grant, ended: false, holder: null });
  latestByUser.set(grant.userId, grant.sid);
  return { grant, resumeToken: signResumeToken(grant) };
}

export type ResumeResolution =
  | { ok: true; grant: LiveSessionGrant; source: "token" | "registry" }
  | { ok: false; reason: "no_active_session" | "invalid_token" | "ended" | "expired" };

/** Decides whether a `resume: true` handshake continues a server-admitted session. */
export function resolveResume(params: {
  userId: number;
  resumeToken?: unknown;
  now?: number;
}): ResumeResolution {
  const now = params.now ?? Date.now();
  prune(now);

  if (params.resumeToken !== undefined && params.resumeToken !== null && params.resumeToken !== "") {
    const grant = verifyResumeToken(params.resumeToken, params.userId);
    if (!grant) return { ok: false, reason: "invalid_token" };
    if (now > expiresAt(grant)) return { ok: false, reason: "expired" };
    const entry = registry.get(grant.sid);
    if (entry?.ended) return { ok: false, reason: "ended" };
    if (!entry) {
      // Admitted by another process (or before a restart): trust the signature.
      registry.set(grant.sid, { grant, ended: false, holder: null });
      latestByUser.set(grant.userId, grant.sid);
    }
    return { ok: true, grant: registry.get(grant.sid)!.grant, source: "token" };
  }

  const sid = latestByUser.get(params.userId);
  const entry = sid ? registry.get(sid) : undefined;
  if (!entry) return { ok: false, reason: "no_active_session" };
  if (entry.ended) return { ok: false, reason: "ended" };
  if (now > expiresAt(entry.grant)) return { ok: false, reason: "expired" };
  return { ok: true, grant: entry.grant, source: "registry" };
}

/**
 * Binds a connection to a grant. Returns the connection that previously held
 * it (if any and different) so the caller can close it — one live socket per
 * admitted session.
 */
export function attachConnection(sid: string, holder: unknown): unknown | null {
  const entry = registry.get(sid);
  if (!entry) return null;
  const previous = entry.holder && entry.holder !== holder ? entry.holder : null;
  entry.holder = holder;
  return previous;
}

/** Releases the grant's connection slot (socket closed). The grant stays resumable. */
export function detachConnection(sid: string, holder: unknown): void {
  const entry = registry.get(sid);
  if (entry && entry.holder === holder) entry.holder = null;
}

/** The session produced its report; it can never be resumed again. */
export function markGrantEnded(sid: string): void {
  const entry = registry.get(sid);
  if (entry) {
    entry.ended = true;
    entry.holder = null;
  }
}

/** Seconds left on the admitted session's clock (never negative). */
export function remainingSeconds(grant: LiveSessionGrant, now: number = Date.now()): number {
  return Math.max(0, Math.floor((grant.deadlineMs - now) / 1000));
}

export function resumeTokenFor(grant: LiveSessionGrant): string {
  return signResumeToken(grant);
}

/** Test hook: forget all grants. */
export function __resetGrantsForTests(): void {
  registry.clear();
  latestByUser.clear();
}
