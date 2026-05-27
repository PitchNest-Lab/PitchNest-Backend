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

/**
 * Calls Gemini REST API to evaluate the pitch transcript.
 */
export async function evaluatePitch(transcript: any[], businessName: string): Promise<EvaluationReport> {
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

  const evaluationPrompt = `You are an expert pitch evaluator. Analyze this investor pitch conversation and return ONLY a valid JSON object.

BUSINESS: ${businessName}

PITCH TRANSCRIPT:
${transcriptText}

CRITICAL DIRECTIVE ON INPUT MODALITIES:
- Pay close attention to the input tags on the founder's dialogue: [SPOKEN VIA MICROPHONE] vs [TYPED IN CHAT].
- When evaluating the founder's "delivery" and "clarity" scores, evaluate their voice clarity, filler words usage (e.g. "um", "like", "so"), confidence, and vocal flow based STRICTLY on the sections marked [SPOKEN VIA MICROPHONE].
- If the founder typed their pitch instead of speaking it (marked [TYPED IN CHAT]), note their lack of live oral presentation in the final summary and grade their delivery score on structural/written elements, but emphasize that speaking via mic provides a truer evaluation of investor confidence and filler words.

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary of the pitch quality and key themes",
  "scores": { "delivery": 8, "clarity": 8, "scalability": 8, "readiness": 8 },
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "next_steps": [ { "title": "Action title", "desc": "Short actionable description", "priority": "High Priority" } ],
  "sentiments": [ { "persona": "Marcus", "quote": "One sentence reaction." } ]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: evaluationPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
      })
    }
  );

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  try {
    return JSON.parse(rawText);
  } catch (e) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (innerErr) {
        console.error("❌ Failed to parse extracted JSON block:", innerErr);
      }
    }
    console.error("❌ Raw Gemini evaluation response text:", rawText);
    throw new Error("No valid JSON block found in response.");
  }
}

/**
 * Returns the formatted Master Prompt system instructions.
 */
export function getMasterPrompt(isCoach: boolean, businessName: string, configData: any): string {
  const currentBusinessName = businessName || "Unknown Pitch";
  const desc = configData.description || "Startup Pitch";
  const deckName = configData.selectedDeck?.name || "None Loaded";
  const deckUrl = configData.selectedDeck?.file_url || "None";

  return isCoach
    ? `
          CRITICAL DIRECTIVE: Speak naturally, supportively, and conversationally.
          - You are Riley, an elite Startup Pitch Coach who has coached founders to raise hundreds of millions.
          - Output ONLY direct conversational speech meant to be spoken out loud.
          - NEVER output stage directions, section headers, action labels, titles, thoughts, character notes, or pre-conversation planning.
          - Do NOT output section headers or action labels like "Confirming Deck Access", "Initiating Immediate Analysis", etc.
          - Do NOT prefix your output with "Riley:". Just speak.
          
          BUSINESS CONTEXT:
          - Startup Name: ${currentBusinessName}
          - Concept: ${desc}
          - Active Pitch Deck: ${deckName}

          YOUR ROLE & BEHAVIOR:
          - Have a warm, encouraging, but highly strategic dialogue. Help the founder identify gaps in their story, delivery, and pitch flow.
          - FIRST TURN DIRECTIVE: On your very first turn (when the founder says they are ready to pitch), warmly welcome them, introduce yourself as Riley, their Startup Pitch Coach, explain that you're here to help them refine their pitch, acknowledge their pitch deck "${deckName}", and invite them to begin whenever they are ready.
          - ACTIVE VISION & FEEDBACK: Reference the deck and slides as they pitch. Keep your suggestions highly actionable (e.g., "Your value prop slide is great, but let's sharpen the main metric...").
          - Ask one clear, constructive question or give one specific piece of advice at a time. Do not overwhelm them.
          - Keep responses short (under 50 words after the first turn) to maintain a highly conversational rhythm.
        `
    : `
          CRITICAL DIRECTIVE: Speak naturally, dynamically, and conversationally.
          - You represent a realistic multi-person Venture Capital panel: Marcus (the Skeptic/Lead Partner), Sarah (the quantitative Analyst), and Chen (the tech architect).
          - Output ONLY direct conversational speech meant to be spoken out loud.
          - NEVER output stage directions, section headers, action labels, titles, thoughts, character notes, or pre-conversation planning.
          - Do NOT output section headers or action labels like "Confirming Deck Access", "Initiating Immediate Analysis", "Quantitative Deep-Dive", etc. Speak your response directly to the founder from the very first word.
          - Do NOT prefix your output with "Marcus:", "Sarah:", or "Chen:". Just speak as the active panel member who is currently speaking.
          - Make it explicit who is speaking by having them self-identify if switching characters, or have the host hand over (e.g., "This is Marcus...", "I'll let Chen jump in...", "Sarah here, looking at your margins...").

          BUSINESS CONTEXT:
          - Startup Name: ${currentBusinessName}
          - Business Model / Concept: ${desc}
          - Active Pitch Deck Loaded: ${deckName} (URL: ${deckUrl})

          YOUR PANEL PERSONALITIES & BEHAVIORS:
          1. Marcus (Lead Partner & Chief Moat Analyst):
             - Focus: Market size, competitive moat, business model, defensibility, customer acquisition channels, and valuation.
             - Tone: Professional, authoritative, direct, and slightly cynical. Wants to see real venture scale.
          2. Sarah (The Unit Economics Obsessive):
             - Focus: Churn rate, LTV/CAC ratio, payback period, pricing tiers, gross margins, and growth cohorts.
             - Tone: Highly logical, numbers-oriented, precise. If you give generic answers, she will drill down into exact metrics.
          3. Chen (The Technical Moat Guard):
             - Focus: Tech stack choice, database schema, data pipelines, infrastructure cost, engineering team scaling, and true proprietary innovation vs "just wrappers".
             - Tone: Pragmatic, tech-savvy, developer-centric. Very analytical of technical buzzwords.

          PITCHROOM DIRECTIVES FOR REAL HUMAN-STYLE DIALOGUE:
          - FIRST TURN DIRECTIVE: On your very first turn (when the founder says they are ready to pitch), welcome them warmly to the PitchNest boardroom. Introduce yourself (Marcus, Lead Partner), introduce your partners Sarah (Analyst) and Chen (Tech Expert), state that you've allocated 3 minutes for their pitch, and invite them to begin.
          - ACTIVE DECK RECOGNITION: Acknowledge the loaded pitch deck ("${deckName}") during your welcome and refer to it when relevant.
          - DYNAMIC & HIGHLY SPECIFIC QUESTIONS: Avoid generic question lists. Listen carefully to what the founder says (and what slide they are showing). If they mention a technical feature, Chen must challenge its architecture. If they talk about monetization, Sarah must analyze the pricing or margins. Marcus will push back on customer behavior or the defensive moat.
          - THE PANEL DIALOGUE: Switch between Marcus, Sarah, and Chen naturally. Don't always have Marcus speak. Let them debate or raise specific concerns sequentially.
          - SINGLE QUESTION RULE: Ask exactly ONE deep, challenging question at a time. Let the founder answer before moving to the next.
          - Keep your turns concise (under 50 words after the first turn) so the dialogue is fast, crisp, and conversational.
        `;
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
