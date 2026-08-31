/**
 * PitchMemoryService — Structured session state, temporal reasoning,
 * numerical consistency checking, and question tracking.
 *
 * Provides a persistent memory layer across long (5-10+ min) pitches so the
 * AI never loses numbers, dates, traction, pricing, market, business model,
 * or previous statements, and performs temporal & mathematical reasoning.
 */

export type StartupStage = "idea" | "pre_revenue" | "early_revenue" | "growth";

export interface ExtractedMetric {
  raw: string;
  normalized?: number;
  unit?: string;
  context: string;
  statedAtTurn: number;
}

export interface TemporalFact {
  type: "launch" | "first_customer" | "subscription" | "growth_window" | "runway" | "milestone";
  statedText: string;
  elapsedDays?: number;
  billingCycle?: "monthly" | "annual" | "quarterly" | "one_time";
  renewalDue?: boolean;
  derivedConstraint: string;
}

export interface NumericalFact {
  category: "mrr" | "arr" | "pricing" | "users" | "customers" | "cac" | "ltv" | "margin" | "raise" | "valuation";
  value: string;
  numericValue?: number;
  statedAtTurn: number;
}

export interface QuestionRecord {
  turnIndex: number;
  speaker: string;
  question: string;
  topic: string;
  answered: boolean;
  answerSummary?: string;
}

export interface PitchSessionState {
  companyName: string;
  industry: string;
  statedStage: string;
  inferredStage: StartupStage;
  
  // Core narrative
  problem?: string;
  solution?: string;
  targetCustomer?: string;
  marketSize?: string;
  businessModel?: string;
  pricingModel?: string;
  competition?: string;
  competitiveAdvantage?: string;
  goToMarket?: string;

  // Quantitative traction
  metrics: {
    users?: string;
    payingCustomers?: string;
    pricingModel?: string;
    mrr?: string;
    arr?: string;
    growthRate?: string;
    retentionRate?: string;
    churnRate?: string;
    cac?: string;
    ltv?: string;
    margins?: string;
    raiseAmount?: string;
    valuation?: string;
    useOfFunds?: string;
    runway?: string;
  };

  // Structured facts
  temporalFacts: TemporalFact[];
  numericalFacts: NumericalFact[];
  
  // Inferred temporal & numerical reasoning constraints
  temporalConstraints: string[];
  numericalNotes: string[];
  contradictionsDetected: string[];
  deckDiscrepancies: Array<{
    field: string;
    deckValue: string;
    spokenValue: string;
    isUpdate: boolean;
    note: string;
  }>;

  // Question & Dialogue state
  questionsAsked: QuestionRecord[];
  coveredTopics: Set<string>;
  unresolvedTopics: Set<string>;
  
  // Turn tracking
  totalTurns: number;
  lastUpdatedTurn: number;
}

/**
 * Creates an empty, clean PitchSessionState for a new session.
 */
export function createPitchSessionState(
  companyName: string = "Unknown Pitch",
  industry: string = "General",
  statedStage: string = "Pre-Seed"
): PitchSessionState {
  const normalizedStage = inferInitialStage(statedStage);
  return {
    companyName,
    industry,
    statedStage,
    inferredStage: normalizedStage,
    metrics: {},
    temporalFacts: [],
    numericalFacts: [],
    temporalConstraints: [],
    numericalNotes: [],
    contradictionsDetected: [],
    deckDiscrepancies: [],
    questionsAsked: [],
    coveredTopics: new Set<string>(),
    unresolvedTopics: new Set<string>([
      "Problem & Customer Pain",
      "Solution & Value Proposition",
      "Target Market & TAM",
      "Business & Pricing Model",
      "Traction & Validation",
      "Go-To-Market & Distribution",
      "Competitive Advantage",
      "Fundraising Ask & Milestones"
    ]),
    totalTurns: 0,
    lastUpdatedTurn: 0,
  };
}

function inferInitialStage(stageStr: string): StartupStage {
  const s = (stageStr || "").toLowerCase();
  if (/growth|series [b-z]|scale/i.test(s)) return "growth";
  if (/series a|early revenue|generating revenue/i.test(s)) return "early_revenue";
  if (/pre[- ]?seed|pilot|beta|waitlist/i.test(s)) return "pre_revenue";
  if (/idea|bootstrap|concept|pre-launch/i.test(s)) return "idea";
  if (/seed/i.test(s)) return "early_revenue";
  return "pre_revenue";
}

/**
 * Parses temporal expressions from spoken text and derives explicit logic constraints.
 * E.g. "first paying customer 2 weeks ago on monthly plan" -> Renewal not yet due.
 */
export function analyzeTemporalExpressions(text: string, currentTurn: number): TemporalFact[] {
  const facts: TemporalFact[] = [];
  const lower = text.toLowerCase();

  // 1. "launched X days/weeks/months ago" or "live for X weeks"
  const launchMatch = lower.match(/\b(?:launched|live|went live|started operations|operating for|in market for)\s+(?:about\s+|around\s+|just\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few)\s*(days?|weeks?|months?|years?)\s*(?:ago)?\b/);
  if (launchMatch) {
    const amountStr = launchMatch[1];
    const unit = launchMatch[2];
    const days = convertTimeToDays(amountStr, unit);
    if (days !== null) {
      let constraint = `Startup has only been live for ~${days} days (${amountStr} ${unit}). `;
      if (days < 60) {
        constraint += `DO NOT ask for multi-month retention cohorts, annual churn, or mature LTV. Focus on early customer feedback, conversion signals, and validation experiments.`;
      }
      facts.push({
        type: "launch",
        statedText: launchMatch[0],
        elapsedDays: days,
        derivedConstraint: constraint,
      });
    }
  }

  // 2. "first paying customer / signed customer X days/weeks ago" + subscription / billing cycle
  const customerMatch = lower.match(/\b(?:first|first paying|got our first|signed our first|onboarded our first|first ever)\s+(?:paying\s+)?(?:customer|client|user|subscriber)(?:[^\n.]{0,40}?)\s+(?:about\s+|around\s+|just\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few)\s*(days?|weeks?|months?)\s*ago\b/);
  if (customerMatch) {
    const amountStr = customerMatch[1];
    const unit = customerMatch[2];
    const days = convertTimeToDays(amountStr, unit);
    
    // Check if billing cycle mentioned in nearby context or text
    const isMonthly = /month|monthly|\/mo|\/month|monthly subscription|monthly plan/i.test(lower);
    const isAnnual = /year|yearly|annual|annually|\/yr|\/year/i.test(lower);
    const cycle = isAnnual ? "annual" : isMonthly ? "monthly" : "monthly"; // default SaaS assumption

    if (days !== null) {
      const isDue = cycle === "monthly" ? days >= 30 : days >= 365;
      let constraint = `First customer acquired ${days} days ago on a ${cycle} cycle. `;
      if (!isDue) {
        constraint += `Renewal is NOT YET DUE (< ${cycle === "monthly" ? 30 : 365} days). DO NOT ask if the customer has renewed for another period or ask about renewal rate!`;
      } else {
        constraint += `Customer has passed the ${cycle} renewal window (${days} days elapsed). Questioning renewal is valid.`;
      }

      facts.push({
        type: "first_customer",
        statedText: customerMatch[0],
        elapsedDays: days,
        billingCycle: cycle,
        renewalDue: isDue,
        derivedConstraint: constraint,
      });
    }
  }

  // 3. Runway / Burn window
  const runwayMatch = lower.match(/\b(\d+|one|two|three|four|five|six|eight|ten|twelve|18|24)\s*(?:months?|weeks?)\s*(?:of\s+)?runway\b/);
  if (runwayMatch) {
    facts.push({
      type: "runway",
      statedText: runwayMatch[0],
      derivedConstraint: `Stated runway: ${runwayMatch[0]}. Evaluate capital efficiency and time to next milestone.`,
    });
  }

  return facts;
}

function convertTimeToDays(amountStr: string, unit: string): number | null {
  const wordMap: Record<string, number> = {
    one: 1, a: 1, two: 2, "a couple of": 2, three: 3, "a few": 3,
    four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const num = parseInt(amountStr, 10) || wordMap[amountStr.toLowerCase()] || null;
  if (!num) return null;

  if (unit.startsWith("day")) return num;
  if (unit.startsWith("week")) return num * 7;
  if (unit.startsWith("month")) return num * 30;
  if (unit.startsWith("year")) return num * 365;
  return null;
}

/**
 * Extracts quantitative numerical facts and validates arithmetic relationships.
 */
export function analyzeNumericalFacts(text: string, currentTurn: number): {
  numericalFacts: NumericalFact[];
  extractedMetrics: Partial<PitchSessionState["metrics"]>;
  numericalNotes: string[];
  contradictions: string[];
} {
  const numericalFacts: NumericalFact[] = [];
  const extractedMetrics: Partial<PitchSessionState["metrics"]> = {};
  const numericalNotes: string[] = [];
  const contradictions: string[] = [];

  // Users count
  const usersMatch = text.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b|thousand|million)?\s*(?:registered\s+|active\s+)?users?\b/i);
  if (usersMatch) {
    const rawVal = usersMatch[0];
    extractedMetrics.users = rawVal;
    numericalFacts.push({ category: "users", value: rawVal, statedAtTurn: currentTurn });
  }

  // Paying customers / clients
  const custMatch = text.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b)?\s*(?:paying\s+|active\s+|enterprise\s+)?(?:customers?|clients?|subscribers?|businesses)\b/i);
  if (custMatch && !/users?/i.test(custMatch[0])) {
    const rawVal = custMatch[0];
    extractedMetrics.payingCustomers = rawVal;
    numericalFacts.push({ category: "customers", value: rawVal, statedAtTurn: currentTurn });
  }

  // MRR
  const mrrMatch = text.match(/(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b|thousand|million)?\s*(?:mrr|monthly\s+recurring\s+revenue|per\s+month\s+in\s+revenue|a\s+month\s+in\s+revenue)\b/i) ||
                   text.match(/\bmrr\s*(?:of|is|at|reached|generating)?\s*(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b)?\b/i);
  if (mrrMatch) {
    const rawVal = mrrMatch[0];
    extractedMetrics.mrr = rawVal;
    numericalFacts.push({ category: "mrr", value: rawVal, statedAtTurn: currentTurn });
  }

  // ARR
  const arrMatch = text.match(/(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b|thousand|million)?\s*(?:arr|annual\s+recurring\s+revenue|annualized\s+revenue)\b/i);
  if (arrMatch) {
    const rawVal = arrMatch[0];
    extractedMetrics.arr = rawVal;
    numericalFacts.push({ category: "arr", value: rawVal, statedAtTurn: currentTurn });
  }

  // Pricing / Price per unit / month
  const pricingMatch = text.match(/(?:charge|pricing|cost|price|subscription|fee)\s*(?:is|at|of)?\s*(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?(\d[\d,]*(?:\.\d+)?)\s*(?:\/|\s*per\s*)(?:month|user|seat|customer|year|transaction)\b/i) ||
                       text.match(/(?:[₦$£€]\s?|\bngn\s?|\busd\s?)(\d[\d,]*(?:\.\d+)?)\s*(?:\/|\s*per\s*)(?:month|user|seat|customer|year)\b/i);
  if (pricingMatch) {
    const rawVal = pricingMatch[0];
    extractedMetrics.pricingModel = rawVal;
    numericalFacts.push({ category: "pricing", value: rawVal, statedAtTurn: currentTurn });
  }

  // Fundraising target raise
  const raiseMatch = text.match(/\b(?:raising|seeking|looking for|round of|target raise of)\s*(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b|million|thousand|billion)\b/i);
  if (raiseMatch) {
    const rawVal = raiseMatch[0];
    extractedMetrics.raiseAmount = rawVal;
    numericalFacts.push({ category: "raise", value: rawVal, statedAtTurn: currentTurn });
  }

  // Valuation
  const valMatch = text.match(/\b(?:valuation|valued at|post-money|pre-money)\s*(?:of|at|is)?\s*(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?(\d[\d,]*(?:\.\d+)?)\s*(?:k\b|m\b|million|billion)\b/i);
  if (valMatch) {
    const rawVal = valMatch[0];
    extractedMetrics.valuation = rawVal;
    numericalFacts.push({ category: "valuation", value: rawVal, statedAtTurn: currentTurn });
  }

  return { numericalFacts, extractedMetrics, numericalNotes, contradictions };
}

/**
 * Checks mathematical consistency across known metrics.
 * E.g., users * price = MRR, MRR * 12 = ARR.
 */
export function verifyMathematicalConsistency(state: PitchSessionState): {
  notes: string[];
  contradictions: string[];
} {
  const notes: string[] = [];
  const contradictions: string[] = [];

  // Parse numeric values if available
  const parseNum = (str?: string): number | null => {
    if (!str) return null;
    const m = str.match(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|million|thousand|billion)?/i);
    if (!m) return null;
    const base = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(base)) return null;
    const unit = (m[2] || "").toLowerCase();
    const mult = unit.startsWith("k") || unit === "thousand" ? 1e3
      : unit.startsWith("m") || unit === "million" ? 1e6
      : unit.startsWith("b") || unit === "billion" ? 1e9
      : 1;
    return base * mult;
  };

  const users = parseNum(state.metrics.payingCustomers || state.metrics.users);
  const price = parseNum(state.metrics.pricingModel);
  const mrr = parseNum(state.metrics.mrr);
  const arr = parseNum(state.metrics.arr);

  if (users !== null && price !== null && mrr !== null && users > 0 && price > 0 && mrr > 0) {
    const expectedMrr = users * price;
    const ratio = mrr / expectedMrr;
    // Allow small variance for tiers or discounts (0.75 to 1.25)
    if (ratio >= 0.8 && ratio <= 1.25) {
      notes.push(`Arithmetic verified: ${users} customers × $${price}/mo ≈ $${mrr} MRR [Consistent].`);
    } else if (ratio > 1.8 || ratio < 0.5) {
      contradictions.push(`Arithmetic discrepancy: Founder stated ${users} customers at $${price}/mo ($${expectedMrr} expected), but claimed $${mrr} MRR.`);
    }
  }

  if (mrr !== null && arr !== null && mrr > 0 && arr > 0) {
    const expectedArr = mrr * 12;
    const arrRatio = arr / expectedArr;
    if (arrRatio >= 0.85 && arrRatio <= 1.15) {
      notes.push(`MRR to ARR conversion verified: $${mrr} MRR × 12 ≈ $${arr} ARR [Consistent].`);
    } else if (arrRatio > 1.5 || arrRatio < 0.6) {
      contradictions.push(`ARR discrepancy: $${mrr} MRR implies ~$${expectedArr} ARR, but founder stated $${arr} ARR.`);
    }
  }

  return { notes, contradictions };
}

/**
 * Parses a metric string ("$1,000", "20 users", "1.5m") to a number, for
 * detecting whether a re-stated metric materially changed.
 */
function parseMetricNumber(str?: string): number | null {
  if (!str) return null;
  const m = str.match(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?/i);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(base)) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit.startsWith("k") || unit === "thousand" ? 1e3
    : unit.startsWith("m") || unit === "million" ? 1e6
    : unit.startsWith("b") || unit === "billion" ? 1e9
    : 1;
  return base * mult;
}

/**
 * True when two stated values for the SAME metric are materially different
 * (>5% for numbers; case-insensitive text compare otherwise). Formatting-only
 * differences ("$1,000" vs "$1000") are NOT treated as a change.
 */
function metricValuesDiffer(a: string, b: string): boolean {
  const na = parseMetricNumber(a);
  const nb = parseMetricNumber(b);
  if (na !== null && nb !== null) {
    if (na === 0 && nb === 0) return false;
    return Math.abs(na - nb) / Math.max(Math.abs(na), Math.abs(nb), 1) > 0.05;
  }
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

function humanizeMetricKey(key: string): string {
  return key.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}

/**
 * Updates the pitch session state incrementally from a new founder utterance.
 */
export function updatePitchMemory(
  state: PitchSessionState,
  utterance: string,
  turnIndex: number,
  deckSlideContext?: string
): PitchSessionState {
  state.totalTurns = turnIndex;
  state.lastUpdatedTurn = turnIndex;

  const text = utterance.trim();
  if (!text) return state;

  // 1. Analyze Temporal Facts
  const temporal = analyzeTemporalExpressions(text, turnIndex);
  for (const tf of temporal) {
    state.temporalFacts.push(tf);
    if (tf.derivedConstraint && !state.temporalConstraints.includes(tf.derivedConstraint)) {
      state.temporalConstraints.push(tf.derivedConstraint);
    }
    // Infer startup stage if launch was recent
    if (tf.type === "launch" && tf.elapsedDays !== undefined) {
      if (tf.elapsedDays <= 30) {
        state.inferredStage = "idea";
      } else if (tf.elapsedDays <= 90) {
        state.inferredStage = "pre_revenue";
      }
    }
  }

  // 2. Analyze Numerical Facts & Metrics
  const { numericalFacts, extractedMetrics } = analyzeNumericalFacts(text, turnIndex);
  state.numericalFacts.push(...numericalFacts);

  // Merge newly extracted metrics. CRITICAL: if a metric that was already
  // stated changes to a MATERIALLY different value, preserve the discrepancy as
  // a contradiction for the panel to probe — never silently overwrite an
  // earlier figure (e.g. "100 users" must not vanish when "10 users" arrives).
  for (const [key, val] of Object.entries(extractedMetrics)) {
    if (!val) continue;
    const prev = (state.metrics as any)[key] as string | undefined;
    if (prev && prev !== val && metricValuesDiffer(prev, val)) {
      const note = `Founder re-stated ${humanizeMetricKey(key)} as "${val}" after earlier saying "${prev}" — confirm which is current and why it changed.`;
      if (!state.contradictionsDetected.includes(note)) {
        state.contradictionsDetected.push(note);
      }
    }
    (state.metrics as any)[key] = val;
  }

  // If paying customers / MRR detected, upgrade inferred stage
  if (state.metrics.mrr || state.metrics.payingCustomers) {
    if (state.inferredStage === "idea" || state.inferredStage === "pre_revenue") {
      state.inferredStage = "early_revenue";
    }
  }

  // 3. Mark covered narrative topics
  const lower = text.toLowerCase();
  if (/\b(?:problem|struggle|pain point|friction|inefficiency|challenge)\b/.test(lower)) {
    state.coveredTopics.add("Problem & Customer Pain");
    state.unresolvedTopics.delete("Problem & Customer Pain");
    if (!state.problem && text.length > 20) state.problem = text.slice(0, 200);
  }
  if (/\b(?:solution|product|platform|app|built|we provide|we solve|how it works)\b/.test(lower)) {
    state.coveredTopics.add("Solution & Value Proposition");
    state.unresolvedTopics.delete("Solution & Value Proposition");
    if (!state.solution && text.length > 20) state.solution = text.slice(0, 200);
  }
  if (/\b(?:market size|tam|sam|som|billion dollar market|total addressable)\b/.test(lower)) {
    state.coveredTopics.add("Target Market & TAM");
    state.unresolvedTopics.delete("Target Market & TAM");
  }
  if (/\b(?:business model|monetize|revenue model|pricing|subscription fee|commission|take rate)\b/.test(lower)) {
    state.coveredTopics.add("Business & Pricing Model");
    state.unresolvedTopics.delete("Business & Pricing Model");
  }
  if (/\b(?:traction|users|revenue|customers|pilots|waitlist|growth)\b/.test(lower)) {
    state.coveredTopics.add("Traction & Validation");
    state.unresolvedTopics.delete("Traction & Validation");
  }
  if (/\b(?:go to market|gtm|acquisition|channels|distribution|sales|marketing)\b/.test(lower)) {
    state.coveredTopics.add("Go-To-Market & Distribution");
    state.unresolvedTopics.delete("Go-To-Market & Distribution");
  }
  if (/\b(?:competitor|competition|advantage|moat|defensibility|differentiation)\b/.test(lower)) {
    state.coveredTopics.add("Competitive Advantage");
    state.unresolvedTopics.delete("Competitive Advantage");
  }
  if (/\b(?:raising|ask|valuation|use of funds|runway|seed round)\b/.test(lower)) {
    state.coveredTopics.add("Fundraising Ask & Milestones");
    state.unresolvedTopics.delete("Fundraising Ask & Milestones");
  }

  // 4. Mathematical Consistency Check
  const mathCheck = verifyMathematicalConsistency(state);
  state.numericalNotes = mathCheck.notes;
  for (const c of mathCheck.contradictions) {
    if (!state.contradictionsDetected.includes(c)) {
      state.contradictionsDetected.push(c);
    }
  }

  return state;
}

/**
 * Registers an AI panelist question in the question ledger.
 */
export function recordAskedQuestion(
  state: PitchSessionState,
  speaker: string,
  question: string,
  turnIndex: number
): void {
  const cleanQ = question.trim();
  if (!cleanQ || cleanQ.length < 10) return;

  // Infer topic from question
  let topic = "General Inquiries";
  const lower = cleanQ.toLowerCase();
  if (/mrr|arr|revenue|pricing|price|charge|cost/i.test(lower)) topic = "Revenue & Pricing";
  else if (/user|customer|client|retention|churn|cac|ltv/i.test(lower)) topic = "Unit Economics & Traction";
  else if (/market|tam|competition|competitor|moat/i.test(lower)) topic = "Market & Defensibility";
  else if (/valuation|raising|raise|equity|use of funds/i.test(lower)) topic = "Fundraising & Terms";
  else if (/product|tech|feasi|architecture/i.test(lower)) topic = "Product & Execution";

  state.questionsAsked.push({
    turnIndex,
    speaker,
    question: cleanQ,
    topic,
    answered: false,
  });
}

/**
 * Records that the founder's response answered the last pending question.
 */
export function recordQuestionAnswered(
  state: PitchSessionState,
  answerText: string
): void {
  if (state.questionsAsked.length === 0) return;
  const lastQ = state.questionsAsked[state.questionsAsked.length - 1];
  if (!lastQ.answered && answerText.trim().length > 15) {
    lastQ.answered = true;
    lastQ.answerSummary = answerText.slice(0, 160).trim();
  }
}

/**
 * Builds the structured high-density prompt block injected into the live AI system context.
 */
export function buildPitchMemoryPromptBlock(state: PitchSessionState): string {
  const parts: string[] = [];

  parts.push(`=== STRUCTURED PITCH MEMORY & STATE (GROUND TRUTH) ===`);
  parts.push(`STARTUP: "${state.companyName}" | INFERRED STAGE: [${state.inferredStage.toUpperCase()}] (Stated: "${state.statedStage}")`);

  // Stated metrics
  const metricEntries = Object.entries(state.metrics)
    .filter(([_, v]) => Boolean(v))
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v}`);
  
  if (metricEntries.length > 0) {
    parts.push(`RECORDED METRICS: ${metricEntries.join(" | ")}`);
  } else {
    parts.push(`RECORDED METRICS: None stated yet.`);
  }

  // Temporal facts & constraints
  if (state.temporalConstraints.length > 0) {
    parts.push(`TEMPORAL REASONING & CONSTRAINTS (STRICT):`);
    for (const tc of state.temporalConstraints) {
      parts.push(`- ⚠️ ${tc}`);
    }
  }

  // Numerical & Mathematical notes
  if (state.numericalNotes.length > 0 || state.contradictionsDetected.length > 0) {
    parts.push(`NUMERICAL INTEGRITY:`);
    for (const n of state.numericalNotes) parts.push(`- ✓ ${n}`);
    for (const c of state.contradictionsDetected) parts.push(`- 🚨 CONTRADICTION: ${c} (Prioritize probing this!)`);
  }

  // Deck Discrepancies vs Speech
  if (state.deckDiscrepancies.length > 0) {
    parts.push(`DECK VS SPEECH UPDATES:`);
    for (const d of state.deckDiscrepancies) {
      parts.push(`- ${d.field}: Deck states "${d.deckValue}", founder stated "${d.spokenValue}" (${d.isUpdate ? "TREAT AS UPDATED FIGURE, NOT ERROR" : "CONTRADICTION"}).`);
    }
  }

  // Question history & duplicate prevention
  if (state.questionsAsked.length > 0) {
    parts.push(`QUESTIONS ALREADY ASKED (DO NOT RE-ASK UNLESS CLARIFYING A DIRECT CONTRADICTION):`);
    const recent = state.questionsAsked.slice(-6);
    for (const q of recent) {
      const status = q.answered ? `[ANSWERED: "${q.answerSummary || "Yes"}"]` : `[PENDING ANSWER]`;
      parts.push(`- ${q.speaker}: "${q.question}" -> ${status}`);
    }
  }

  // Stage-calibrated guidance
  parts.push(`STAGE-APPROPRIATE EVALUATION YARDSTICK:`);
  if (state.inferredStage === "idea") {
    parts.push(`- Idea stage: Zero users/revenue is NORMAL. Focus on problem validation, customer discovery, founder insight, and early prototype plan. NEVER demand retention cohorts or revenue.`);
  } else if (state.inferredStage === "pre_revenue") {
    parts.push(`- Pre-revenue stage: Focus on early LOIs, waitlist depth, pilots, user testing feedback, and path to first customer. Do not penalize absence of scaled metrics.`);
  } else if (state.inferredStage === "early_revenue") {
    parts.push(`- Early revenue stage: Focus on paying customer feedback, pricing logic, early growth, unit economics direction, and acquisition channels.`);
  } else {
    parts.push(`- Growth stage: Expect concrete metrics (CAC, LTV, churn, growth rate, sales efficiency, margins). Push hard on defensibility and capital efficiency.`);
  }

  parts.push(`=== END PITCH MEMORY ===`);
  return parts.join("\n");
}

/**
 * Reconstructs pitch memory by replaying a transcript through the same
 * incremental extractors used live. Used on RESUME (reconnect after a refresh):
 * the per-connection state is otherwise lost, so without this the panel would
 * forget every number/date/question from before the reconnect. Deterministic —
 * no LLM call. Founder turns update the memory + mark the prior question
 * answered; panel turns are recorded in the question ledger.
 */
export function rebuildPitchMemoryFromTranscript(
  base: PitchSessionState,
  transcript: Array<{
    type?: string;
    role?: string;
    text?: string;
    fullText?: string;
    speaker?: string;
  }>,
): PitchSessionState {
  let state = base;
  if (!Array.isArray(transcript)) return state;

  let turn = 0;
  for (const m of transcript) {
    turn++;
    const isUser = m?.type === "user" || m?.role === "user";
    const txt = String(m?.fullText || m?.text || "").trim();
    if (!txt) continue;
    if (isUser) {
      state = updatePitchMemory(state, txt, turn);
      recordQuestionAnswered(state, txt);
    } else {
      recordAskedQuestion(state, m?.speaker || "AI", txt, turn);
    }
  }
  return state;
}
