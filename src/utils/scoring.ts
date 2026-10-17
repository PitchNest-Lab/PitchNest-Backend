// src/utils/scoring.ts
import { computeOverallScore } from "../services/aiService.ts";

/**
 * Overall score for a session, 0-100.
 *
 * THIS USED TO SUM THE FOUR CATEGORY SCORES AND CAP AT 100, which was wrong by
 * a factor the cap then hid. Each category is itself 0-100 — the evaluation
 * prompt instructs "Score each category (delivery, clarity, scalability,
 * readiness) as integers 0-100" and its worked example is 75/80/65/70 — so the
 * sum cleared 100 on essentially every real session and the cap returned
 * exactly 100 every time.
 *
 * Nothing downstream could tell. Every complete pitch scored a perfect 100, so
 * the organisation dashboard reported an average score of 100/100 with zero
 * improvement per founder, and pitchStatusFromSession called every session
 * "Excellent". A wrong number that is wrong the same way for everyone is the
 * hardest kind to notice, which is why this is now a delegation rather than a
 * second implementation.
 *
 * The mean is the correct reading of four 0-100 categories, and it is the
 * definition computeOverallScore already used in the PDF and the percentile.
 * Routing through it makes the two structurally unable to disagree.
 */
export const pitchScoreFromReport = (evaluation_report: any): number | null => {
  if (!evaluation_report?.scores) return null;
  const { clarity, delivery, readiness, scalability } = evaluation_report.scores;
  return computeOverallScore({
    // Number() before the arithmetic: these arrive from a JSONB column, and a
    // string "70" would otherwise concatenate into "8070..." rather than add.
    clarity: Number(clarity) || 0,
    delivery: Number(delivery) || 0,
    readiness: Number(readiness) || 0,
    scalability: Number(scalability) || 0,
  });
};

export const isCompletePitch = (session: any) =>
  session?.evaluation_report?.evaluationStatus === "complete";

/**
 * Readiness as a 0-100 score.
 *
 * This used to multiply readiness by 4, which is only correct if the category
 * is scored 0-25. It is scored 0-100, so every readiness of 25 or above
 * reported a flat 100 and anything below was overstated fourfold.
 */
export const readinessFromReport = (evaluation_report: any): number | null => {
  if (!evaluation_report?.scores) return null;
  return Math.min(100, Math.round(Number(evaluation_report.scores.readiness) || 0));
};

export const panelTypeLabel = (mode: string) =>
  mode === "panel" ? "VC Panel" : mode === "coach" ? "Practice Coach" : mode ?? "Session";

export const pitchStatusFromSession = (
  session: any
): "Incomplete" | "Needs Work" | "Good" | "Excellent" => {
  if (session?.evaluation_report?.evaluationStatus !== "complete") return "Incomplete";
  const score = pitchScoreFromReport(session.evaluation_report) ?? 0;
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  return "Needs Work";
};
