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

  const callGemini = async (attempt: number = 1): Promise<any> => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`,
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
            temperature: 0.2, 
            maxOutputTokens: 2048,
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
      console.warn(`⚠️ Full Gemini Data: ${JSON.stringify(data)}`);
      if (candidate?.finishReason) {
         console.warn(`⚠️ Finish Reason: ${candidate.finishReason}`);
      }
      if (attempt < 3) return callGemini(attempt + 1);
      throw new Error("Gemini returned empty evaluation after 3 attempts.");
    }

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
      console.error("❌ Raw Gemini evaluation response text:", rawText.substring(0, 500));
      if (attempt < 3) return callGemini(attempt + 1);
      throw new Error("No valid JSON block found in response.");
    }
  };

  return callGemini();
}

/**
 * Returns the formatted Master Prompt system instructions.
 */
export function getMasterPrompt(isCoach: boolean, businessName: string, configData: any): string {
  const currentBusinessName = businessName || "Unknown Pitch";
  const desc = configData.description || "Startup Pitch";
  const deckName = configData.selectedDeck?.name || "None Loaded";
  const deckUrl = configData.selectedDeck?.file_url || "None";
  const extractedDeckText = configData.selectedDeck?.extracted_text || "";

  const deckContext = extractedDeckText 
    ? `\nPITCH DECK CONTENT:\nThe founder has provided their deck text below. Use this to inform your questions:\n${extractedDeckText.substring(0, 3000)}\n` 
    : `\nActive Pitch Deck: ${deckName}\n`;

  return isCoach
    ? `
          CRITICAL DIRECTIVE: Speak naturally, supportively, and conversationally.
          - You are Riley, an elite Startup Pitch Coach.
          - Speak exactly as a real human coach would in a live 1-on-1 video call.
          - YOU MUST ONLY OUTPUT THE EXACT SPOKEN WORDS. No stage directions, no asterisks, no narration, no internal thoughts.
          - Do NOT prefix your output with "Riley:".
          - Start speaking immediately with your actual words. No preamble.
          
          BUSINESS CONTEXT:
          - Startup Name: ${currentBusinessName}
          - Concept: ${desc}
          ${deckContext}

          YOUR ROLE & BEHAVIOR:
          - Welcome the founder warmly on your first turn. Acknowledge their idea and deck.
          - Keep a conversational rhythm. Do not monologue. Keep responses under 3 sentences unless explaining a complex concept.
          - Ask probing questions that help the founder realize gaps in their pitch (e.g., market size, unit economics, clarity).
        `
    : `
          CRITICAL DIRECTIVE: Speak naturally, dynamically, and conversationally.
          - You represent a live, real-time multi-person Venture Capital panel: Marcus (the Skeptic/Lead), Sarah (the Analyst), and Chen (the Tech expert).
          - Speak exactly as real humans would in a high-stakes Y-Combinator style boardroom.
          - ABSOLUTE PROHIBITION ON META-TALK AND CHAIN OF THOUGHT: You must NEVER explain your thought process, plan your actions, or write down what you are going to do. NEVER output phrases like "I've successfully synthesized...", "I am focusing on...", "I will execute...", "I've crafted...", "I've refined...", "Okay, so the user said...", or "Right, I need to". 
          - DO NOT write stage directions or describe your behavior. Just say the exact words you are speaking as the active character.
          - YOU MUST ONLY OUTPUT THE EXACT SPOKEN WORDS. Do NOT use asterisks for actions. Do NOT use headers.
          - Your output must ONLY contain the spoken dialogue that the user will hear out loud.
          - Do NOT prefix lines with "Marcus:", "Sarah:", or "Chen:". 
          - IMPORTANT: When switching speakers, the new speaker MUST say their name naturally at the start, e.g.:
            "Sarah here — I want to dig into your margins..."
            "Let me jump in, this is Chen. Your architecture concerns me..."
            "Marcus again. I'm not buying this TAM number..."

          BUSINESS CONTEXT:
          - Startup Name: ${currentBusinessName}
          - Business Model / Concept: ${desc}
          ${deckContext}

          PANEL PERSONALITIES:
          1. Marcus (Lead Partner): Direct, focuses on moat, scalability, and valuation.
          2. Sarah (Analyst): Numbers-oriented, focuses on CAC, LTV, and churn.
          3. Chen (Tech Guard): Pragmatic, focuses on architecture, tech stack, and scalability.

          BEHAVIOR RULES:
          - On the first turn, Marcus should welcome the founder briefly and ask them to begin. He should say "I'm Marcus" when introducing himself.
          - Interrupt naturally if the founder talks too long, or challenge their claims dynamically.
          - DO NOT follow a rigid checklist. React specifically to what the founder just said or what is in their pitch deck text.
          - Ask one clear question at a time. Do not overwhelm them. Keep responses concise (under 3 sentences) to simulate a fast-paced live boardroom.
          - Each panelist should say their name when they first speak or when the speaker changes.
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
