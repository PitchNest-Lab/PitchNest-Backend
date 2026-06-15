import { config } from "../config/env.ts";

/**
 * Interface representing standard evaluation metrics and sentiments returned by Gemini.
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
}

function clampScore(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
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

  return {
    summary: String(raw?.summary || "Evaluation completed."),
    scores: {
      delivery: clampScore(scores.delivery),
      clarity: clampScore(scores.clarity),
      scalability: clampScore(scores.scalability),
      readiness: clampScore(scores.readiness),
    },
    strengths,
    risks,
    next_steps: nextSteps,
    sentiments,
    evaluationStatus: "complete",
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
  deckText?: string
): Promise<EvaluationReport> {
  const transcriptText = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map(m => {
        if (m.type === 'user') {
          const method = m.inputMethod === 'voice' ? '[SPOKEN VIA MICROPHONE]' : '[TYPED IN CHAT]';
          return `FOUNDER ${method}: ${m.text}`;
        } else {
          return `${m.speaker || 'INVESTOR'}: ${m.text}`;
        }
      }).join("\n")
    : "No transcript available.";

  const deckSection = deckText?.trim()
    ? `\nPITCH DECK CONTENT (compare against what founder said):\n${deckText.trim().slice(0, 4000)}\n`
    : "";

  const evaluationPrompt = `You are an expert pitch evaluator. Analyze this investor pitch conversation and return ONLY valid JSON.

BUSINESS: ${businessName}
${deckSection}
TRANSCRIPT:
${transcriptText}

EVALUATION RULES:
- Score each category (delivery, clarity, scalability, readiness) as integers from 0 to 100.
- delivery = vocal confidence, pacing, conviction, handling pressure.
- clarity = problem/solution narrative, structure, jargon control.
- scalability = market size, growth model, unit economics, GTM scalability.
- readiness = overall investability for the stated funding stage.
- Cross-check transcript claims against deck content when deck is provided.
- Be specific — cite actual topics discussed, not generic advice.
- Keep summary to 2-3 sentences. Strengths/risks must reference real content.
- Include one sentiment quote each for Marcus, Sarah, and Chen when panel mode is implied.

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary",
  "scores": { "delivery": 85, "clarity": 90, "scalability": 75, "readiness": 80 },
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "next_steps": [ { "title": "Action title", "desc": "Short actionable description", "priority": "High Priority" } ],
  "sentiments": [ { "persona": "Marcus", "quote": "One sentence reaction." } ]
}`;

  const callOpenAI = async (attempt: number = 1): Promise<any> => {
    try {
      const openai = getOpenAIClient();
      const response = await openai.chat.completions.create({
        model: config.azureOpenAiDeployment || "gpt-4o",
        messages: [{ role: "user", content: evaluationPrompt }],
        temperature: 0.15,
        max_tokens: 1536,
        response_format: { type: "json_object" }
      });

      const rawText = response.choices[0]?.message?.content || "";
      
      if (!rawText || rawText.trim().length === 0) {
        console.warn(`⚠️ OpenAI returned empty response (attempt ${attempt})`);
        if (attempt < 3) return callOpenAI(attempt + 1);
        throw new Error("OpenAI returned empty evaluation after 3 attempts.");
      }

      return JSON.parse(rawText);
    } catch (err: any) {
      console.error(`❌ OpenAI API Error on evaluation (attempt ${attempt}):`, err.message);
      if (attempt < 3) return callOpenAI(attempt + 1);
      throw err;
    }
  };

  const parsed = await callOpenAI();
  return validateEvaluationReport(parsed);
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
 * Calls OpenAI API to generate the next turn via a streaming generator.
 */
export async function* streamPanelResponse(
  userInput: string,
  history: any[],
  systemInstruction: string
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
    const stream = await openai.chat.completions.create({
      model: config.azureOpenAiDeployment || "gpt-4o",
      messages: messages,
      temperature: 0.7,
      max_tokens: 320,
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || "";
      if (text) {
        yield text;
      }
    }
  } catch (err: any) {
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
