import {
  createPitchSessionState,
  analyzeTemporalExpressions,
  verifyMathematicalConsistency,
  updatePitchMemory,
  recordAskedQuestion,
  recordQuestionAnswered,
  buildPitchMemoryPromptBlock,
} from "../services/pitchMemoryService.ts";
import {
  parseDeckIntoSlides,
  inferActiveSlide,
  buildStructuredDeckContextBlock,
} from "../services/deckIntelligenceService.ts";
import {
  isTrialActive,
  entitlementsForPlan,
  getTrialEntitlement,
} from "../services/entitlementService.ts";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  } else {
    console.log(`✅ Passed: ${msg}`);
  }
}

console.log("\n🧪 Running PitchNest Memory, Reasoning & Intelligence Test Suite...\n");

// 1. Temporal Reasoning Test
const text1 = "Our first paying customer signed on two weeks ago on a monthly plan.";
const facts1 = analyzeTemporalExpressions(text1, 1);
assert(facts1.length > 0, "Temporal facts extracted");
const custFact = facts1.find(f => f.type === "first_customer");
assert(custFact !== undefined && custFact.elapsedDays === 14, "Elapsed days correctly calculated as 14");
assert(custFact?.renewalDue === false, "Renewal marked as NOT due");
assert(custFact?.derivedConstraint.includes("Renewal is NOT YET DUE") ?? false, "Derived negative constraint on renewals");

// 2. Early-Stage Launch Calibration Test
const text2 = "We launched just 3 days ago, and already have 50 signups.";
const facts2 = analyzeTemporalExpressions(text2, 1);
const launchFact = facts2.find(f => f.type === "launch");
assert(launchFact !== undefined && launchFact.elapsedDays === 3, "Launch elapsed time calculated as 3 days");
assert(launchFact?.derivedConstraint.includes("DO NOT ask for multi-month retention") ?? false, "Derived constraint against premature cohort metrics");

// 3. Numerical Consistency Check
const state3 = createPitchSessionState("SaaSify", "B2B SaaS", "Seed");
state3.metrics.payingCustomers = "100";
state3.metrics.pricingModel = "$10/month";
state3.metrics.mrr = "$1,000";
const mathConsistent = verifyMathematicalConsistency(state3);
assert(mathConsistent.notes.length > 0 && mathConsistent.contradictions.length === 0, "Consistent unit economics verified");

state3.metrics.mrr = "$5,000";
const mathContradiction = verifyMathematicalConsistency(state3);
assert(mathContradiction.contradictions.length > 0, "Arithmetic contradiction detected ($1,000 expected vs $5,000 claimed)");

// 4. Question Deduplication & Resolution Tracking
const state4 = createPitchSessionState("FinApp", "Fintech", "Pre-Seed");
recordAskedQuestion(state4, "Marcus", "What is your customer acquisition cost?", 1);
assert(state4.questionsAsked.length === 1 && state4.questionsAsked[0].answered === false, "Question recorded as pending");
recordQuestionAnswered(state4, "Our CAC is currently around $45 through targeted ads.");
assert(state4.questionsAsked[0].answered === true && state4.questionsAsked[0].answerSummary?.includes("$45") === true, "Question recorded as answered with summary");

// 5. Deck Intelligence & Slide Parsing
const sampleDeck = `Slide 1: PayStream
The modern payment infrastructure for African creators.

Slide 2: Problem
Cross-border payments take 3-5 days and incur 8% fees.

Slide 3: Traction & Metrics
We have 100 active creators generating $5,000 in monthly GMV.`;

const deckIntel = parseDeckIntoSlides(sampleDeck, "PayStream Deck");
assert(deckIntel.totalSlides === 3, "Parsed 3 distinct slides from deck");
assert(deckIntel.slides[1].topic === "Problem", "Slide 2 topic correctly inferred as Problem");
assert(deckIntel.slides[2].keyNumbers.includes("100"), "Slide 3 key numbers extracted");

const slideMapping = inferActiveSlide("Our users face huge friction because cross-border settlements take almost a week with heavy fees.", deckIntel);
assert(slideMapping.activeSlide?.slideNumber === 2, "Semantic slide-to-speech mapping accurately selected Slide 2");

// 6. Entitlement & 30-Day Free Access Test
const futureDate = new Date(Date.now() + 25 * 86400000).toISOString();
const trialCheck = isTrialActive(futureDate, "active");
assert(trialCheck.active === true && trialCheck.daysRemaining >= 24, "30-day trial status active with >= 24 days remaining");

const trialEnt = entitlementsForPlan("free", null, futureDate, "active");
assert(trialEnt.plan === "pro", "Trial user granted Pro plan tier");
assert(trialEnt.pdfDownload === true, "Full PDF report download unlocked during trial");
assert(trialEnt.allowedDurations.includes(40), "40-min sessions unlocked during trial");
assert(trialEnt.isTrial === true, "isTrial flag set to true");

console.log("\n🎉 All 12 test assertions PASSED successfully!\n");
