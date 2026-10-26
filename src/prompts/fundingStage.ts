/**
 * The founder's funding stage, read the same way by every AI prompt: the live
 * panel, the coach, the structured pitch memory and the report.
 *
 * The stage arrives as free text. The setup form offers "Idea / Bootstrap",
 * "Pre-Seed", "Seed" and "Series A+", and a linked business profile can carry
 * anything ("MVP", "Pre-seed", "Early revenue"). Each prompt used to parse it
 * with its own pattern, and the live prompt's pattern matched any text ending
 * in "seed": Pre-Seed and Seed founders were told they were operating companies
 * whose revenue was expected, so the panel and the coach pressed every early
 * founder for traction. One classifier and one description per stage keep the
 * panel, the coach and the scorer judging a founder by the same bar.
 */
import { inlinePromptFragment } from "../utils/aiTextSanitizer.ts";

export type StageBand = "idea" | "pre_seed" | "seed" | "growth";

/**
 * Unknown or empty text reads as pre-seed (nothing expected yet), never as a
 * selling company. "Pre-" forms are checked before the words they contain.
 */
export function classifyFundingStage(raw: unknown): StageBand {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/pre[-\s]?launch/.test(s)) return "idea";
  if (/pre[-\s]?(?:seed|revenue)/.test(s)) return "pre_seed";
  if (/\bseries\s*[a-z]\b|growth|scale|expansion|late[-\s]?stage/.test(s)) return "growth";
  if (/idea|bootstrap|concept|prototype|\bmvp\b/.test(s)) return "idea";
  if (/seed|revenue|traction|pilot/.test(s)) return "seed";
  return "pre_seed";
}

export function isEarlyStage(band: StageBand): boolean {
  return band === "idea" || band === "pre_seed";
}

const STAGES: Record<StageBand, { name: string; fair: string; notYet: string }> = {
  idea: {
    name: "idea stage",
    fair:
      "a real problem, a clear picture of who has it, a solution that makes sense, why this founder, and a sensible plan for what comes next",
    notYet:
      "revenue, users, customers, pilots, traction, retention, unit economics, financial projections, a cap table or a valuation",
  },
  pre_seed: {
    name: "pre-seed",
    fair:
      "a real problem, a clear target customer, a solution that makes sense, why this founder, a reasonable idea of how it will make money, and a plan to reach the first customers. Early learning such as customer conversations, a prototype or a waitlist is a bonus, never a requirement",
    notYet:
      "revenue, paying customers, traction, retention, unit economics, detailed financials, a cap table or a valuation defence",
  },
  seed: {
    name: "seed",
    fair:
      "early signs that people want this (first users or customers, pilots, letters of intent, a waitlist with real names), sensible pricing logic and a plan to grow. Estimates and early numbers are fine",
    notYet: "scaled revenue, proven unit economics or Series A metrics",
  },
  growth: {
    name: "Series A or later",
    fair: "real numbers: revenue, growth rate, retention, unit economics and a clear plan for the money",
    notYet: "",
  },
};

export function stageName(fundingStage: unknown): string {
  return STAGES[classifyFundingStage(fundingStage)].name;
}

/** The live panel's and the coach's stage block. */
export function buildStageDirective(fundingStage: unknown): string {
  const band = classifyFundingStage(fundingStage);
  const stage = STAGES[band];
  const stated = inlinePromptFragment(fundingStage, 60) || "not specified";
  if (band === "growth") {
    return `FOUNDER'S STAGE: ${stage.name} (stated as "${stated}").
- This founder is raising as an operating company, so ${stage.fair} are expected. Ask for them plainly and do not accept a story in place of a number.
- Judge the numbers fairly: a weak number is something to discuss, not a reason to stop listening.`;
  }
  return `FOUNDER'S STAGE: ${stage.name} (stated as "${stated}"). This sets what you may expect in every question, reaction and judgment.
- Fair to expect at this stage: ${stage.fair}.
- NOT expected at this stage: ${stage.notYet}. Never ask for these as if they should already exist, and never count their absence against the founder. If the founder brings one up, engage with what they say.
- An honest "we haven't tested that yet" or "we don't have that number yet", with a sensible way to find out, is a GOOD answer at this stage.`;
}

/** One line for every report section, so advice targets the right milestone. */
export function buildStageReportLine(fundingStage: unknown): string {
  const band = classifyFundingStage(fundingStage);
  const stage = STAGES[band];
  if (band === "growth") {
    return `- FOUNDER'S STAGE: ${stage.name}. Real traction is expected (${stage.fair}); do not accept narrative in place of numbers, but judge the numbers given fairly.`;
  }
  return `- FOUNDER'S STAGE: ${stage.name}. Fair to expect: ${stage.fair}. Not expected yet: ${stage.notYet}. Keep every judgment and recommendation to what matters at this stage: never tell an early-stage founder to "get revenue" or "prove traction"; point to the right next milestone instead.`;
}
