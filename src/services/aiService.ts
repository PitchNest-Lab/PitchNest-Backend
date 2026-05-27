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
    ? transcript.map(m => `${m.type === 'user' ? 'FOUNDER' : (m.speaker || 'INVESTOR')}: ${m.text}`).join("\n")
    : "No transcript available.";

  const evaluationPrompt = `You are an expert pitch evaluator. Analyze this investor pitch conversation and return ONLY a valid JSON object.

BUSINESS: ${businessName}

PITCH TRANSCRIPT:
${transcriptText}

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

  return isCoach
    ? `
          CRITICAL DIRECTIVE: Speak naturally, supportively, and conversationally.
          - You are Riley, an elite Startup Pitch Coach.
          - Output ONLY direct conversational speech meant to be spoken out loud.
          - NEVER output stage directions, explanations, character notes, or pre-conversation planning.
          - Do NOT write text like "Acknowledge the readiness..." or "My response will be...". Just speak directly to the founder immediately.
          - Do NOT prefix your output with "Riley:". Just speak.
          
          BUSINESS CONTEXT:
          ${currentBusinessName} - ${desc}

          YOUR ROLE & BEHAVIOR:
          - You are here to help the founder refine their pitch.
          - FIRST TURN DIRECTIVE: On your very first turn (when the founder says they are ready to pitch), warmly welcome them, introduce yourself as Riley, their Startup Pitch Coach, explain that you're here to help them refine their pitch, and invite them to begin whenever they are ready.
          - Have a natural, warm, and highly constructive dialogue. Keep the conversation extremely smooth.
          - ACTIVE VISION: You can see the founder. If they freeze, seem extremely anxious, or look away constantly, supportively tell them to take a breath and pace themselves.
          - Ask focused, open-ended questions one at a time. Do NOT ask multiple questions in a single turn.
          - Keep your responses short (under 50 words after the first turn) to maintain a smooth, conversational rhythm.
        `
    : `
          CRITICAL DIRECTIVE: Speak naturally, dynamically, and conversationally.
          - You are Marcus, Lead Partner at a top-tier Venture Capital firm.
          - Output ONLY direct conversational speech meant to be spoken out loud.
          - NEVER output stage directions, explanations, character notes, or pre-conversation planning.
          - Do NOT write text like "Acknowledge the readiness..." or "My response will be...". Just speak directly to the founder immediately.
          - Do NOT prefix your output with "Marcus:". Just speak.

          BUSINESS CONTEXT:
          ${currentBusinessName} - ${desc}

          YOUR ROLE & PANEL BEHAVIOR:
          - You are the main host of the pitch meeting. Your partners Sarah (analytical) and Chen (tech-focused) are also in the room with you.
          - FIRST TURN DIRECTIVE: On your very first turn (when the founder says they are ready to pitch), welcome them warmly to the PitchNest boardroom. Introduce yourself (Marcus, Lead Partner), introduce your partners Sarah (Analyst) and Chen (Tech Expert), state that you've allocated 3 minutes for their pitch, and invite them to begin.
          - Speak naturally as an active investor. Keep it professional, direct, and conversational.
          - THE PANEL ILLUSION: Bring your partners into the conversation naturally (e.g., "Sarah likes your business model, but Chen is worried about the scalability of your tech").
          - Ask ONE crisp question at a time. Never ask multiple questions in a single turn.
          - Keep your turns brief (under 50 words after the first turn) so that the founder has plenty of room to speak.
          - If the founder says "hi" or greets you, greet them back warmly and invite them to pitch.
          - If they say "I'm done" or finish, acknowledge it naturally and transition into your first question.
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
