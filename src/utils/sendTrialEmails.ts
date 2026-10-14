import { Resend } from "resend";
import { config } from "../config/env.ts";

/**
 * The trial reminder emails.
 *
 * WHAT THESE ARE FOR. The trial grants full Pro access for 30 days and then
 * quietly lapses: on day 31 the founder loses the PDF and the longer pitch
 * durations, and until now nothing told them. These four emails are the
 * replacement — one a week out, one at three days, one the day before, and one
 * after it ends.
 *
 * THE TONE IS THE DESIGN. The market is Africa-first and the constraint is that
 * product quality outranks conversion pressure, so these are written to inform
 * rather than to create urgency:
 *   • No countdown theatre, no "last chance", no fake scarcity.
 *   • No price. Prices are env-configurable and served live to the pricing page;
 *     a number baked into an email is a number that will eventually contradict
 *     the site — the exact class of mismatch this codebase just spent effort
 *     removing. The mail links to /pricing and lets the page state the price.
 *   • Every mail says plainly what the founder KEEPS. Their sessions, scores,
 *     transcripts and shared links are theirs, and the free tier still runs two
 *     sessions a week. Nobody's past work is held hostage.
 *
 * Deliberately NOT here: anything that runs on a schedule. This file renders and
 * sends one email. The sweep that decides who gets one is jobs/trialLifecycle.ts.
 */

export type TrialMilestone = "t7" | "t3" | "t1" | "expired";

export interface TrialEmailInput {
  to: string;
  /** Founder's own name. Escaped before it reaches the HTML. */
  name: string;
  milestone: TrialMilestone;
  /**
   * Days left when the mail was composed. The milestone says which reminder in
   * the sequence this is; this is what the copy actually states, so a sweep that
   * ran late says "5 days left" instead of "a week".
   */
  daysRemaining: number;
  /** Live sessions they actually ran during the trial, for a specific opener. */
  sessionCount: number;
  /** Most recent completed session's overall score, or null if there isn't one. */
  lastScore: number | null;
  /** Business name of that session, so the email can name something real. */
  lastSessionName: string | null;
}

const resend = config.resendApiKey && config.resendApiKey !== "re_xxxxxxxxx"
  ? new Resend(config.resendApiKey)
  : null;

/** The name is user-controlled and lands in an HTML email — escape it. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Subject and headline both state the REAL day count, so a late or early sweep
 * can never promise a date it isn't actually at. "Tomorrow" only appears when
 * there really is one day left.
 */
function timePhrase(daysRemaining: number): { subject: string; headline: string } {
  if (daysRemaining <= 0) {
    return {
      subject: "Your PitchNest trial has ended",
      headline: "Your trial has ended",
    };
  }
  if (daysRemaining === 1) {
    return {
      subject: "Your PitchNest trial ends tomorrow",
      headline: "A day left of full access",
    };
  }
  return {
    subject: `${daysRemaining} days left on your PitchNest trial`,
    headline: `${daysRemaining} days left of full access`,
  };
}

const EXPIRED_EMAIL = {
  subject: "Your trial has ended — your reports are still here",
  headline: "Your trial has ended",
};

/**
 * What changes, stated exactly and without spin. These lines are the entitlement
 * matrix in prose — two sessions a week, ten minutes each, the score and the
 * risks on screen but not the written action plan, and no PDF. If
 * entitlementService or the report's paywall boundary changes, this paragraph is
 * wrong and must change with it: it is the only place in the product where the
 * tiers are described to someone who is not looking at the pricing page.
 */
function whatsChanging(milestone: TrialMilestone): string {
  const kept =
    "Every readiness report stays readable on screen — the score, the radar, your strengths and your risks.";
  const lost =
    "The downloadable PDF, the 20-to-40-minute pitches, the written action plan and the live market research in the panel are the Pro features that";
  if (milestone === "expired") {
    return `Sessions are now on the free plan: two a week, ten minutes each. ${kept} ${lost} have switched off.`;
  }
  return `When it ends, sessions move to the free plan: two a week, ten minutes each. ${kept} ${lost} will switch off.`;
}

/** A specific opener beats a generic one, and we have the data to be specific. */
function opener(input: TrialEmailInput): string {
  const { sessionCount, lastScore, lastSessionName } = input;
  if (sessionCount <= 0) {
    return "You haven't run a live session yet. The panel is the part that's hard to imagine from the outside — ten minutes in the room tells you more than any amount of reading about it.";
  }
  const ran = `You ran ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"} in your trial.`;
  if (lastScore === null) {
    // Sessions exist but none produced a score — do not invent one, and do not
    // let a 0 stand in for "not assessed".
    return ran;
  }
  const named = lastSessionName ? ` — ${lastSessionName} —` : "";
  return `${ran} The most recent one${named} scored ${lastScore}.`;
}

/**
 * There is no unsubscribe link, and that is a decision rather than an omission.
 * These are four account emails over the life of a trial, not a marketing list,
 * and the settings screen's notification toggles are currently inert — pointing
 * at them would imply an opt-out that does not exist. If the toggles are ever
 * wired up (see the retention work), this footer is where the link goes, and the
 * sweep must read the toggle before claiming a milestone.
 */
function footer(milestone: TrialMilestone): string {
  return milestone === "expired"
    ? "You're receiving this because you have a PitchNest account. This is the last trial email."
    : "You're receiving this because you have a PitchNest account. At most two more will follow before the trial ends.";
}

export async function sendTrialEmail(input: TrialEmailInput): Promise<void> {
  const { to, name, milestone, daysRemaining } = input;
  const safeName = escapeHtml((name || "").trim() || "there");
  const pricingUrl = `${config.clientUrl}/pricing`;
  const { subject, headline } =
    milestone === "expired" ? EXPIRED_EMAIL : timePhrase(daysRemaining);

  if (!resend) {
    throw new Error(
      "Mail is not configured (RESEND_API_KEY is missing or still set to re_xxxxxxxxx). " +
        "Trial reminders cannot send until the backend environment has a real key.",
    );
  }

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:16px;background:#fff">
      <h2 style="color:#111827;font-size:22px;margin:0 0 16px">${headline}</h2>
      <p style="color:#4b5563;font-size:16px;line-height:24px;margin:0 0 16px">Hi ${safeName},</p>
      <p style="color:#4b5563;font-size:16px;line-height:24px;margin:0 0 16px">
        ${escapeHtml(opener(input))}
      </p>
      <p style="color:#4b5563;font-size:16px;line-height:24px;margin:0 0 16px">
        ${escapeHtml(whatsChanging(milestone))}
      </p>
      <p style="color:#4b5563;font-size:16px;line-height:24px;margin:0 0 24px">
        Nothing you have already made goes away. Every past session stays in your archive with its
        transcript and report, and any link you have shared keeps working.
      </p>
      <div style="text-align:center;margin-bottom:24px">
        <a href="${pricingUrl}"
           style="display:inline-block;padding:14px 28px;background:#0284c7;color:#fff;
                  border-radius:12px;text-decoration:none;font-weight:700;font-size:16px">
          See the plans →
        </a>
      </div>
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />
      <p style="color:#9ca3af;font-size:12px;line-height:18px;text-align:center;margin:0">
        ${footer(milestone)}
      </p>
    </div>
  `;

  const { error } = await resend.emails.send({
    from: config.emailFrom,
    replyTo: config.emailReplyTo,
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(error.message);
  }
}
