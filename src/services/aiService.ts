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
}

const DECK_TEXT_LIMIT = 8000;

const OUTPUT_RULES = `OUTPUT RULES (strict):
- Speak ONLY words a human would say out loud. No asterisks, brackets, headers, stage directions, or chain-of-thought.
- Never describe your plan ("I will ask...", "Let me think...", "Based on the deck...").
- Keep each turn to 1-3 short sentences. One question per turn.
- Start speaking immediately — no preamble.`;

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
    aggressiveness >= 75
      ? "Sharp and direct. Push back on weak claims immediately. Interrupt politely when numbers don't add up."
      : aggressiveness >= 45
        ? "Professional and probing. Balance support with tough follow-ups."
        : "Supportive but honest. Ask clarifying questions before challenging.";

  const risk =
    riskAppetite >= 75
      ? "You favor bold bets — reward ambition but still demand proof of execution."
      : riskAppetite >= 45
        ? "Balanced risk lens — weigh upside against burn rate and defensibility."
        : "Conservative lens — prioritize unit economics, retention, and capital efficiency.";

  return `TONE: ${tone}\nRISK LENS: ${risk}`;
}

function buildArchetypeDirective(archetype: string): string {
  if (archetype?.includes("Angel")) {
    return "PANEL STYLE: Warm angel group. Lead with encouragement, then dig into founder-market fit and early traction.";
  }
  if (archetype?.includes("Series")) {
    return "PANEL STYLE: Growth-stage investors. Focus on scalability, margins, and path to Series A metrics.";
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

${deckContext}

${toneBlock}

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

${deckContext}

${buildArchetypeDirective(archetype)}
${toneBlock}

PANEL VOICES:
- Marcus: Moat, scalability, valuation, competitive threats.
- Sarah: CAC, LTV, churn, market sizing, unit economics.
- Chen: Architecture, tech debt, build vs buy, engineering velocity.

SPEAKER RULES:
- Do NOT prefix with "Marcus:" etc. When switching speakers, say their name naturally: "Sarah here — your churn number worries me."
- On your first turn, Marcus welcomes the founder, introduces the panel briefly, and invites the opening pitch.

SESSION FLOW:
1. OPENING: Marcus welcomes and invites the pitch.
2. LISTENING: Panel stays silent during the founder's opening pitch. No questions until they finish or request feedback.
3. Q&A: React to what was just said AND what the deck contains. One clear question per turn. Reference specific deck claims when challenging answers.`;
}

/**
 * Calls Gemini REST API to evaluate the pitch transcript.
 */
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
- Score delivery/clarity from [SPOKEN VIA MICROPHONE] sections when present; note if founder only typed.
- Cross-check transcript claims against deck content when deck is provided.
- Be specific — cite actual topics discussed, not generic advice.
- Keep summary to 2-3 sentences. Strengths/risks must reference real content.

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary",
  "scores": { "delivery": 8, "clarity": 8, "scalability": 8, "readiness": 8 },
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "next_steps": [ { "title": "Action title", "desc": "Short actionable description", "priority": "High Priority" } ],
  "sentiments": [ { "persona": "Marcus", "quote": "One sentence reaction." } ]
}`;

  const callGemini = async (attempt: number = 1): Promise<any> => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: evaluationPrompt }] }],
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ],
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: 1536,
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error(`❌ Gemini HTTP ${response.status} on evaluation (attempt ${attempt}):`, errorBody.substring(0, 300));
      if (attempt < 3) return callGemini(attempt + 1);
      throw new Error(`Gemini returned HTTP ${response.status} after 3 attempts.`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text || "";

    if (!rawText || rawText.trim().length === 0) {
      console.warn(`⚠️ Gemini returned empty response (attempt ${attempt})`);
      if (attempt < 3) return callGemini(attempt + 1);
      throw new Error("Gemini returned empty evaluation after 3 attempts.");
    }

    try {
      return JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (innerErr) {
          console.error("❌ Failed to parse extracted JSON block:", innerErr);
        }
      }
      if (attempt < 3) return callGemini(attempt + 1);
      throw new Error("No valid JSON block found in response.");
    }
  };

  return callGemini();
}

/**
 * Validates the Gemini API key health and checks for 429 quota exhaustion or invalid key errors.
 */
export async function checkApiKeyStatus(): Promise<void> {
  if (!config.geminiApiKey || config.geminiApiKey === "your_gemini_api_key_here") {
    console.error("\n🚨 WARNING: GEMINI_API_KEY is not set or is using the placeholder 'your_gemini_api_key_here' inside your backend/.env file!");
    console.error("👉 Please get a free API Key from AI Studio (https://aistudio.google.com/) and paste it into backend/.env\n");
    return;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }]
        })
      }
    );

    if (res.status === 429) {
      console.error("\n🚨 RESOURCE EXHAUSTED: Your Gemini API Key has run out of its free tier quota limit!");
      console.error("👉 To fix this, please wait a minute or get a fresh API Key from Google AI Studio (https://aistudio.google.com/) and paste it into backend/.env\n");
    } else if (res.status === 400 || res.status === 403) {
      console.error("\n🚨 INVALID API KEY: The Gemini API Key provided is invalid or rejected by Google!");
      console.error("👉 Please verify your key in backend/.env or fetch a new one from https://aistudio.google.com/\n");
    } else if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn(`\n⚠️ Gemini API Status Check: Received HTTP ${res.status}. Message: ${data.error?.message || "Unknown error"}\n`);
    } else {
      console.log("\n🟢 Gemini API Status Check: Connection successful and key quota is healthy!\n");
    }
  } catch (err: any) {
    console.error("\n⚠️ Failed to connect to Gemini API during startup check. Network error:", err.message || err, "\n");
  }
}
