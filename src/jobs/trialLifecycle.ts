import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { sendTrialEmail, type TrialMilestone } from "../utils/sendTrialEmails.ts";
import { randomUUID } from "node:crypto";

/**
 * The trial lifecycle sweep — decides who gets a reminder email, claims the
 * milestone in trial_email_log, and sends.
 *
 * The web service runs this periodically, and runTrialLifecycle.ts exposes the
 * same idempotent sweep as a one-shot command for a managed scheduler. That
 * matters on hosts that suspend idle web instances between requests.
 *
 * WHAT MAKES IT SAFE TO RUN TWICE, OR ON TWO SERVERS AT ONCE
 *
 * The primary key still prevents two active owners, but a claim is now a
 * database lease instead of a permanent pre-send marker. A failed send releases
 * its own lease; an unfinished lease becomes recoverable after 30 minutes. The
 * provider also receives a stable idempotency key, covering the narrow crash
 * window between provider acceptance and the delivered_at database update.
 */

/** Plans that mean "this person has already paid" — never remind them. */
const PAID_PLANS = new Set(["prep", "pro", "founder", "enterprise"]);

/**
 * How far past its expiry date a trial is still worth an email about.
 *
 * This bound exists so the FIRST run after deploy does not mail every user whose
 * trial lapsed months ago. A trial that ended today is news; one that ended in
 * March is spam. Rather than marking those rows as "sent" (which would put a
 * false record in the log), the window simply excludes them — the log stays a
 * truthful record of emails that actually went out.
 */
const LOOKBEHIND_DAYS = 3;

/**
 * How far ahead the sweep looks. A trial is a candidate from a week out, which
 * is the first reminder, so anything beyond that has nothing to be told yet.
 */
const LOOKAHEAD_DAYS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * A short delay after boot, not zero: a cold start should get the HTTP listener
 * and the WebSocket path answering before a background query competes for the
 * first money of CPU.
 */
const FIRST_SWEEP_DELAY_MS = 90 * 1000;

export interface TrialSweepResult {
  candidates: number;
  sent: number;
  /** Already claimed by another run, or the trial is not in a reminder window. */
  skipped: number;
  failed: number;
}

/**
 * Which reminder this trial is due, or null for "nothing to say yet".
 *
 * The thresholds are checked TIGHTEST FIRST so that a sweep which missed a day
 * still sends the most urgent mail available rather than a stale one. The
 * milestone is a slot in the sequence, not a promise about the number in the
 * subject line — the copy is told the real day count, so a late run says "5 days
 * left" rather than "a week".
 */
export function reminderSlot(daysRemaining: number, expired: boolean): TrialMilestone | null {
  if (expired) return "expired";
  if (daysRemaining <= 1) return "t1";
  if (daysRemaining <= 3) return "t3";
  if (daysRemaining <= 7) return "t7";
  return null;
}

/**
 * How many live sessions this user ran DURING the trial, and what their most
 * recent completed one scored. Used only to make the email specific — "your last
 * session scored 64" is worth reading, "your trial is ending" is not.
 *
 * The window is bounded by the trial's own expiry date rather than counting the
 * user's sessions outright. The expiry email can go out up to three days after
 * the trial lapses, and a founder who used those days to run free sessions
 * should not be told those were part of the trial. The sentence has to be true
 * of the number in it.
 *
 * Two small queries per candidate rather than one large one: the alternative is
 * pulling every evaluation_report blob for every candidate to count them in
 * memory, and those blobs hold transcripts. At the scale this sweep runs at
 * (users whose trial expires inside an eleven-day band) the per-user queries are
 * cheap; if that ever stops being true, this becomes one grouped RPC.
 */
async function sessionFactsFor(
  userId: number,
  trialStartedAt: Date,
  trialExpiresAt: Date,
): Promise<{
  sessionCount: number;
  lastScore: number | null;
  lastSessionName: string | null;
}> {
  const cutoff = trialExpiresAt.toISOString();
  const start = trialStartedAt.toISOString();
  const [countResult, latestResult] = await Promise.all([
    supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", start)
      .lte("created_at", cutoff),
    supabase
      .from("sessions")
      .select("business_name, evaluation_report, created_at")
      .eq("user_id", userId)
      .gte("created_at", start)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (countResult.error) throw countResult.error;
  if (latestResult.error) throw latestResult.error;

  const sessionCount = countResult.count ?? 0;
  const latest = latestResult.data as any;
  const report = latest?.evaluation_report;
  const scores = report?.scores || {};
  const overall = Math.round(
    ((Number(scores.delivery) || 0) +
      (Number(scores.clarity) || 0) +
      (Number(scores.scalability) || 0) +
      (Number(scores.readiness) || 0)) /
      4,
  );

  return {
    sessionCount,
    // A session that never finished evaluating has no score worth quoting, and
    // quoting a 0 would read as a judgement rather than a gap.
    lastScore: report?.evaluationStatus === "complete" && overall > 0 ? overall : null,
    lastSessionName: typeof latest?.business_name === "string" ? latest.business_name : null,
  };
}

async function loadTrialCandidates(now: number): Promise<{ users: any[] | null; error: any }> {
  const users: any[] = [];
  const pageSize = 500;
  const earliest = new Date(now - LOOKBEHIND_DAYS * DAY_MS).toISOString();
  const latest = new Date(now + LOOKAHEAD_DAYS * DAY_MS).toISOString();
  for (let from = 0; from < 10_000; from += pageSize) {
    const result = await supabase
      .from("users")
      .select("id, email, name, plan, plan_expires_at, trial_started_at, trial_expires_at, trial_status, settings")
      .eq("trial_status", "active")
      .eq("isEmailVerified", true)
      .not("trial_expires_at", "is", null)
      .gte("trial_expires_at", earliest)
      .lte("trial_expires_at", latest)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) return { users: null, error: result.error };
    const page = result.data || [];
    users.push(...page);
    if (page.length < pageSize) return { users, error: null };
  }
  return {
    users: null,
    error: new Error("Trial lifecycle exceeded the 10,000-candidate safety limit."),
  };
}

/**
 * One pass. Exported so it can be run by hand (or by an admin route) — the
 * scheduler below is the only thing that calls it on a timer.
 */
export async function runTrialLifecycleSweep(): Promise<TrialSweepResult> {
  const result: TrialSweepResult = { candidates: 0, sent: 0, skipped: 0, failed: 0 };
  const now = Date.now();

  const { users, error } = await loadTrialCandidates(now);

  if (error) {
    // A missing table means migration 0016 has not been run. Say so once, in
    // words, rather than failing every six hours with a Postgres code.
    if (/relation|does not exist|schema cache/i.test(error.message || "")) {
      console.warn(
        "⚠️ Trial lifecycle sweep is disabled: trial_email_log is missing. " +
          "Run backend/migrations/0016_trial_email_log.sql to enable trial reminder emails.",
      );
      return result;
    }
    console.error("❌ Trial lifecycle sweep could not load candidates:", error.message);
    return result;
  }

  const candidates = (users || []) as any[];
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  for (const user of candidates) {
    const id = Number(user.id);
    const email = String(user.email || "").trim();
    if (!id || !email) {
      result.skipped++;
      continue;
    }

    // Account holders can opt out of lifecycle/upgrade mail in Settings. A
    // missing key preserves the existing default for accounts created before
    // this preference was introduced.
    if (user.settings?.notifications?.trialLifecycle === false) {
      result.skipped++;
      continue;
    }

    // Already paying. A "your trial is ending" mail to someone who has just
    // upgraded is the single most annoying thing this job could do.
    const planExpiry = user.plan_expires_at ? new Date(user.plan_expires_at).getTime() : null;
    const isPaying = PAID_PLANS.has(String(user.plan)) && (!planExpiry || planExpiry > now);
    if (isPaying) {
      result.skipped++;
      continue;
    }

    const expiry = new Date(user.trial_expires_at).getTime();
    const trialStart = new Date(user.trial_started_at).getTime();
    if (!Number.isFinite(expiry) || !Number.isFinite(trialStart) || trialStart > expiry) {
      result.skipped++;
      continue;
    }
    const expired = expiry <= now;
    const daysRemaining = Math.max(0, Math.ceil((expiry - now) / DAY_MS));

    const milestone = reminderSlot(daysRemaining, expired);
    if (!milestone) {
      result.skipped++;
      continue;
    }

    // Claim first. The RPC inserts a lease or takes over an abandoned unfinished
    // lease older than 30 minutes. A completed row is never reclaimed.
    const leaseId = randomUUID();
    const claim = await supabase.rpc("claim_trial_email", {
      p_user_id: id,
      p_milestone: milestone,
      p_lease_id: leaseId,
    });

    if (claim.error) {
      if (/relation|does not exist|schema cache/i.test(claim.error.message || "")) {
        console.warn(
          "⚠️ Trial lifecycle sweep stopped: its lease function is missing. " +
            "Run backend/migrations/0030_auth_and_erasure_hardening.sql.",
        );
        return result;
      }
      console.error(`❌ Could not claim trial milestone for user ${id}:`, claim.error.message);
      result.failed++;
      continue;
    }
    if (claim.data !== true) {
      result.skipped++;
      continue;
    }

    try {
      const facts = await sessionFactsFor(id, new Date(trialStart), new Date(expiry));
      await sendTrialEmail({
        userId: id,
        to: email,
        name: user.name || "",
        milestone,
        daysRemaining,
        sessionCount: facts.sessionCount,
        lastScore: facts.lastScore,
        lastSessionName: facts.lastSessionName,
      });
      const delivered = await supabase
        .from("trial_email_log")
        .update({ delivered_at: new Date().toISOString() })
        .eq("user_id", id)
        .eq("milestone", milestone)
        .eq("lease_id", leaseId)
        .is("delivered_at", null);
      if (delivered.error) throw delivered.error;
      result.sent++;

      // delivered_at is written only after provider acceptance. Failed sends
      // release their lease; a process crash leaves a lease another run can recover.
      if (expired) {
        const { error: expiryError } = await supabase
          .from("users")
          .update({ trial_status: "expired" })
          .eq("id", id);
        if (expiryError) {
          console.error(`❌ Trial status update failed for user ${id}:`, expiryError.message);
        }
      }
    } catch (err: any) {
      console.error(`❌ Trial ${milestone} email failed for user ${id}:`, err?.message || err);
      const { error: releaseError } = await supabase
        .from("trial_email_log")
        .delete()
        .eq("user_id", id)
        .eq("milestone", milestone)
        .eq("lease_id", leaseId)
        .is("delivered_at", null);
      if (releaseError) {
        console.error(`❌ Trial milestone release failed for user ${id}:`, releaseError.message);
      }
      result.failed++;
    }
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/**
 * Whether the background job runs at all.
 *
 * Fails CLOSED outside production: a developer running the backend locally
 * against the shared Supabase project would otherwise send real emails to real
 * founders from their laptop, and there is no way to take that back. Opt in with
 * TRIAL_JOBS_ENABLED=true when testing the job deliberately.
 */
function jobsEnabled(): boolean {
  const explicit = (process.env.TRIAL_JOBS_ENABLED || "").trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return config.nodeEnv === "production";
}

/** Idempotent — a second call is a no-op, so double-invocation at boot is safe. */
export function startTrialLifecycleJob(): void {
  if (timer || bootTimer) return;

  if (!jobsEnabled()) {
    console.log(
      "ℹ️ Trial lifecycle emails are off (set TRIAL_JOBS_ENABLED=true to run them here).",
    );
    return;
  }

  const run = async () => {
    if (inFlight) return; // a slow sweep must not stack on the next tick
    inFlight = true;
    try {
      const result = await runTrialLifecycleSweep();
      if (result.sent || result.failed) {
        console.log(
          `✉️  Trial lifecycle: ${result.sent} sent, ${result.failed} failed, ` +
            `${result.skipped} skipped of ${result.candidates} candidates.`,
        );
      }
    } catch (err: any) {
      // A background job that throws asynchronously would otherwise crash the
      // process — nothing awaits this.
      console.error("❌ Trial lifecycle sweep threw:", err?.message || err);
    } finally {
      inFlight = false;
    }
  };

  bootTimer = setTimeout(() => {
    bootTimer = null;
    void run();
    timer = setInterval(() => void run(), SWEEP_INTERVAL_MS);
    // Never keep the process alive on shutdown just for a reminder email.
    (timer as any).unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  (bootTimer as any).unref?.();

  console.log("⏳ Trial lifecycle emails scheduled (first sweep in 90s, then every 6h).");
}
