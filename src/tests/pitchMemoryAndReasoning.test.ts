import { describe, it, expect } from "vitest";
import {
  createPitchSessionState,
  analyzeTemporalExpressions,
  analyzeNumericalFacts,
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

describe("PitchMemoryService — Temporal & Numerical Reasoning", () => {
  it("Scenario B & Temporal Reasoning: identifies customer acquired 14 days ago on monthly plan and derives constraint that renewal is NOT yet due", () => {
    const text = "Our first paying customer signed on two weeks ago on a monthly plan.";
    const facts = analyzeTemporalExpressions(text, 1);

    expect(facts.length).toBeGreaterThan(0);
    const custFact = facts.find(f => f.type === "first_customer");
    expect(custFact).toBeDefined();
    expect(custFact?.elapsedDays).toBe(14);
    expect(custFact?.billingCycle).toBe("monthly");
    expect(custFact?.renewalDue).toBe(false);
    expect(custFact?.derivedConstraint).toContain("Renewal is NOT YET DUE");
    expect(custFact?.derivedConstraint).toContain("DO NOT ask if the customer has renewed");
  });

  it("Scenario F & Early Stage Calibration: recognizes startup launched 3 days ago and generates negative constraint against premature multi-month metrics", () => {
    const text = "We launched just 3 days ago, and already have 50 signups.";
    const facts = analyzeTemporalExpressions(text, 1);

    const launchFact = facts.find(f => f.type === "launch");
    expect(launchFact).toBeDefined();
    expect(launchFact?.elapsedDays).toBe(3);
    expect(launchFact?.derivedConstraint).toContain("DO NOT ask for multi-month retention cohorts");
  });

  it("Numerical consistency: verifies arithmetic relationships (users * price = MRR)", () => {
    const state = createPitchSessionState("SaaSify", "B2B SaaS", "Seed");
    state.metrics.payingCustomers = "100";
    state.metrics.pricingModel = "$10/month";
    state.metrics.mrr = "$1,000";

    const math = verifyMathematicalConsistency(state);
    expect(math.notes.some(n => n.includes("Consistent"))).toBe(true);
    expect(math.contradictions.length).toBe(0);
  });

  it("Numerical consistency: flags arithmetic contradictions when MRR contradicts customer count and price", () => {
    const state = createPitchSessionState("SaaSify", "B2B SaaS", "Seed");
    state.metrics.payingCustomers = "100";
    state.metrics.pricingModel = "$10/month";
    state.metrics.mrr = "$5,000"; // Should be $1,000

    const math = verifyMathematicalConsistency(state);
    expect(math.contradictions.length).toBeGreaterThan(0);
    expect(math.contradictions[0]).toContain("discrepancy");
  });

  it("Scenario C & Question Tracking: tracks asked questions and marks them answered", () => {
    const state = createPitchSessionState("FinApp", "Fintech", "Pre-Seed");
    recordAskedQuestion(state, "Marcus", "What is your customer acquisition cost?", 1);

    expect(state.questionsAsked.length).toBe(1);
    expect(state.questionsAsked[0].answered).toBe(false);

    recordQuestionAnswered(state, "Our CAC is currently around $45 through targeted LinkedIn ads.");
    expect(state.questionsAsked[0].answered).toBe(true);
    expect(state.questionsAsked[0].answerSummary).toContain("$45");
  });

  it("State compilation: produces comprehensive ground truth memory block", () => {
    let state = createPitchSessionState("PayStream", "Fintech", "Seed");
    state = updatePitchMemory(state, "We launched 2 weeks ago and charging $50 per month.", 1);
    state = updatePitchMemory(state, "We now have 20 paying customers bringing in $1000 MRR.", 2);

    const promptBlock = buildPitchMemoryPromptBlock(state);
    expect(promptBlock).toContain("PayStream");
    expect(promptBlock).toContain("EARLY_REVENUE");
    expect(promptBlock).toContain("paying customers: 20");
    expect(promptBlock).toContain("mrr: $1000");
  });
});

describe("DeckIntelligenceService — Slide Parsing & Semantic Mapping", () => {
  const sampleDeckText = `Slide 1: PayStream
The modern payment infrastructure for African creators.

Slide 2: Problem
Cross-border payments take 3-5 days and incur 8% fees.

Slide 3: Traction & Metrics
We have 100 active creators generating $5,000 in monthly GMV.`;

  it("Parses raw deck text into structured slides with topics and metrics", () => {
    const intelligence = parseDeckIntoSlides(sampleDeckText, "PayStream Deck");
    expect(intelligence.totalSlides).toBe(3);
    expect(intelligence.slides[1].topic).toBe("Problem");
    expect(intelligence.slides[2].topic).toBe("Traction");
    expect(intelligence.slides[2].keyNumbers).toContain("100");
  });

  it("Scenario D: semantically maps natural founder speech to the correct slide", () => {
    const intelligence = parseDeckIntoSlides(sampleDeckText, "PayStream Deck");
    const speech = "Our users face huge friction because cross-border settlements take almost a week with heavy fees.";
    const { activeSlide } = inferActiveSlide(speech, intelligence);

    expect(activeSlide).toBeDefined();
    expect(activeSlide?.slideNumber).toBe(2);
    expect(activeSlide?.topic).toBe("Problem");
  });

  it("Builds structured deck context block for LLM prompt", () => {
    const intelligence = parseDeckIntoSlides(sampleDeckText, "PayStream Deck");
    const block = buildStructuredDeckContextBlock(intelligence);

    expect(block).toContain("TOTAL SLIDES: 3");
    expect(block).toContain("Slide 2");
    expect(block).toContain("Problem");
  });
});

describe("EntitlementService — 30-Day Free Trial Full Access", () => {
  it("Scenario H & I: grants full access and PDF download during active 30-day trial", () => {
    const trialStatus = isTrialActive(new Date(Date.now() + 25 * 86400000).toISOString(), "active");
    expect(trialStatus.active).toBe(true);
    expect(trialStatus.daysRemaining).toBeGreaterThanOrEqual(24);

    const ent = entitlementsForPlan("free", null, new Date(Date.now() + 25 * 86400000).toISOString(), "active");
    expect(ent.plan).toBe("pro");
    expect(ent.pdfDownload).toBe(true);
    expect(ent.allowedDurations).toContain(40);
    expect(ent.isTrial).toBe(true);
  });

  it("Defaults unauthenticated / new users to 30-day trial full access", () => {
    const trial = getTrialEntitlement(30);
    expect(trial.pdfDownload).toBe(true);
    expect(trial.allowedDurations).toEqual([10, 20, 30, 40]);
    expect(trial.maxWeeklySessions).toBe(Infinity);
  });
});
