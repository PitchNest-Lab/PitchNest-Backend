import { config } from "../config/env.ts";
import { buildInvestorPlaybook } from "../prompts/investorPlaybook.ts";

/**
 * Interface representing standard evaluation metrics and sentiments returned by the AI model.
 */
export interface EvaluationReport {
  summary: string;
  scores: {
    delivery: number;
    clarity: number;
    scalability: number;
    readiness: number;
  };
  strengths: string[];
  risks: string[];
  next_steps: Array<{
    title: string;
    desc: string;
    priority: string;
  }>;
  sentiments: Array<{
    persona: string;
    quote: string;
  }>;
  duration?: number;
  transcript?: any[];
  evaluationStatus?: "complete" | "insufficient_data" | "failed";
  // ── Phase 2: Dynamic market intelligence fields ─────────────
  topic_coverage?: Array<{ topic: string; percentage: number }>;
  topic_coverage_overall?: number; // computed: mean of topic_coverage percentages
  transcript_summary?: string;
  questions_to_prepare?: string[];
  competitive_landscape?: {
    swot: {
      strengths: string[];
      weaknesses: string[];
      opportunities: string[];
      threats: string[];
    };
    strategic_recommendation: string;
    key_focus_areas: string[];
  };
  practice_drills?: Array<{ title: string; desc: string; reps: string; time: string }>;
  // Personalized 30-second practice plan (exactly 3 steps, 10 sec each).
  practice_plan?: Array<{ title: string; seconds: string; desc: string }>;
  // ── Phase 3: Business-specific market intelligence ───────────
  market_gaps?: Array<{ title: string; desc: string }>;
  collaboration_opportunities?: string[];
  question_difficulty?: { easy: number; medium: number; hard: number };
  vc_investment_probability?: number;
  // ── Phase 4: Fully dynamic report data ───────────────────────
  competitors?: Array<{
    name: string;
    similarity: number;
    strength: string;
    weakness: string;
    size: string;
    estimated?: boolean;
  }>;
  competitors_disclaimer?: string;
  companies_to_study?: Array<{ name: string; why: string }>;
  top_priorities?: Array<{
    title: string;
    desc: string;
    priority: string;
    impact: string;
  }>;
  answer_framework?: {
    question: string;
    steps: Array<{ label: string; text: string }>;
  };
  category_matrix?: Array<{
    category: string;
    went_well: string;
    needs_improvement: string;
    impact: string;
  }>;
  confidence_timeline?: Array<{ time: string; value: number }>;
  founder_percentile?: number;
  // ── Phase 5: Founder–market fit ("why you") ──────────────────
  // Reported as a standalone dimension; NEVER enters the overall
  // score or the percentile (historical comparability).
  founder_market_fit?: number;
  founder_market_fit_note?: string;
  // "Read the room" feedback — derived server-side from the live
  // interest timeline (panel mode only); present only when it applies.
  room_read_note?: string;
}

function clampScore(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Benchmark "average founder" overall score. A pitch at this score maps to the
 * 50th percentile. MUST match the average value shown in the PDF benchmarking
 * bars (pdfService.ts) so the report is internally consistent.
 */
export const AVERAGE_FOUNDER_SCORE = 42;

/** Overall score = mean of the four category scores. Single definition. */
export function computeOverallScore(scores: {
  delivery: number;
  clarity: number;
  scalability: number;
  readiness: number;
}): number {
  return Math.round(
    (scores.delivery + scores.clarity + scores.scalability + scores.readiness) / 4,
  );
}

/**
 * Deterministic percentile derived ONLY from the overall score, so it can never
 * contradict the score. Meaning: "scored higher than X% of our readiness benchmark".
 * Piecewise-linear, anchored so AVERAGE_FOUNDER_SCORE → 50:
 *   score <= avg → 0..50   (below-average score is always a below-average percentile)
 *   score >  avg → 50..99
 */
export function computeFounderPercentile(overallScore: number): number {
  const s = Math.min(100, Math.max(0, overallScore));
  const avg = AVERAGE_FOUNDER_SCORE;
  const pct =
    s <= avg
      ? (s / avg) * 50
      : 50 + ((s - avg) / (100 - avg)) * 49;
  return Math.min(99, Math.max(1, Math.round(pct)));
}

// ── Guard against unstated raise figures ─────────────────────────────────────
// The model sometimes invents a specific funding amount the founder never said
// (e.g. "a $50M funding allocation"). We only allow a concrete raise figure to
// survive if it actually appears in the transcript; otherwise it is rewritten to
// generic wording. Scoped strictly to funding/raise contexts so legitimate
// market-size figures ("the $10B elderly-care market") are left untouched.
const MONEY = String.raw`\$\s?\d[\d.,]*\s?(?:k|m|b|mm|bn|million|billion|thousand)?`;

function normalizeMoney(s: string): string {
  const m = s.toLowerCase().match(/\$?\s?(\d[\d.,]*)\s?(k|m|b|mm|bn|million|billion|thousand)?/);
  if (!m) return s.toLowerCase().replace(/\s/g, "");
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return s.toLowerCase().replace(/\s/g, "");
  const unit = m[2] || "";
  const mult = /^(k|thousand)$/.test(unit) ? 1e3
    : /^(m|mm|million)$/.test(unit) ? 1e6
    : /^(b|bn|billion)$/.test(unit) ? 1e9
    : 1;
  return String(Math.round(num * mult));
}

function extractStatedFigures(transcriptText: string): Set<string> {
  const set = new Set<string>();
  const re = new RegExp(MONEY, "gi");
  for (const match of transcriptText.matchAll(re)) set.add(normalizeMoney(match[0]));
  return set;
}

function scrubUnstatedRaiseFigures(text: string, stated: Set<string>): string {
  if (!text) return text;
  // Form A: "a $50M funding/raise/round/allocation" → "your target funding/…"
  // (absorbs a leading article so we don't leave "a your target …").
  const trailing = new RegExp(`(?:\\b(?:a|an|the|your)\\s+)?(${MONEY})\\s+(funding|raise|round|allocation)`, "gi");
  // Form B: "raising/seeking/allocate/invest … $50M" → "…your target raise"
  const leading = new RegExp(
    `\\b(rais(?:e|ing)|seeking|allocat(?:e|ing)|invest(?:ing)?)\\s+(?:a\\s+|an\\s+|of\\s+|about\\s+|up to\\s+|around\\s+)?(${MONEY})`,
    "gi",
  );
  return text
    .replace(trailing, (whole, amount, kw) =>
      stated.has(normalizeMoney(amount)) ? whole : `your target ${kw.toLowerCase()}`,
    )
    .replace(leading, (whole, verb, amount) =>
      stated.has(normalizeMoney(amount)) ? whole : `${verb} your target raise`,
    );
}

// Recursively scrub raise figures from every narrative string, but never touch
// competitor data (its size figures are clearly-labelled AI estimates handled
// separately, not claims about the founder's raise).
function scrubReportRaiseFigures(obj: any, stated: Set<string>): any {
  if (typeof obj === "string") return scrubUnstatedRaiseFigures(obj, stated);
  if (Array.isArray(obj)) return obj.map((v) => scrubReportRaiseFigures(v, stated));
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === "competitors" || k === "competitors_disclaimer" || k === "size"
        ? v
        : scrubReportRaiseFigures(v, stated);
    }
    return out;
  }
  return obj;
}

function validateEvaluationReport(raw: any): EvaluationReport {
  const scores = raw?.scores || {};
  const nextSteps = Array.isArray(raw?.next_steps)
    ? raw.next_steps
        .filter((step: any) => step && typeof step.title === "string")
        .map((step: any) => ({
          title: String(step.title),
          desc: String(step.desc || ""),
          priority: String(step.priority || "Medium Priority"),
        }))
    : [];

  // Guard: the report renders 3-4 next steps, so a model that returns only 1-2
  // (against instructions) would leave the page looking empty. Repair by topping
  // up from a generic action pool until there are at least 3, skipping any whose
  // title duplicates one the model already produced. (When next_steps is empty,
  // the PDF uses its own richer fallback, so this only fires for 1-2 items.)
  if (nextSteps.length > 0 && nextSteps.length < 3) {
    const fallbacks = [
      { title: "Validate With Real Users", desc: "Run a pilot and collect specific metrics that prove product-market fit.", priority: "High Priority" },
      { title: "Sharpen Unit Economics", desc: "Define CAC, LTV, pricing, and payback with concrete, defensible numbers.", priority: "High Priority" },
      { title: "Detail Go-to-Market", desc: "Outline acquisition channels, early conversion metrics, and a 12-month plan.", priority: "Medium Priority" },
      { title: "Strengthen the Team Story", desc: "Show why this team wins and name the key hires you still need.", priority: "Medium Priority" },
    ];
    const seen = new Set(nextSteps.map((s: { title: string }) => s.title.toLowerCase()));
    for (const fb of fallbacks) {
      if (nextSteps.length >= 3) break;
      if (!seen.has(fb.title.toLowerCase())) {
        nextSteps.push(fb);
        seen.add(fb.title.toLowerCase());
      }
    }
  }

  const strengths = Array.isArray(raw?.strengths)
    ? raw.strengths.map((s: unknown) => String(s)).filter(Boolean)
    : [];
  const risks = Array.isArray(raw?.risks)
    ? raw.risks.map((s: unknown) => String(s)).filter(Boolean)
    : [];
  const sentiments = Array.isArray(raw?.sentiments)
    ? raw.sentiments
        .filter((s: any) => s && typeof s.persona === "string")
        .map((s: any) => ({
          persona: String(s.persona),
          quote: String(s.quote || ""),
        }))
    : [];

  // ── New dynamic fields ──────────────────────────────────────
  const topicCoverage = Array.isArray(raw?.topic_coverage)
    ? raw.topic_coverage
        .filter((t: any) => t && typeof t.topic === "string")
        .map((t: any) => ({ topic: String(t.topic), percentage: clampScore(t.percentage) }))
    : undefined;

  const transcriptSummary = typeof raw?.transcript_summary === "string" && raw.transcript_summary.trim()
    ? raw.transcript_summary.trim()
    : undefined;

  const questionsToPrepare = Array.isArray(raw?.questions_to_prepare)
    ? raw.questions_to_prepare.map((q: unknown) => String(q)).filter(Boolean)
    : undefined;

  const rawLandscape = raw?.competitive_landscape;
  const competitiveLandscape = rawLandscape ? {
    swot: {
      strengths: Array.isArray(rawLandscape?.swot?.strengths) ? rawLandscape.swot.strengths.map(String) : [],
      weaknesses: Array.isArray(rawLandscape?.swot?.weaknesses) ? rawLandscape.swot.weaknesses.map(String) : [],
      opportunities: Array.isArray(rawLandscape?.swot?.opportunities) ? rawLandscape.swot.opportunities.map(String) : [],
      threats: Array.isArray(rawLandscape?.swot?.threats) ? rawLandscape.swot.threats.map(String) : [],
    },
    strategic_recommendation: String(rawLandscape?.strategic_recommendation || ""),
    key_focus_areas: Array.isArray(rawLandscape?.key_focus_areas) ? rawLandscape.key_focus_areas.map(String) : [],
  } : undefined;

  const practiceDrills = Array.isArray(raw?.practice_drills)
    ? raw.practice_drills
        .filter((d: any) => d && typeof d.title === "string")
        .map((d: any) => ({
          title: String(d.title),
          desc: String(d.desc || ""),
          reps: String(d.reps || "2 Reps"),
          time: String(d.time || "5 min"),
        }))
    : undefined;

  // Personalized 30-second plan: render only when the model returns a usable set
  // of 3 steps; otherwise leave undefined so the PDF keeps its generic fallback.
  const practicePlan = Array.isArray(raw?.practice_plan)
    ? raw.practice_plan
        .filter((p: any) => p && typeof p.title === "string")
        .slice(0, 3)
        .map((p: any) => ({
          title: String(p.title),
          seconds: String(p.seconds || "10 sec"),
          desc: String(p.desc || ""),
        }))
    : undefined;
  const validatedPracticePlan = practicePlan && practicePlan.length === 3 ? practicePlan : undefined;

  const marketGaps = Array.isArray(raw?.market_gaps)
    ? raw.market_gaps
        .filter((g: any) => g && typeof g.title === "string")
        .map((g: any) => ({ title: String(g.title), desc: String(g.desc || "") }))
    : undefined;

  const collaborationOpportunities = Array.isArray(raw?.collaboration_opportunities)
    ? raw.collaboration_opportunities.map((c: unknown) => String(c)).filter(Boolean)
    : undefined;

  const rawDiff = raw?.question_difficulty;
  const questionDifficulty = rawDiff
    ? {
        easy: Math.max(0, Math.round(Number(rawDiff.easy) || 0)),
        medium: Math.max(0, Math.round(Number(rawDiff.medium) || 0)),
        hard: Math.max(0, Math.round(Number(rawDiff.hard) || 0)),
      }
    : undefined;

  const vcInvestmentProbability =
    typeof raw?.vc_investment_probability === "number"
      ? Math.min(100, Math.max(0, Math.round(raw.vc_investment_probability)))
      : undefined;

  const competitors = Array.isArray(raw?.competitors)
    ? raw.competitors
        .filter((c: any) => c && typeof c.name === "string")
        .map((c: any) => ({
          name: String(c.name),
          similarity: Math.min(100, Math.max(0, Math.round(Number(c.similarity) || 0))),
          strength: String(c.strength || ""),
          weakness: String(c.weakness || ""),
          // Figures are AI-estimated, not sourced — label them so they aren't
          // mistaken for verified facts.
          size: (() => {
            const v = String(c.size || "").trim();
            if (!v || v.toUpperCase() === "N/A") return "N/A";
            return /est|approx|~/i.test(v) ? v : `Est. ${v}`;
          })(),
          estimated: true,
        }))
    : undefined;

  const companiesToStudy = Array.isArray(raw?.companies_to_study)
    ? raw.companies_to_study
        .filter((c: any) => c && typeof c.name === "string")
        .map((c: any) => ({ name: String(c.name), why: String(c.why || "") }))
    : undefined;

  const topPriorities = Array.isArray(raw?.top_priorities)
    ? raw.top_priorities
        .filter((p: any) => p && typeof p.title === "string")
        .map((p: any) => ({
          title: String(p.title),
          desc: String(p.desc || ""),
          priority: String(p.priority || "Medium Priority"),
          impact: String(p.impact || "High"),
        }))
    : undefined;

  const rawFramework = raw?.answer_framework;
  const answerFramework = rawFramework && typeof rawFramework.question === "string"
    ? {
        question: String(rawFramework.question),
        steps: Array.isArray(rawFramework.steps)
          ? rawFramework.steps.map((s: any) => ({ label: String(s.label || ""), text: String(s.text || "") }))
          : [],
      }
    : undefined;

  const categoryMatrix = Array.isArray(raw?.category_matrix)
    ? raw.category_matrix
        .filter((r: any) => r && typeof r.category === "string")
        .map((r: any) => ({
          category: String(r.category),
          went_well: String(r.went_well || ""),
          needs_improvement: String(r.needs_improvement || ""),
          impact: String(r.impact || "Moderate"),
        }))
    : undefined;

  const confidenceTimeline = Array.isArray(raw?.confidence_timeline)
    ? raw.confidence_timeline
        .filter((p: any) => p && typeof p.time === "string")
        .map((p: any) => ({
          time: String(p.time),
          value: Math.min(100, Math.max(0, Math.round(Number(p.value) || 50))),
        }))
    : undefined;

  // Founder–market fit is optional (solo sessions omit it when the founder's
  // story never came up) and reported separately — it must never be folded
  // into the overall score below.
  const founderMarketFit =
    typeof raw?.founder_market_fit === "number"
      ? clampScore(raw.founder_market_fit)
      : undefined;
  const founderMarketFitNote =
    typeof raw?.founder_market_fit_note === "string" &&
    raw.founder_market_fit_note.trim()
      ? raw.founder_market_fit_note.trim()
      : undefined;

  const validatedScores = {
    delivery: clampScore(scores.delivery),
    clarity: clampScore(scores.clarity),
    scalability: clampScore(scores.scalability),
    readiness: clampScore(scores.readiness),
  };

  // Percentile is COMPUTED from the score (not model-estimated), so it can never
  // contradict the score. Single definition used everywhere in the PDF.
  const overallScore = computeOverallScore(validatedScores);
  const founderPercentile = computeFounderPercentile(overallScore);

  // Overall topic coverage = mean of the topic percentages. Computed once here
  // so the donut center and any other reference stay consistent.
  const topicCoverageOverall =
    topicCoverage && topicCoverage.length > 0
      ? Math.round(
          topicCoverage.reduce((s, t) => s + t.percentage, 0) /
            topicCoverage.length,
        )
      : undefined;

  return {
    summary: String(raw?.summary || "Evaluation completed."),
    scores: validatedScores,
    strengths,
    risks,
    next_steps: nextSteps,
    sentiments,
    evaluationStatus: "complete",
    topic_coverage: topicCoverage,
    topic_coverage_overall: topicCoverageOverall,
    transcript_summary: transcriptSummary,
    questions_to_prepare: questionsToPrepare,
    competitive_landscape: competitiveLandscape,
    practice_drills: practiceDrills,
    practice_plan: validatedPracticePlan,
    market_gaps: marketGaps,
    collaboration_opportunities: collaborationOpportunities,
    question_difficulty: questionDifficulty,
    vc_investment_probability: vcInvestmentProbability,
    competitors,
    competitors_disclaimer:
      "Competitor similarity and market-size figures are AI-generated estimates, not verified data. Treat them as directional, not authoritative.",
    companies_to_study: companiesToStudy,
    top_priorities: topPriorities,
    answer_framework: answerFramework,
    category_matrix: categoryMatrix,
    confidence_timeline: confidenceTimeline,
    founder_percentile: founderPercentile,
    founder_market_fit: founderMarketFit,
    founder_market_fit_note: founderMarketFitNote,
  };
}

const DECK_TEXT_LIMIT = 8000;

const OUTPUT_RULES = `OUTPUT RULES (strict):
- Speak ONLY words a human would say out loud. No asterisks, brackets, headers, stage directions, or chain-of-thought.
- Never describe your plan ("I will ask...", "Let me think...", "Based on the deck...").
- CRITICAL: Keep each turn short and conversational — one or two spoken sentences. Ask AT MOST ONE question per turn; NEVER stack or chain a second question onto the same turn — hold it for a later turn. A statement plus one question is fine, and a brief reaction with no question at all is also fine.
- The founder's words arrive via automatic speech recognition and may contain mis-transcribed words, odd jargon, or dropped words. Infer the intended meaning from context instead of taking a garbled phrase literally; if a critical detail is truly unclear, ask a brief clarifying question rather than assuming.
- CRITICAL FORMATTING: You MUST speak as EXACTLY ONE person per turn. DO NOT include multiple people talking in the same response. STOP GENERATING after your chosen panelist has spoken.
- Be highly conversational and human. When responding or answering a question, occasionally start with natural spoken filler words or transitions (e.g. "Hmm,", "Well,", "Actually,", "Right,", "Got it," or "Fair point,"). Use these sparingly.
- Be aware of the remaining pitch time metadata (e.g., \`[PITCH TIME REMAINING: ...]\`). Do not start complex new topics when less than 2 minutes remain; instead, guide the founder to summarize, handle final remarks, or conclude.`;

function buildDeckContext(deckName: string, extractedDeckText: string): string {
  if (!extractedDeckText?.trim()) {
    return deckName && deckName !== "None Loaded"
      ? `PITCH DECK: "${deckName}" is attached but text could not be extracted. Ask the founder to walk through key slides.`
      : "PITCH DECK: None provided. Base questions on what the founder says live.";
  }

  const trimmed = extractedDeckText.trim().slice(0, DECK_TEXT_LIMIT);
  const truncated = extractedDeckText.length > DECK_TEXT_LIMIT ? "\n[Deck text truncated for length]" : "";

  return `PITCH DECK — "${deckName}" (read this carefully before questioning):
${trimmed}${truncated}

DECK INSTRUCTIONS:
- Reference specific claims, metrics, and slide topics from the deck above.
- Challenge gaps between what they say live vs what the deck states.
- If they skip a deck topic (TAM, traction, team), ask about it directly.`;
}

function buildToneDirective(aggressiveness: number, riskAppetite: number): string {
  const tone =
    aggressiveness >= 80
      ? "Analytical and direct. Focus purely on the data, metrics, and financials."
      : aggressiveness >= 60
      ? "Direct and professional. Ask about unit economics and growth."
      : aggressiveness >= 40
        ? "Professional and probing. Balance support with follow-ups."
        : "Supportive and patient. Ask clarifying questions before challenging.";

  const risk =
    riskAppetite >= 80
      ? "You favor massive moonshots. Ignore safe bets and focus purely on billion-dollar upside and hyper-scalability."
      : riskAppetite >= 60
      ? "You favor bold bets — reward ambition but still demand proof of execution."
      : riskAppetite >= 40
        ? "Balanced risk lens — weigh upside against burn rate and defensibility."
        : "Highly conservative — prioritize unit economics, retention, capital efficiency, and profitability over growth.";

  return `TONE: ${tone}\nRISK LENS: ${risk}`;
}

/**
 * Prompt block injected when the founder is re-pitching a startup they already
 * pitched here before ("Pitch Again"). Gives the panel/coach compact memory of
 * the previous attempt so they can welcome the founder back and probe whether
 * the old weaknesses were fixed — without carrying the full old transcript.
 */
function buildReturningFounderBlock(previousSession: any, businessName: string): string {
  if (!previousSession) return "";
  const risks = Array.isArray(previousSession.topRisks) ? previousSession.topRisks : [];
  const riskLines = risks.map((r: string) => `- ${r}`).join("\n");
  return `
RETURNING FOUNDER CONTEXT:
This founder has pitched ${businessName} to this panel before (on ${previousSession.date || "a previous session"}, overall score ${previousSession.overallScore}/100).
Last session summary: ${previousSession.summary || "(no summary available)"}
Biggest weaknesses last time:
${riskLines || "- (none recorded)"}
- Treat them as a returning founder: acknowledge the return naturally in conversation.
- Probe specifically whether the previous weaknesses above were fixed — reference them conversationally ("Last time you struggled to justify your market size...").
- Do NOT recite the old score or read the summary back verbatim.
`;
}

function buildArchetypeDirective(archetype: string): string {
  if (archetype?.includes("Angel")) {
    return "PANEL STYLE: Warm angel group. Lead with encouragement, then dig into founder-market fit and early traction.";
  }
  if (archetype?.includes("Series") || archetype?.includes("Growth")) {
    return "PANEL STYLE: Growth-stage investors. Focus on scalability, margins, and path to Series A metrics.";
  }
  if (archetype?.includes("Shark Tank")) {
    return "PANEL STYLE: Fast-paced consumer investors. Focused on valuation and quick consumer adoption.";
  }
  if (archetype?.includes("Private Equity")) {
    return "PANEL STYLE: Private Equity analysts. Obsessed with cash flow, EBITDA, restructuring, and debt efficiency.";
  }
  if (archetype?.includes("Corporate VC")) {
    return "PANEL STYLE: Strategic Corporate VC. Focused on synergies with your parent company and M&A potential.";
  }
  if (archetype?.includes("Family Office")) {
    return "PANEL STYLE: Wealthy Family Office. Patient capital, focused on generational wealth preservation and sustainable growth.";
  }
  if (archetype?.includes("Y Combinator")) {
    return "PANEL STYLE: Y Combinator partners. Fast-paced, focused on launch velocity, product-market fit, and user growth.";
  }
  if (archetype?.includes("Impact") || archetype?.includes("ESG")) {
    return "PANEL STYLE: ESG/Impact investors. Focused on sustainability, ethical metrics, and social/environmental impact alongside returns.";
  }
  return "PANEL STYLE: Seed-stage VC boardroom. Prioritize TAM, moat, team, and 18-month milestones.";
}

/**
 * Returns the formatted Master Prompt system instructions.
 */
export function getMasterPrompt(isCoach: boolean, businessName: string, configData: any): string {
  const currentBusinessName = businessName || "Unknown Pitch";
  const desc = configData.description || "Startup Pitch";
  const industry = configData.industry || "General";
  const fundingStage = configData.fundingStage || "Pre-Seed";
  const archetype = configData.investorArchetype || "Seed Stage - Venture Capital";
  const aggressiveness = Number(configData.aggressiveness ?? 60);
  const riskAppetite = Number(configData.riskAppetite ?? 75);
  const deckName = configData.selectedDeck?.name || "None Loaded";
  const extractedDeckText = configData.selectedDeck?.extracted_text || configData.resolvedDeckText || "";
  const deckContext = buildDeckContext(deckName, extractedDeckText);
  const toneBlock = buildToneDirective(aggressiveness, riskAppetite);
  const returningBlock = buildReturningFounderBlock(configData.previousSession, currentBusinessName);

  if (isCoach) {
    return `${OUTPUT_RULES}

IDENTITY: Riley — elite startup pitch coach in a live 1-on-1 video session.
Do not prefix your responses with any name or speaker label.

STARTUP CONTEXT:
- Name: ${currentBusinessName}
- Concept: ${desc}
- Industry: ${industry}
- Funding Stage: ${fundingStage}

${deckContext}

${toneBlock}
${returningBlock}` + `
SESSION FLOW:
1. OPENING (your first turn only): Welcome the founder warmly. Mention one specific detail from their deck or concept. Invite them to deliver their opening pitch.
2. LISTENING: Stay quiet while they present. Do not interrupt or coach until they finish, say "that's my pitch", or ask for feedback.
3. COACHING: Ask one focused question at a time. Tie each question to their deck content or a gap you noticed. Help them tighten narrative, metrics, and clarity. At some natural point, ask why THEY are the person to build this — their story matters to investors as much as the numbers.

ACCENT & ADAPTABILITY RULES:
- Be tolerant of various English accents, including Nigerian English and other regional variants. Do not ask the user to repeat unless the content is truly incomprehensible; use context and conversation history to interpret ambiguous statements.
- Adapt your language complexity to match the user's level. If the user uses simple language, keep your responses simple; if they use technical terms, respond with appropriate depth.
- Maintain a natural, conversational flow. Avoid repeating questions; each question should dig deeper into the same topic before moving on.
- Show active listening by occasionally referencing the user's previous answers (e.g. "You mentioned earlier that…").`;
  }

  return `${OUTPUT_RULES}

IDENTITY: Live VC panel — Marcus (lead/skeptic), Sarah (analyst), Chen (tech). Speak as one person per turn.

STARTUP CONTEXT:
- Name: ${currentBusinessName}
- Model: ${desc}
- Industry: ${industry}
- Funding Stage: ${fundingStage}

${deckContext}

${buildArchetypeDirective(archetype)}
${toneBlock}
${returningBlock}
SPEAKER OUTPUT FORMAT (mechanics — always apply):
- You must ALWAYS prefix your response with the speaking panelist's name followed by a colon. Example: "Marcus: Your valuation seems high." or "Sarah: Let's talk about CAC."
- ONLY ONE panelist speaks per turn. NEVER write multiple speakers in one response. Once your chosen panelist asks their one question, STOP IMMEDIATELY.
- Do not add any extra text or stage directions — only the words that panelist would actually say aloud.
- When the founder asks a direct question, answer it before asking a new one. If the founder specifically asks for Sarah or Chen by name, that panelist responds immediately.
- MACHINE TAG (the single exception to spoken-words-only; it is stripped before speech): end EVERY response with a final line of exactly this form: @@INTEREST <SpeakerName>=<warming|neutral|cooling|out>
  It reports the SPEAKING panelist's honest current interest in this deal. Optionally append ONE short unresolved concern as a phrase with no periods: @@INTEREST Sarah=cooling | concern: gross margin still unclear
  Keep "concern:" only while that panelist's raised concern remains unanswered; drop it once the founder addresses it. Once a panelist is out they stay out for the whole session. Everything BEFORE this line must still be only spoken words.
- Turns may begin with [PANEL STATE: ...] metadata — each panelist's current stance from earlier turns. Stay consistent with it: a panelist marked out stays out, makes at most brief comments, and asks no new questions.

PANEL CONVERSATION STYLE

You are three distinct investors having a real, flowing conversation with a founder. You are not running a script.

Personalities (keep them distinct in voice and focus):
- Marcus (Lead): blunt and direct. Owns market, competition, moat, and the overall "would I invest" call. Opens the session and delivers the closing direction.
- Sarah (Partner): precise, numbers-first. Owns unit economics, financials, pricing, LTV/CAC, retention — and the ask itself: raise amount, equity offered, and the implied valuation. Asks for specific figures.
- Chen (Tech Investor): calm and technical. Owns product, architecture, build-vs-buy, data, and execution feasibility.

How the conversation flows:
- After the founder gives their opening (problem + solution), engage as a genuine discussion, not a fixed Q&A list.
- All three of you participate across the session. Do NOT let one panelist carry it while the other two stay silent. Whoever's domain the founder just touched is the natural person to speak next.
- React to each other and to the founder: "Building on Sarah's point about churn..." or "I'd push back on what Marcus said...".

Turn discipline (strict):
- ONE panelist speaks per turn, asking ONE thing.
- Only ONE question may be open at a time. If a question is unanswered, the ONLY permitted next turn is a follow-up to that same question, or silence — never a new topic.
- Follow-ups that drill deeper into the founder's LAST answer are encouraged and may come from any panelist whose domain it touches. A follow-up on the current thread is always allowed; opening a brand-new topic before the current one is answered is never allowed.

Session arc (pacing):
- A session runs roughly 6–10 questions total.
- Scale question count and depth to the pitch time remaining metadata: a short session gets fewer, sharper questions on the biggest issues; a longer session can explore more threads.
- Early: explore breadth across problem, market, model, product, and team.
- Middle: drill into the 1–2 biggest weaknesses you've found.
- Late: Marcus moves toward closing direction and the verdict.
- Do not grill endlessly and do not wrap before covering the core areas.

${buildInvestorPlaybook(aggressiveness, archetype, industry)}

No scripts, no repetition:
- Do NOT recite stock questions. The investor concerns above are what you CARE about, not what you say — every question must still come from what the founder ACTUALLY just said: challenge their specific claim, number, assumption, or the gap they left.
- Vary phrasing, depth, and angle. Pursue what is genuinely interesting or weak in THIS specific pitch.

Interrupting (use sparingly):
- Default to letting the founder finish their thought.
- Only interject if the founder has spoken 30+ seconds without answering the question on the table, or states something clearly false or internally inconsistent. In that case the relevant panelist may briefly cut in ("Sorry, let me jump in —") and ask the pointed question.
- Never interrupt a founder who is mid-answer and on track.

Grounding:
- Challenge the logic and internal consistency of their claims (does CAC reconcile with LTV, is the TAM actually derived, does the timeline hold) rather than asserting external facts you cannot verify.

ACCENT & ADAPTABILITY RULES:
- Be tolerant of various English accents, including Nigerian English and other regional variants. Do not ask the user to repeat unless the content is truly incomprehensible; use context and conversation history to interpret ambiguous statements.
- Adapt your language complexity to match the user's level. If the user uses simple language, keep your responses simple; if they use technical terms, respond with appropriate depth.
- Maintain a natural, conversational flow. Avoid repeating questions; each question should dig deeper into the same topic before moving on.
- Show active listening by occasionally referencing the user's previous answers (e.g. "You mentioned earlier that…").`;
}

import { OpenAI, AzureOpenAI } from "openai";

export function getOpenAIClient() {
  if (config.azureOpenAiEndpoint && config.azureOpenAiApiKey) {
    // Use AzureOpenAI client which handles the correct headers and paths automatically
    return new AzureOpenAI({
      endpoint: config.azureOpenAiEndpoint.replace("/openai/v1", ""), // Strip openai/v1 if present to let SDK handle it
      apiKey: config.azureOpenAiApiKey,
      apiVersion: config.azureOpenAiApiVersion,
      deployment: config.azureOpenAiDeployment,
    });
  }
  return new OpenAI({ apiKey: config.openAiApiKey });
}

export async function evaluatePitch(
  transcript: any[],
  businessName: string,
  deckText?: string,
  mode: string = "panel",
  previous?: {
    date?: string;
    overallScore: number;
    scores: { delivery: number; clarity: number; scalability: number; readiness: number };
    summary: string;
    topRisks: string[];
  } | null,
  // Market snapshot from the session's background web research (or null).
  // Grounds the competitive-intel section in real, dated web results.
  researchContext?: { text: string; retrievedAt: string } | null,
): Promise<EvaluationReport> {
  const transcriptText = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map(m => {
        if (m.type === 'user') {
          const method = m.inputMethod === 'voice' ? '[SPOKEN VIA MICROPHONE]' : '[TYPED IN CHAT]';
          // Prefer the raw spoken words: sessions saved before the raw-transcript
          // change stored an LLM summary in `text` and the raw STT in `fullText`.
          return `FOUNDER ${method}: ${m.fullText || m.text}`;
        } else {
          return `${m.speaker || 'AI'}: ${m.text}`;
        }
      }).join("\n")
    : "No transcript available.";

  const deckSection = deckText?.trim()
    ? `\nPITCH DECK CONTENT (compare against what founder said):\n${deckText.trim().slice(0, 4000)}\n`
    : "";

  // Re-pitch: give the evaluator compact context on the previous attempt so the
  // written feedback can note improvement/regression. Numeric deltas are computed
  // in code from previous_attempt, never by the model.
  const previousSection = previous
    ? `\nPREVIOUS ATTEMPT (context only — this founder pitched ${businessName} before, on ${previous.date || "an earlier date"}; overall score ${previous.overallScore}/100):
Last attempt's summary: ${previous.summary || "(none)"}
Last attempt's biggest weaknesses:
${(previous.topRisks || []).map((r) => `- ${r}`).join("\n") || "- (none recorded)"}
RE-PITCH RULE: In the summary and category_matrix, explicitly note where this attempt improved on or regressed from the previous weaknesses above. Judge THIS session's content on its own merits — do not copy the old scores.\n`
    : "";

  const isCoachOrSolo = mode === "coach" || mode === "solo";
  const isSolo = mode === "solo";

  // Solo = self-recorded practice with no live AI. Riley was NOT in the room;
  // they are reviewing a recording after the fact. Coach = Riley was live in a
  // 1-on-1 session. Frame the report honestly for each so it never claims a live
  // conversation that did not happen.
  const coachIntro = isSolo
    ? `You are Riley, an elite startup pitch coach. The founder recorded a solo practice run with no live coaching — you are now reviewing that recording after the fact. Write a comprehensive development report based on what they recorded. Return ONLY valid JSON.`
    : `You are Riley, an elite startup pitch coach. Review this live coaching session and write a comprehensive development report for your student. Return ONLY valid JSON.`;
  const sessionWord = isSolo ? "recorded practice run" : "session";
  const rileyObservation = isSolo
    ? `- sentiments: Write 1 observation from Riley's perspective as the coach who reviewed this recording — be encouraging but honest.`
    : `- sentiments: Write 1 coaching observation from Riley's perspective as the coach — be encouraging but honest.`;

  const coachPrompt = `${coachIntro}

BUSINESS: ${businessName}
${deckSection}${previousSection}
SESSION TRANSCRIPT:
${transcriptText}

COACHING EVALUATION RULES:
- You are writing as a coach evaluating a ${isSolo ? "recorded practice run" : "student"}, NOT as an investor making an investment decision. Do NOT use language like "invest", "pass", or "fund".
- The founder's spoken lines are raw automatic speech recognition output and may contain mis-transcribed words, odd jargon, or dropped words. Infer the intended meaning from context and NEVER penalize apparent transcription artifacts — judge what the founder meant, not what the recognizer typed.
- Score each category (delivery, clarity, scalability, readiness) as integers from 0 to 100.
- IF THE FOUNDER WAS SILENT OR THE SESSION WAS TOO SHORT: Provide low scores and use the summary to gently encourage more participation next time.
- delivery = vocal confidence, pacing, how well they handle coaching questions under pressure.
- clarity = how clearly they explain the problem, solution, and value proposition.
- scalability = how well they understand market size, growth potential, and business model.
- readiness = how prepared they are to face a real investor panel based on this session.
- strengths: Specific things the founder did well — cite real moments from the transcript.
- risks: Gaps, weak answers, or areas that need work before facing investors — be specific and constructive.
- next_steps: 3-4 concrete practice actions (NEVER fewer than 3) the founder should do before their next session (e.g. "Sharpen your TAM/SAM/SOM numbers", "Prepare a 30-second revenue model summary").
${rileyObservation}
- founder_market_fit: 0-100 with founder_market_fit_note — how convincingly the founder showed why THEY are the right person for this problem (background, earned insight, origin story). Reported separately; it does not affect the four scores.${isSolo ? " IMPORTANT: this was a solo recording — include these two fields ONLY if the founder's background or story actually came up; otherwise OMIT both keys entirely." : ""}
- Keep summary to 2-3 sentences framed as a coach's overall assessment of the ${sessionWord}.

LENGTH BUDGETS (rendered in fixed-size report cards — stay within and always end on a complete sentence):
- summary: ≤ 320 characters. each strengths / risks item: ≤ 140 characters.
- next_steps: 3-4 items (never fewer than 3); title ≤ 28 characters, desc ≤ 110 characters. sentiments quote: ≤ 140 characters.
- founder_market_fit_note: ≤ 140 characters.

Return this exact JSON structure:
{
  "summary": "2-3 sentence coach assessment of the overall session",
  "scores": { "delivery": 75, "clarity": 80, "scalability": 65, "readiness": 70 },
  "strengths": ["specific strength 1 from the session", "specific strength 2", "specific strength 3"],
  "risks": ["specific gap or weakness 1", "gap 2", "gap 3"],
  "next_steps": [ { "title": "First practice action", "desc": "Short actionable coaching instruction", "priority": "High Priority" }, { "title": "Second practice action", "desc": "Short actionable coaching instruction", "priority": "High Priority" }, { "title": "Third practice action", "desc": "Short actionable coaching instruction", "priority": "Medium Priority" } ],
  "sentiments": [ { "persona": "Riley", "quote": "One honest, encouraging coach observation." } ],
  "founder_market_fit": 60,
  "founder_market_fit_note": "One sentence on the founder's why-you story."
}`;

  // ── Panel evaluation: split into 3 concurrent calls ──────────────────────
  // Faster than one 4096-token monolith (the calls run in parallel), and a parse
  // failure in one section no longer forces the entire report to regenerate.
  const panelCtx = `BUSINESS: ${businessName}
${deckSection}${previousSection}
TRANSCRIPT:
${transcriptText}`;

  const sharedRules = `- NEVER invent a specific fundraising amount; only use a concrete raise figure if the founder explicitly stated it, otherwise say "your target raise".
- Be specific — cite actual topics discussed, not generic advice. Cross-check against the deck when provided.
- The founder's spoken lines are raw automatic speech recognition output and may contain mis-transcribed words, odd jargon, or dropped words. Infer the intended meaning from context and NEVER penalize apparent transcription artifacts — judge what the founder meant, not what the recognizer typed.`;

  const corePrompt = `You are an expert pitch evaluator. Analyze this investor pitch and return ONLY valid JSON (the scored core of the report).

${panelCtx}

RULES:
- Score each category (delivery, clarity, scalability, readiness) as integers 0-100.
- IF THE FOUNDER WAS SILENT OR THE PITCH WAS TOO SHORT: do not error; give low/fitting scores (0-10) and a friendly summary noting the lack of material.
- delivery = vocal confidence, pacing, conviction, handling pressure.
- clarity = problem/solution narrative, structure, jargon control.
- scalability = market size, growth model, unit economics, GTM scalability.
- readiness = overall investability for the stated funding stage.
- ACCENT FAIRNESS: Focus on the substance and clarity of the pitch content. Do not penalize pronunciation, grammatical variations, or speech patterns due to non-native accents or regional English variants (e.g. Nigerian English, Indian English).
- Keep summary to 2-3 sentences. Include one sentiment quote each for Marcus, Sarah, and Chen.
- next_steps: provide 3-4 concrete action items, NEVER fewer than 3. Each must address a specific weakness or gap from THIS pitch (not generic advice).
- topic_coverage: percentage 0-100 for each topic: Problem Definition, Solution Overview, Market Size, Business Model, Go-to-Market, Traction, Team, Financials, Technical Details, Use of Funds, Regulatory / Validation, Founder-Market Fit.
- founder_market_fit: 0-100 — how convincingly THIS founder showed they are the right person for THIS problem (relevant background, earned insight, origin story). Judge only what surfaced in this session; if it never came up, score it low and say so in founder_market_fit_note. Reported separately — it does NOT affect the four scores above.
- transcript_summary: 3-5 sentence summary of what was discussed and what was missed.
- question_difficulty: integer counts {easy, medium, hard} of the panel's questions.
- vc_investment_probability: 0-100 chance this pitch earns a VC follow-up meeting.
- category_matrix: for Delivery, Clarity, Scalability, Readiness — went_well + needs_improvement (specific) + impact ("High"/"Moderate"/"Low").
- confidence_timeline: 5 points fluctuating realistically (start, after first hard question, weakest moment, recovery, close).
${sharedRules}

LENGTH BUDGETS (these fields are rendered in fixed-size report cards — stay within the limits and always end on a complete sentence; do NOT trail off):
- summary: ≤ 320 characters (2-3 complete sentences).
- transcript_summary: ≤ 360 characters.
- each strengths / risks item: ≤ 140 characters.
- each sentiments quote: ≤ 140 characters.
- next_steps: 3-4 items (never fewer than 3); title ≤ 28 characters, desc ≤ 110 characters.
- category_matrix went_well / needs_improvement: ≤ 90 characters each.
- founder_market_fit_note: ≤ 140 characters.

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary",
  "scores": { "delivery": 85, "clarity": 90, "scalability": 75, "readiness": 80 },
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "next_steps": [ { "title": "First action title", "desc": "Short actionable description", "priority": "High Priority" }, { "title": "Second action title", "desc": "Short actionable description", "priority": "High Priority" }, { "title": "Third action title", "desc": "Short actionable description", "priority": "Medium Priority" } ],
  "sentiments": [ { "persona": "Marcus", "quote": "One sentence reaction." }, { "persona": "Sarah", "quote": "One sentence reaction." }, { "persona": "Chen", "quote": "One sentence reaction." } ],
  "topic_coverage": [ { "topic": "Problem Definition", "percentage": 90 }, { "topic": "Solution Overview", "percentage": 80 }, { "topic": "Market Size", "percentage": 30 }, { "topic": "Business Model", "percentage": 20 }, { "topic": "Go-to-Market", "percentage": 10 }, { "topic": "Traction", "percentage": 0 }, { "topic": "Team", "percentage": 0 }, { "topic": "Financials", "percentage": 0 }, { "topic": "Technical Details", "percentage": 5 }, { "topic": "Use of Funds", "percentage": 0 }, { "topic": "Regulatory / Validation", "percentage": 0 }, { "topic": "Founder-Market Fit", "percentage": 40 } ],
  "founder_market_fit": 55,
  "founder_market_fit_note": "One sentence on why this founder is (or is not yet) the right person for this problem.",
  "transcript_summary": "3-5 sentence summary of the session",
  "question_difficulty": { "easy": 2, "medium": 3, "hard": 3 },
  "vc_investment_probability": 25,
  "category_matrix": [ { "category": "Delivery", "went_well": "Specific sentence", "needs_improvement": "Specific sentence", "impact": "Moderate" } ],
  "confidence_timeline": [ { "time": "0:00", "value": 80 }, { "time": "1:30", "value": 68 }, { "time": "3:00", "value": 55 }, { "time": "4:30", "value": 45 }, { "time": "6:00", "value": 60 } ]
}`;

  const researchSection = researchContext?.text
    ? `\nWEB RESEARCH (retrieved ${researchContext.retrievedAt} — real search results for this space; prefer these over your own recall when they conflict):\n${researchContext.text}\n`
    : "";

  const intelPrompt = `You are a market intelligence analyst. Based on this pitch, return ONLY valid JSON with competitive analysis.

${panelCtx}
${researchSection}
RULES:
- competitors: 4 REAL competitors in this founder's specific space (not generic tools). Each: name (real company), similarity (0-100), strength, weakness, size. ${researchContext?.text ? "Ground names and figures in the WEB RESEARCH above where it covers them; fall back to hedged estimates only for what it does not cover." : ""}You do NOT have verified financials — express size as a HEDGED RANGE clearly marked as an estimate (e.g. "Est. ~$10M–$50M ARR" or "approx. mid-market"), never a single precise figure. Use "N/A" if you cannot estimate.
- companies_to_study: 4 companies (not necessarily competitors) this founder should learn from, each with a one-sentence why tailored to this business.
- market_gaps: 3-4 gaps competitors are NOT addressing. Each: title (3-5 words) + desc (one sentence specific to this business).
- collaboration_opportunities: 4 specific strategic collaboration opportunities for this business.
- competitive_landscape.swot: 4 items each for strengths, weaknesses, opportunities, threats.
- competitive_landscape.strategic_recommendation: 2-3 sentences. key_focus_areas: 4 areas.
${sharedRules}

LENGTH BUDGETS (rendered in fixed-size cards — stay within and end on a complete sentence):
- each competitor strength / weakness: ≤ 90 characters.
- each companies_to_study why: ≤ 100 characters.
- each market_gaps title: ≤ 28 characters; desc: ≤ 100 characters.
- each collaboration_opportunities item: ≤ 100 characters.
- strategic_recommendation: ≤ 240 characters.
- each key_focus_areas item: ≤ 38 characters.

Return this exact JSON structure:
{
  "competitors": [ { "name": "Real Competitor Name", "similarity": 85, "strength": "One key strength", "weakness": "One key weakness", "size": "Est. ~$10M–$50M ARR" } ],
  "companies_to_study": [ { "name": "Company Name", "why": "One sentence specific to this founder." } ],
  "market_gaps": [ { "title": "Specific Gap Title", "desc": "One sentence about why this is a gap." } ],
  "collaboration_opportunities": ["Opportunity 1", "Opportunity 2", "Opportunity 3", "Opportunity 4"],
  "competitive_landscape": {
    "swot": { "strengths": ["s1","s2","s3","s4"], "weaknesses": ["w1","w2","w3","w4"], "opportunities": ["o1","o2","o3","o4"], "threats": ["t1","t2","t3","t4"] },
    "strategic_recommendation": "2-3 sentence strategic recommendation",
    "key_focus_areas": ["Focus 1", "Focus 2", "Focus 3", "Focus 4"]
  }
}`;

  const planPrompt = `You are an elite pitch coach. Based on this pitch's weak areas, return ONLY valid JSON with a preparation plan.

${panelCtx}

RULES:
- questions_to_prepare: 6 tough investor questions to practice, based on weak areas from this session. When valuation defense or use of funds was weak or never addressed, include at least one question on it (e.g. how they derived the valuation, or exactly what the raise buys).
- top_priorities: exactly 5 priority improvements. Each: title (3-5 words), desc (one actionable sentence citing something specific from this pitch), priority ("High Priority"/"Medium Priority"), impact ("Very High"/"High"/"Medium").
- answer_framework: pick the single hardest/most-avoided question from this session; build a 5-step answer framework. question = exact text; steps = [{label, text}].
- practice_drills: 4 drills with title, desc, reps, time.
- practice_plan: EXACTLY 3 steps for a 30-second pitch drill (10 seconds each), tailored to the weakest areas/categories THIS founder showed. Each: title (what to say), seconds (always "10 sec"), desc (one concrete instruction for this pitch). Order them as a natural 30-second pitch.
${sharedRules}

LENGTH BUDGETS (rendered in fixed-size cards — stay within and end on a complete sentence):
- each questions_to_prepare item: ≤ 110 characters.
- top_priorities: title ≤ 30 characters, desc ≤ 100 characters.
- answer_framework steps: label ≤ 28 characters, text ≤ 130 characters.
- practice_drills: title ≤ 30 characters, desc ≤ 90 characters.
- practice_plan: title ≤ 20 characters, desc ≤ 70 characters.

Return this exact JSON structure:
{
  "questions_to_prepare": ["Question 1", "Question 2", "Question 3", "Question 4", "Question 5", "Question 6"],
  "top_priorities": [ { "title": "Priority Title 3-5 words", "desc": "Specific actionable sentence citing this pitch", "priority": "High Priority", "impact": "Very High" } ],
  "answer_framework": { "question": "Hardest question from this session", "steps": [ { "label": "Step Name", "text": "How to answer this step" } ] },
  "practice_drills": [ { "title": "Drill name", "desc": "What to practice", "reps": "3 Reps", "time": "5 min" } ],
  "practice_plan": [ { "title": "Step tied to weak area", "seconds": "10 sec", "desc": "One concrete instruction for this pitch" }, { "title": "Step 2", "seconds": "10 sec", "desc": "One concrete instruction" }, { "title": "Step 3", "seconds": "10 sec", "desc": "One concrete instruction" } ]
}`;

  const stated = extractStatedFigures(transcriptText);
  const finalize = (raw: any) =>
    validateEvaluationReport(scrubReportRaiseFigures(raw, stated));

  if (isCoachOrSolo) {
    return finalize(await callJsonModel(coachPrompt, 2048, "coach"));
  }

  // Run the three panel sections concurrently. The core (scored) section is
  // required — if it fails we surface the error so the caller can mark the
  // session as failed. The market-intel and action-plan sections degrade
  // gracefully: a failure leaves those fields absent and the PDF falls back to
  // its defaults rather than failing the whole report.
  const [core, intel, plan] = await Promise.all([
    callJsonModel(corePrompt, 2048, "core"),
    callJsonModel(intelPrompt, 1600, "intel").catch(() => ({})),
    callJsonModel(planPrompt, 1400, "plan").catch(() => ({})),
  ]);

  const report = finalize({ ...core, ...intel, ...plan });

  // When the competitive section was grounded in real web results, say so —
  // the default disclaimer ("AI-generated estimates") would understate it.
  if (researchContext?.text && Array.isArray(report.competitors) && report.competitors.length > 0) {
    report.competitors_disclaimer = `Grounded in web results retrieved ${researchContext.retrievedAt}. Figures are directional, not audited.`;
  }

  return report;
}

// One JSON-mode model call with a single fast retry. Before regenerating, we
// try to repair the response (strip code fences / surrounding prose) so a minor
// formatting hiccup doesn't cost a whole extra round-trip. Shared by the pitch
// evaluation sections and the deck audit.
async function callJsonModel(prompt: string, maxTokens: number, label: string): Promise<any> {
  const openai = getOpenAIClient();
  let lastErr: any;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: config.azureOpenAiDeployment || "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.15,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      });
      const rawText = response.choices[0]?.message?.content?.trim() || "";
      if (!rawText) throw new Error("empty response");
      return parseJsonLoose(rawText);
    } catch (err: any) {
      lastErr = err;
      console.error(`❌ Evaluation call "${label}" failed (attempt ${attempt}):`, err.message);
    }
  }
  throw lastErr;
}

// Tolerant JSON parser: handles a clean object, a ```json fenced block, or an
// object embedded in surrounding prose, so a small formatting slip doesn't force
// a full regeneration.
function parseJsonLoose(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* fall through */
      }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Unparseable JSON response");
  }
}

/**
 * Calls OpenAI API to generate the next turn in the conversation.
 */
export async function generatePanelResponse(
  userInput: string,
  history: any[],
  systemInstruction: string
): Promise<string> {
  const openai = getOpenAIClient();
  
  const messages: any[] = [
    { role: "system", content: systemInstruction },
    ...history.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text
    })),
    { role: "user", content: userInput }
  ];

  try {
    const response = await openai.chat.completions.create({
      model: config.azureOpenAiDeployment || "gpt-4o",
      messages: messages,
      temperature: 0.7,
      max_tokens: 320,
    });

    return response.choices[0]?.message?.content || "";
  } catch (err: any) {
    console.error("❌ OpenAI Panel Response Error:", err.message);
    throw err;
  }
}

/**
 * Generates a SHORT, AI-powered "answer tip" for a panelist's question, aligned
 * to what was actually asked (vs. the static keyword library). Returns a compact
 * { term, definition, tip } card or null on any failure — callers must treat
 * null as "no AI tip" and fall back to the local keyword card.
 *
 * Designed to be cheap and non-blocking: tiny token budget, low temperature, and
 * it is fired in PARALLEL with TTS playback on the server, never in the main
 * conversation turn's await path, so it adds no latency to what the founder hears.
 *
 * HARD RULE (kept identical to the static library): give DIRECTION only, never a
 * model answer the founder could read aloud — that would pollute scoring.
 */
export async function generateAnswerTip(
  question: string,
  businessName?: string,
): Promise<{ term: string; definition: string; tip: string } | null> {
  const q = (question || "").trim();
  if (q.length < 8) return null;

  const openai = getOpenAIClient();
  const prompt = `A startup founder is in a live pitch practice. An investor just asked them this:

"${q}"
${businessName ? `\nThe startup is "${businessName}".` : ""}

Produce a tiny on-screen coaching card that helps the founder know HOW to answer THIS specific question. Return ONLY valid JSON: { "term": string, "definition": string, "tip": string }.

RULES:
- "term": the single core concept the investor is probing (e.g. "CAC", "Unit economics", "Go-to-market"). ≤ 24 characters.
- "definition": one plain-language line explaining that concept. ≤ 90 characters.
- "tip": direction on WHAT to talk about to answer well — never a sample answer, never invented numbers. Good: "Explain how you reach customers and roughly what each costs." Forbidden: "Say your CAC is $40." ≤ 120 characters.
- Be specific to what was actually asked. If the question is generic, pick the most relevant concept and give general direction.
- Africa-first framing where natural (agent networks, mobile money, telcos, distributors); keep money references neutral/per-customer.`;

  try {
    const response = await openai.chat.completions.create({
      model: config.azureOpenAiDeployment || "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 160,
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content?.trim() || "";
    if (!raw) return null;
    const parsed = parseJsonLoose(raw);

    const clamp = (v: unknown, max: number) =>
      typeof v === "string" ? v.trim().slice(0, max) : "";
    const term = clamp(parsed?.term, 24);
    const definition = clamp(parsed?.definition, 90);
    const tip = clamp(parsed?.tip, 120);
    if (!term || !tip) return null; // incomplete card — let the caller fall back
    return { term, definition, tip };
  } catch (err: any) {
    console.warn("Answer-tip generation failed (non-fatal):", err?.message || err);
    return null;
  }
}

/**
 * Calls OpenAI API to generate the next turn via a streaming generator.
 */
export async function* streamPanelResponse(
  userInput: string,
  history: any[],
  systemInstruction: string,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const openai = getOpenAIClient();

  const messages: any[] = [
    { role: "system", content: systemInstruction },
    ...history.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text
    })),
    { role: "user", content: userInput }
  ];

  try {
    // Pass the abort signal so the LLM generation itself is cancelled on
    // barge-in — we stop paying for tokens we'll throw away.
    const stream = await openai.chat.completions.create(
      {
        model: config.azureOpenAiDeployment || "gpt-4o",
        messages: messages,
        // Higher temperature than scoring/eval calls: the live panel should vary
        // its questions between sessions instead of sounding scripted.
        temperature: 0.9,
        max_tokens: 320,
        stream: true,
      },
      { signal }
    );

    for await (const chunk of stream) {
      if (signal?.aborted) break;
      const text = chunk.choices[0]?.delta?.content || "";
      if (text) {
        yield text;
      }
    }
  } catch (err: any) {
    // Barge-in aborts surface as AbortError — that's expected, not a failure.
    if (signal?.aborted || err?.name === "AbortError") {
      return;
    }
    console.error("❌ OpenAI Panel Streaming Error:", err.message);
    throw err;
  }
}

/**
 * Validates the OpenAI API key health.
 */
export async function checkApiKeyStatus(): Promise<void> {
  const isAzure = !!(config.azureOpenAiEndpoint && config.azureOpenAiApiKey);
  const isStandard = !!config.openAiApiKey;

  if (!isAzure && !isStandard) {
    console.error("\n🚨 WARNING: No OpenAI or Azure OpenAI keys found in backend/.env!");
    console.error("👉 Please provide either OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY\n");
    return;
  }

  try {
    const openai = getOpenAIClient();
    await openai.chat.completions.create({
      model: config.azureOpenAiDeployment || "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5
    });
    console.log(`\n🟢 OpenAI API Status Check: Connection successful (${isAzure ? 'Azure' : 'Standard'} OpenAI)!\n`);
  } catch (err: any) {
    console.error("\n⚠️ Failed to connect to OpenAI API during startup check:", err.message, "\n");
  }
}

// ── Deck Check: static deck-only audit (no live session) ─────────────────────

export interface DeckAuditReport {
  verdict: "Invest" | "Watch" | "Pass";
  one_liner: string;
  fundability_score: number;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  vc_concerns: string[];
  red_flags: Array<{ flag: string; why: string; fix: string }>;
  sections: Array<{ section: string; status: "strong" | "weak" | "missing"; note: string }>;
}

const DECK_AUDIT_TEXT_LIMIT = 12000;
const DECK_SECTIONS = [
  "Problem", "Solution", "Market", "Business Model",
  "Traction", "Team", "Financials", "Ask",
];

/** Clamp/normalize the model output so a malformed field never 500s the endpoint. */
export function validateDeckAudit(raw: any): DeckAuditReport {
  const src = raw && typeof raw === "object" ? raw : {};
  const str = (v: any, max: number) => String(v ?? "").slice(0, max);
  const strArr = (v: any, maxItems: number, maxLen: number) =>
    (Array.isArray(v) ? v : []).slice(0, maxItems).map((x) => str(x, maxLen)).filter(Boolean);

  const verdictRaw = String(src.verdict || "").toLowerCase();
  const verdict: DeckAuditReport["verdict"] =
    verdictRaw === "invest" ? "Invest" : verdictRaw === "pass" ? "Pass" : "Watch";

  const score = Math.round(Number(src.fundability_score));
  const fundability_score = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;

  const red_flags = (Array.isArray(src.red_flags) ? src.red_flags : [])
    .slice(0, 6)
    .map((r: any) => ({
      flag: str(r?.flag, 120),
      why: str(r?.why, 240),
      fix: str(r?.fix, 240),
    }))
    .filter((r: any) => r.flag);

  const sections = (Array.isArray(src.sections) ? src.sections : [])
    .slice(0, DECK_SECTIONS.length)
    .map((s: any) => ({
      section: DECK_SECTIONS.includes(s?.section) ? s.section : str(s?.section, 40),
      status: (["strong", "weak", "missing"].includes(s?.status) ? s.status : "weak") as
        "strong" | "weak" | "missing",
      note: str(s?.note, 160),
    }))
    .filter((s: any) => s.section);

  return {
    verdict,
    one_liner: str(src.one_liner, 200),
    fundability_score,
    strengths: strArr(src.strengths, 5, 160),
    weaknesses: strArr(src.weaknesses, 5, 160),
    risks: strArr(src.risks, 5, 160),
    vc_concerns: strArr(src.vc_concerns, 5, 160),
    red_flags,
    sections,
  };
}

/**
 * Deck Check: a VC-analyst style pre-screen of an uploaded deck document.
 * No live pitch happened — the audit judges only what the document contains.
 */
export async function auditDeck(deckText: string, deckName: string): Promise<DeckAuditReport> {
  const trimmed = (deckText || "").trim().slice(0, DECK_AUDIT_TEXT_LIMIT);
  const wasTruncated = (deckText || "").trim().length > DECK_AUDIT_TEXT_LIMIT;

  const prompt = `You are a VC analyst running a pre-screen audit on a founder's uploaded pitch deck. No live pitch session occurred — judge ONLY the document content below. Return ONLY valid JSON.

DECK: "${deckName || "Untitled Deck"}"
DECK TEXT (extracted from the uploaded file${wasTruncated ? "; truncated for length — do NOT mark sections missing solely because the text cuts off" : ""}):
${trimmed}

AUDIT RULES:
- verdict: "Invest" (rare — genuinely fundable as-is), "Watch" (promising but gaps to fix), or "Pass" (significant problems). Judge like a real analyst pre-screening inbound decks.
- fundability_score: integer 0-100 for how fundable this deck is as a document (story, evidence, completeness, credibility of claims).
- one_liner: one blunt sentence a VC would say to a colleague about this deck.
- strengths / weaknesses / risks / vc_concerns: 3-5 specific items each, citing actual claims or gaps from THIS deck — never generic advice.
- red_flags: up to 5 serious issues; each with flag (short name), why (why a VC cares), fix (a concrete fix action).
- sections: assess each of ${DECK_SECTIONS.join(", ")} as "strong", "weak" or "missing" with a short note. Infer sections from the text content — the deck may not label them.
- If the text is thin or clearly not a pitch deck, score low and say so plainly in one_liner; do not invent content.

LENGTH BUDGETS (rendered in fixed-size cards — stay within, end on complete sentences):
- one_liner ≤ 180 chars; each list item ≤ 140 chars; red_flags why/fix ≤ 200 chars; section note ≤ 140 chars.

Return this exact JSON structure:
{
  "verdict": "Watch",
  "one_liner": "One blunt analyst sentence about this deck.",
  "fundability_score": 55,
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "weaknesses": ["specific weakness 1", "specific weakness 2", "specific weakness 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "vc_concerns": ["specific concern 1", "specific concern 2", "specific concern 3"],
  "red_flags": [ { "flag": "Short flag name", "why": "Why a VC cares", "fix": "Concrete fix action" } ],
  "sections": [ { "section": "Problem", "status": "strong", "note": "Short note" }, { "section": "Solution", "status": "weak", "note": "Short note" } ]
}`;

  const raw = await callJsonModel(prompt, 2000, "deck-audit");
  return validateDeckAudit(raw);
}
