// Persona tone guardrails. Builds the live system prompt for every investor
// archetype at every toughness band (and coach mode) and checks that:
//   - the fair-challenge rules ride along at every level,
//   - none of the retired harsh directives come back,
//   - walk-out ("I'm out") only unlocks where intended,
//   - coach mode never inherits the top panel tone,
//   - bad slider input falls back to the realistic default.
// Deterministic — no model calls. Run: npx tsx src/tests/persona_tone_test.ts
import {
  getMasterPrompt,
  PERSONA_PROFILES,
  FAIR_CHALLENGE_RULES,
  SCORING_CALIBRATION,
  DEFAULT_AGGRESSIVENESS,
  clampSlider,
  computeOverallScore,
} from "../services/aiService.ts";
import { DECLARE_OUT_MIN } from "../prompts/investorPlaybook.ts";
import { splitVerdictsBySpeaker } from "../utils/verdictSplit.ts";
import { pitchScoreFromReport, readinessFromReport, pitchStatusFromSession } from "../utils/scoring.ts";

let failures = 0;
function assert(condition: boolean, msg: string) {
  if (!condition) {
    failures++;
    console.error(`❌ Assertion failed: ${msg}`);
  } else {
    console.log(`✅ Passed: ${msg}`);
  }
}

// Phrases that made the panel read as hostile. Any of these reappearing in a
// built prompt is a regression.
const RETIRED_PHRASES = [
  "EXTREMELY DEMANDING",
  "low patience",
  "interject after ~15 seconds",
  "lead/skeptic",
  "a little harsh",
  "combative",
  "visibly lose patience",
  "is never accepted",
  "Belief is not a filing",
  "Prioritize probing",
  "Push hard",
];

const ARCHETYPES = Object.keys(PERSONA_PROFILES);
const LEVELS = [0, 30, 50, 70, 84, 85, 100];

const baseConfig = (archetype: string, aggressiveness: number) => ({
  description: "Mobile-money savings app for market traders",
  industry: "Fintech",
  fundingStage: "Seed",
  investorArchetype: archetype,
  aggressiveness,
  riskAppetite: 60,
});

console.log("\n🧪 Running persona tone guardrail tests...\n");

let built = 0;
let retiredHits: string[] = [];
let missingFairRules: string[] = [];
let walkOutLeaks: string[] = [];

for (const archetype of ARCHETYPES) {
  for (const level of LEVELS) {
    for (const isCoach of [false, true]) {
      const prompt = getMasterPrompt(isCoach, "TraderSave", baseConfig(archetype, level));
      built++;
      const tag = `${archetype} @${level}${isCoach ? " (coach)" : ""}`;

      for (const phrase of RETIRED_PHRASES) {
        if (prompt.includes(phrase)) retiredHits.push(`${tag}: "${phrase}"`);
      }
      if (!prompt.includes(FAIR_CHALLENGE_RULES)) missingFairRules.push(tag);

      const canDeclareOut = prompt.includes("DECLARING OUT:");
      const shouldDeclareOut =
        !isCoach && (level >= DECLARE_OUT_MIN || archetype === "Shark Tank Judge");
      if (canDeclareOut !== shouldDeclareOut) walkOutLeaks.push(`${tag}: declareOut=${canDeclareOut}`);
    }
  }
}

assert(built === ARCHETYPES.length * LEVELS.length * 2, `Built ${built} prompts across ${ARCHETYPES.length} personas`);
assert(retiredHits.length === 0, `No retired harsh phrases in any prompt${retiredHits.length ? ` — ${retiredHits.slice(0, 3).join("; ")}` : ""}`);
assert(missingFairRules.length === 0, `Fair-challenge rules present at every level and persona${missingFairRules.length ? ` — missing: ${missingFairRules.slice(0, 3).join("; ")}` : ""}`);
assert(walkOutLeaks.length === 0, `"I'm out" only unlocked at ${DECLARE_OUT_MIN}+ or Shark Tank${walkOutLeaks.length ? ` — ${walkOutLeaks.slice(0, 3).join("; ")}` : ""}`);

// Coach mode is capped below the top tiers even when the slider is maxed.
const coachMax = getMasterPrompt(true, "TraderSave", baseConfig("Seed Stage - Venture Capital", 100));
assert(!coachMax.includes("DEMANDING BUT FAIR") && !coachMax.includes("TONE: CHALLENGING"), "Coach at 100 never gets the demanding/challenging panel tone");
assert(coachMax.includes("REALISTIC & CONSTRUCTIVE"), "Coach at 100 is capped at the realistic tier");

// Panel still honours the slider — toughness is softened, not removed.
const panelMax = getMasterPrompt(false, "TraderSave", baseConfig("Seed Stage - Venture Capital", 100));
assert(panelMax.includes("DEMANDING BUT FAIR"), "Panel at 100 is still demanding (high bar kept)");
const panelLow = getMasterPrompt(false, "TraderSave", baseConfig("Seed Stage - Venture Capital", 10));
assert(panelLow.includes("FRIENDLY / COACHING"), "Panel at 10 is friendly");

// Slider input hygiene.
assert(clampSlider(undefined, DEFAULT_AGGRESSIVENESS) === DEFAULT_AGGRESSIVENESS, "Missing slider falls back to default");
assert(clampSlider("abc", DEFAULT_AGGRESSIVENESS) === DEFAULT_AGGRESSIVENESS, "Non-numeric slider falls back to default");
assert(clampSlider(null, DEFAULT_AGGRESSIVENESS) === DEFAULT_AGGRESSIVENESS, "Null slider falls back to default");
assert(clampSlider(250, DEFAULT_AGGRESSIVENESS) === 100, "Slider clamped to 100");
assert(clampSlider(-5, DEFAULT_AGGRESSIVENESS) === 0, "Slider clamped to 0");
const noSlider = getMasterPrompt(false, "TraderSave", { ...baseConfig("Seed Stage - Venture Capital", 0), aggressiveness: undefined });
assert(noSlider.includes("REALISTIC & CONSTRUCTIVE"), "No slider value → realistic, constructive panel");

// Scoring anchors exist and bracket the benchmark average.
assert(SCORING_CALIBRATION.includes("41-60"), "Scoring calibration defines the typical-pitch band");

// Verdict splitting — a panelist mentioning a colleague must not truncate the
// verdict or hand half of it to the colleague.
const NAMES = ["Marcus", "Sarah", "Chen"];
const v1 = splitVerdictsBySpeaker(
  "Marcus: I agree with Sarah that margins are thin, but the traction is real — I'm in.\nSarah: I'm out because the CAC never got a number.\nChen: I'm in, provided Chen's team — sorry, your team — ships the API.",
  NAMES,
);
assert(v1.get("Marcus")?.endsWith("I'm in.") === true, "Mentioning Sarah mid-verdict does not cut Marcus's verdict");
assert(v1.get("Sarah") === "I'm out because the CAC never got a number.", "Sarah's verdict is exactly her own line");
assert(v1.get("Chen")?.startsWith("I'm in, provided") === true, "Chen's verdict survives a self-mention");
const v2 = splitVerdictsBySpeaker("Marcus: Strong story, I'm in. Sarah: On the fence until I see margins. Chen: I'm out — too early technically.", NAMES);
assert(v2.size === 3 && v2.get("Sarah") === "On the fence until I see margins.", "Verdicts on a single line split at sentence boundaries");
const v3 = splitVerdictsBySpeaker("**Marcus:** I'm in.\n**Sarah:** I'm in too.", NAMES);
assert(v3.get("Marcus") === "I'm in." && !v3.has("Chen"), "Markdown-bold prefixes handled; missing panelist absent");
const v4 = splitVerdictsBySpeaker("Marcus — I'm in, strong team. Sarah — I'm out on margins. Chen — I'm in.", NAMES);
assert(v4.size === 3 && v4.get("Sarah")?.includes("I'm out") === true, "No colons at all → legacy loose split still yields verdicts");

// Org dashboard scoring must match the report's overall score (mean of four
// 0-100 categories). It used to SUM them capped at 100, so weak pitches showed
// as 100 / "Excellent".
const weak = { scores: { delivery: 30, clarity: 30, scalability: 25, readiness: 20 }, evaluationStatus: "complete" };
assert(pitchScoreFromReport(weak) === computeOverallScore(weak.scores), "Org dashboard score equals the report's overall score");
assert(pitchScoreFromReport(weak) === 26, "Weak pitch scores 26, not 100");
assert(readinessFromReport(weak) === 20, "Readiness is reported on its own 0-100 scale");
assert(pitchStatusFromSession({ evaluation_report: weak }) === "Needs Work", "Weak pitch is 'Needs Work', not 'Excellent'");
assert(pitchStatusFromSession({ evaluation_report: { ...weak, scores: { delivery: 85, clarity: 82, scalability: 80, readiness: 81 } } }) === "Excellent", "Strong pitch is 'Excellent'");
assert(pitchScoreFromReport({}) === null, "Missing scores → null");

if (failures > 0) {
  console.error(`\n💥 ${failures} persona tone assertion(s) failed.`);
  process.exit(1);
}
console.log("\n🎉 Persona tone guardrails PASSED.\n");
