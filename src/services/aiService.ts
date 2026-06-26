import { config } from "../config/env.ts";

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
 * contradict the score. Meaning: "scored higher than X% of founders".
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

// ── Guard against unstated raise figures (FIX 1.3) ───────────────────────────
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
          // mistaken for verified facts (see FIX 6A).
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
  };
}

const DECK_TEXT_LIMIT = 8000;

const OUTPUT_RULES = `OUTPUT RULES (strict):
- Speak ONLY words a human would say out loud. No asterisks, brackets, headers, stage directions, or chain-of-thought.
- Never describe your plan ("I will ask...", "Let me think...", "Based on the deck...").
- CRITICAL: Keep each turn to 1-2 short, conversational sentences MAXIMUM. One single question per turn.
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

function buildArchetypeDirective(archetype: string): string {
  if (archetype?.includes("Angel")) {
    return "PANEL STYLE: Warm angel group. Lead with encouragement, then dig into founder-market fit and early traction.";
  }
  if (archetype?.includes("Series") || archetype?.includes("Growth")) {
    return "PANEL STYLE: Growth-stage investors. Focus on scalability, margins, and path to Series A metrics.";
  }
  if (archetype?.includes("Shark Tank")) {
    return "PANEL STYLE: Fast-paced consumer investors. Focused on valuation and quick consumer adoption. Say 'I'm out' if the deal is not viable.";
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

  if (isCoach) {
    return `${OUTPUT_RULES}

IDENTITY: Riley — elite startup pitch coach in a live 1-on-1 video session.

STARTUP CONTEXT:
- Name: ${currentBusinessName}
- Concept: ${desc}
- Industry: ${industry}
- Funding Stage: ${fundingStage}

${deckContext}

${toneBlock}
` + `
SESSION FLOW:
1. OPENING (your first turn only): Welcome the founder warmly. Mention one specific detail from their deck or concept. Invite them to deliver their opening pitch.
2. LISTENING: Stay quiet while they present. Do not interrupt or coach until they finish, say "that's my pitch", or ask for feedback.
3. COACHING: Ask one focused question at a time. Tie each question to their deck content or a gap you noticed. Help them tighten narrative, metrics, and clarity.`;
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

PANEL VOICES:
- Marcus: Moat, scalability, valuation, competitive threats.
- Sarah: CAC, LTV, churn, market sizing, unit economics.
- Chen: Architecture, tech debt, build vs buy, engineering velocity.

SPEAKER RULES:
- You must ALWAYS prefix your response with the speaking panelist's name followed by a colon. Example: "Marcus: Your valuation seems high." or "Sarah: Let's talk about CAC."
- CRITICAL: ONLY ONE panelist speaks per turn. NEVER write multiple speakers in one response. Once your chosen panelist asks their 1 question, STOP IMMEDIATELY.
- Rotate naturally between Marcus, Sarah, and Chen across the session — do not let one person dominate.
- Do not add any extra text or stage directions.
- Marcus usually leads the opening, but if the founder specifically asks for someone else (like Sarah or Chen), that panelist should respond immediately.
- When the founder asks a direct question, answer it before asking a new one.

VALIDATION & FACT-CHECKING RULES:
- **Pitch Structure Validation**: If the founder merely introduces themselves and their business but fails to give a proper pitch (e.g. they don't cover problem, solution, market, or metrics), immediately point this out. Tell them that an introduction is not a pitch and ask them to actually pitch their business.
- **Competitor Analysis**: Actively cross-reference the founder's claims against real-world companies. If they claim to have no competitors or claim a unique feature that already exists in products like Stripe, AWS, Shopify, etc., name-drop those real competitors and challenge them.
- **Fact-Checking**: Use your internal knowledge to verify their market sizes, growth rates, and technical feasibility. If their numbers are wildly inaccurate or physically impossible, challenge them aggressively.

SESSION FLOW:
1. OPENING: Marcus welcomes and invites the pitch. Keep it to 1-2 sentences.
2. LISTENING: When the founder is presenting their pitch, DO NOT interrupt. Let them finish their thought before asking questions.
3. STRUCTURED Q&A: After the founder speaks, follow these rules strictly:
   a. ASK ONE QUESTION AT A TIME. Wait for the founder to respond before asking the next question.
   b. FOLLOW UP on the same topic if their answer is weak, unclear, or incomplete. Say something like "That doesn't fully address my concern" or "Can you be more specific about the numbers?"
   c. If the founder gives a WRONG or WEAK response, point it out directly. Example: "That CAC number doesn't add up with your stated LTV" or "You said no competitors, but Stripe already does this."
   d. If the founder does NOT answer or stays silent, gently remind them: "We're still waiting on that answer — this is a critical point that investors will ask about."
   e. Only move to a NEW topic after the current topic has been adequately addressed.
4. TOPIC FLOW: Follow a logical investor evaluation order:
   - First: Problem and solution (What are you building? Why does it matter?)
   - Then: Market size and opportunity (TAM/SAM/SOM)
   - Then: Business model and unit economics (How do you make money?)
   - Then: Traction and metrics (What have you achieved so far?)
   - Then: Team and competitive advantage (Why you? What's your moat?)
   - Finally: Ask and use of funds (How much are you raising? What will you do with it?)
   Do NOT jump randomly between unrelated topics. The conversation should feel like a natural, guided evaluation.
5. SPEAKER COORDINATION: When rotating speakers, the new speaker should build on what was just discussed, not start a completely new topic. For example, if Marcus just asked about revenue, Sarah might follow up with "And what are your margins on that?"
6. CONCLUSION: If the system explicitly states that time is up or the session is ending, immediately stop asking questions and conclude.`;
}

import { OpenAI, AzureOpenAI } from "openai";

function getOpenAIClient() {
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
  mode: string = "panel"
): Promise<EvaluationReport> {
  const transcriptText = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map(m => {
        if (m.type === 'user') {
          const method = m.inputMethod === 'voice' ? '[SPOKEN VIA MICROPHONE]' : '[TYPED IN CHAT]';
          return `FOUNDER ${method}: ${m.text}`;
        } else {
          return `${m.speaker || 'AI'}: ${m.text}`;
        }
      }).join("\n")
    : "No transcript available.";

  const deckSection = deckText?.trim()
    ? `\nPITCH DECK CONTENT (compare against what founder said):\n${deckText.trim().slice(0, 4000)}\n`
    : "";

  const isCoachOrSolo = mode === "coach" || mode === "solo";

  const coachPrompt = `You are Riley, an elite startup pitch coach. Review this coaching session and write a comprehensive development report for your student. Return ONLY valid JSON.

BUSINESS: ${businessName}
${deckSection}
SESSION TRANSCRIPT:
${transcriptText}

COACHING EVALUATION RULES:
- You are writing as a coach evaluating a student, NOT as an investor making an investment decision. Do NOT use language like "invest", "pass", or "fund".
- Score each category (delivery, clarity, scalability, readiness) as integers from 0 to 100.
- IF THE FOUNDER WAS SILENT OR THE SESSION WAS TOO SHORT: Provide low scores and use the summary to gently encourage more participation next time.
- delivery = vocal confidence, pacing, how well they handle coaching questions under pressure.
- clarity = how clearly they explain the problem, solution, and value proposition.
- scalability = how well they understand market size, growth potential, and business model.
- readiness = how prepared they are to face a real investor panel based on this session.
- strengths: Specific things the founder did well — cite real moments from the transcript.
- risks: Gaps, weak answers, or areas that need work before facing investors — be specific and constructive.
- next_steps: Concrete practice actions the founder should do before their next session (e.g. "Sharpen your TAM/SAM/SOM numbers", "Prepare a 30-second revenue model summary").
- sentiments: Write 1 coaching observation from Riley's perspective as the coach — be encouraging but honest.
- Keep summary to 2-3 sentences framed as a coach's overall assessment of the session.

Return this exact JSON structure:
{
  "summary": "2-3 sentence coach assessment of the overall session",
  "scores": { "delivery": 75, "clarity": 80, "scalability": 65, "readiness": 70 },
  "strengths": ["specific strength 1 from the session", "specific strength 2", "specific strength 3"],
  "risks": ["specific gap or weakness 1", "gap 2", "gap 3"],
  "next_steps": [ { "title": "Practice action title", "desc": "Short actionable coaching instruction", "priority": "High Priority" } ],
  "sentiments": [ { "persona": "Riley", "quote": "One honest, encouraging coach observation." } ]
}`;

  // ── Panel evaluation: split into 3 concurrent calls ──────────────────────
  // Faster than one 4096-token monolith (the calls run in parallel), and a parse
  // failure in one section no longer forces the entire report to regenerate.
  const panelCtx = `BUSINESS: ${businessName}
${deckSection}
TRANSCRIPT:
${transcriptText}`;

  const sharedRules = `- NEVER invent a specific fundraising amount; only use a concrete raise figure if the founder explicitly stated it, otherwise say "your target raise".
- Be specific — cite actual topics discussed, not generic advice. Cross-check against the deck when provided.`;

  const corePrompt = `You are an expert pitch evaluator. Analyze this investor pitch and return ONLY valid JSON (the scored core of the report).

${panelCtx}

RULES:
- Score each category (delivery, clarity, scalability, readiness) as integers 0-100.
- IF THE FOUNDER WAS SILENT OR THE PITCH WAS TOO SHORT: do not error; give low/fitting scores (0-10) and a friendly summary noting the lack of material.
- delivery = vocal confidence, pacing, conviction, handling pressure.
- clarity = problem/solution narrative, structure, jargon control.
- scalability = market size, growth model, unit economics, GTM scalability.
- readiness = overall investability for the stated funding stage.
- Keep summary to 2-3 sentences. Include one sentiment quote each for Marcus, Sarah, and Chen.
- topic_coverage: percentage 0-100 for each topic: Problem Definition, Solution Overview, Market Size, Business Model, Go-to-Market, Traction, Team, Financials, Technical Details.
- transcript_summary: 3-5 sentence summary of what was discussed and what was missed.
- question_difficulty: integer counts {easy, medium, hard} of the panel's questions.
- vc_investment_probability: 0-100 chance this pitch earns a VC follow-up meeting.
- category_matrix: for Delivery, Clarity, Scalability, Readiness — went_well + needs_improvement (specific) + impact ("High"/"Moderate"/"Low").
- confidence_timeline: 5 points fluctuating realistically (start, after first hard question, weakest moment, recovery, close).
${sharedRules}

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary",
  "scores": { "delivery": 85, "clarity": 90, "scalability": 75, "readiness": 80 },
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "next_steps": [ { "title": "Action title", "desc": "Short actionable description", "priority": "High Priority" } ],
  "sentiments": [ { "persona": "Marcus", "quote": "One sentence reaction." }, { "persona": "Sarah", "quote": "One sentence reaction." }, { "persona": "Chen", "quote": "One sentence reaction." } ],
  "topic_coverage": [ { "topic": "Problem Definition", "percentage": 90 }, { "topic": "Solution Overview", "percentage": 80 }, { "topic": "Market Size", "percentage": 30 }, { "topic": "Business Model", "percentage": 20 }, { "topic": "Go-to-Market", "percentage": 10 }, { "topic": "Traction", "percentage": 0 }, { "topic": "Team", "percentage": 0 }, { "topic": "Financials", "percentage": 0 }, { "topic": "Technical Details", "percentage": 5 } ],
  "transcript_summary": "3-5 sentence summary of the session",
  "question_difficulty": { "easy": 2, "medium": 3, "hard": 3 },
  "vc_investment_probability": 25,
  "category_matrix": [ { "category": "Delivery", "went_well": "Specific sentence", "needs_improvement": "Specific sentence", "impact": "Moderate" } ],
  "confidence_timeline": [ { "time": "0:00", "value": 80 }, { "time": "1:30", "value": 68 }, { "time": "3:00", "value": 55 }, { "time": "4:30", "value": 45 }, { "time": "6:00", "value": 60 } ]
}`;

  const intelPrompt = `You are a market intelligence analyst. Based on this pitch, return ONLY valid JSON with competitive analysis.

${panelCtx}

RULES:
- competitors: 4 REAL competitors in this founder's specific space (not generic tools). Each: name (real company), similarity (0-100), strength, weakness, size. You do NOT have verified financials — express size as a HEDGED RANGE clearly marked as an estimate (e.g. "Est. ~$10M–$50M ARR" or "approx. mid-market"), never a single precise figure. Use "N/A" if you cannot estimate.
- companies_to_study: 4 companies (not necessarily competitors) this founder should learn from, each with a one-sentence why tailored to this business.
- market_gaps: 3-4 gaps competitors are NOT addressing. Each: title (3-5 words) + desc (one sentence specific to this business).
- collaboration_opportunities: 4 specific strategic collaboration opportunities for this business.
- competitive_landscape.swot: 4 items each for strengths, weaknesses, opportunities, threats.
- competitive_landscape.strategic_recommendation: 2-3 sentences. key_focus_areas: 4 areas.
${sharedRules}

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
- questions_to_prepare: 6 tough investor questions to practice, based on weak areas from this session.
- top_priorities: exactly 5 priority improvements. Each: title (3-5 words), desc (one actionable sentence citing something specific from this pitch), priority ("High Priority"/"Medium Priority"), impact ("Very High"/"High"/"Medium").
- answer_framework: pick the single hardest/most-avoided question from this session; build a 5-step answer framework. question = exact text; steps = [{label, text}].
- practice_drills: 4 drills with title, desc, reps, time.
${sharedRules}

Return this exact JSON structure:
{
  "questions_to_prepare": ["Question 1", "Question 2", "Question 3", "Question 4", "Question 5", "Question 6"],
  "top_priorities": [ { "title": "Priority Title 3-5 words", "desc": "Specific actionable sentence citing this pitch", "priority": "High Priority", "impact": "Very High" } ],
  "answer_framework": { "question": "Hardest question from this session", "steps": [ { "label": "Step Name", "text": "How to answer this step" } ] },
  "practice_drills": [ { "title": "Drill name", "desc": "What to practice", "reps": "3 Reps", "time": "5 min" } ]
}`;

  // One JSON call with a single fast retry. Before regenerating, we try to
  // repair the response (strip code fences / surrounding prose) so a minor
  // formatting hiccup doesn't cost a whole extra round-trip.
  const callJSON = async (prompt: string, maxTokens: number, label: string): Promise<any> => {
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
  };

  const stated = extractStatedFigures(transcriptText);
  const finalize = (raw: any) =>
    validateEvaluationReport(scrubReportRaiseFigures(raw, stated));

  if (isCoachOrSolo) {
    return finalize(await callJSON(coachPrompt, 2048, "coach"));
  }

  // Run the three panel sections concurrently. The core (scored) section is
  // required — if it fails we surface the error so the caller can mark the
  // session as failed. The market-intel and action-plan sections degrade
  // gracefully: a failure leaves those fields absent and the PDF falls back to
  // its defaults rather than failing the whole report.
  const [core, intel, plan] = await Promise.all([
    callJSON(corePrompt, 2048, "core"),
    callJSON(intelPrompt, 1600, "intel").catch(() => ({})),
    callJSON(planPrompt, 1400, "plan").catch(() => ({})),
  ]);

  return finalize({ ...core, ...intel, ...plan });
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
 * Summarizes long voice input into a short sentence.
 */
export async function summarizeVoiceInput(text: string): Promise<string> {
  const openai = getOpenAIClient();
  const prompt = `Summarize the following user voice input into a single, concise sentence (maximum 15 words). Maintain the user's core intent or question. If it's already short, just return it as is.\n\nInput: ${text}`;
  
  try {
    const response = await openai.chat.completions.create({
      model: config.azureOpenAiDeployment || "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 40,
    });
    return response.choices[0]?.message?.content?.trim() || text;
  } catch (err) {
    console.error("Voice summarization failed:", err);
    return text;
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
        temperature: 0.7,
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
