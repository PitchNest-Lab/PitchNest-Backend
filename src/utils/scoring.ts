// src/utils/scoring.ts
const clamp100 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
};

// Each category is scored 0-100 by the evaluator, so the overall score is their
// MEAN — the same definition as computeOverallScore() in aiService.ts and the
// PDF report. (Summing them capped almost every pitch at 100.)
export const pitchScoreFromReport = (evaluation_report: any): number | null => {
  if (!evaluation_report?.scores) return null;
  const { clarity, delivery, readiness, scalability } = evaluation_report.scores;
  return Math.round(
    (clamp100(clarity) + clamp100(delivery) + clamp100(readiness) + clamp100(scalability)) / 4,
  );
};

export const isCompletePitch = (session: any) =>
  session?.evaluation_report?.evaluationStatus === "complete";

export const readinessFromReport = (evaluation_report: any): number | null => {
  if (!evaluation_report?.scores) return null;
  // Readiness is already a 0-100 score.
  return Math.round(clamp100(evaluation_report.scores.readiness));
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