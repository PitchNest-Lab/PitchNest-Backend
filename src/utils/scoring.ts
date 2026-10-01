// src/utils/scoring.ts
export const pitchScoreFromReport = (evaluation_report: any): number | null => {
  if (!evaluation_report?.scores) return null;
  const { clarity = 0, delivery = 0, readiness = 0, scalability = 0 } = evaluation_report.scores;
  return Math.min(100, Math.round(clarity + delivery + readiness + scalability));
};

export const isCompletePitch = (session: any) =>
  session?.evaluation_report?.evaluationStatus === "complete";

export const readinessFromReport = (evaluation_report: any): number | null => {
  if (!evaluation_report?.scores) return null;
  return Math.min(100, Math.round((evaluation_report.scores.readiness ?? 0) * 4));
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