// Live persona evaluation — runs the REAL panel prompt against the REAL model.
//
// For each investor persona (and toughness level) it plays a full session:
// a simulated founder (same model, fixed fact sheet) pitches, the panel asks
// questions turn by turn, the panel gives final verdicts, and the real
// evaluator scores the transcript. It then measures tone:
//   - stacked questions (more than one "?" in a turn)
//   - harsh language (sarcasm / dismissive phrasing)
//   - acknowledgement rate (turns that credit a good answer)
//   - longest same-topic follow-up streak by one panelist
//   - early walk-outs ("I'm out" in the first half)
//   - verdict mix and report scores
//
// Requires the same AI env as the server (AZURE_OPENAI_* or OPENAI_API_KEY).
// Usage:
//   npx tsx scripts/persona-eval.ts                      # all personas @ 50 and 85
//   PERSONAS="Shark Tank Judge,Angel Investor Group" LEVELS=85 TURNS=6 npx tsx scripts/persona-eval.ts
// Writes reports/persona-eval-<timestamp>.md (gitignored).
import fs from "fs";
import path from "path";
import {
  getMasterPrompt,
  generatePanelResponse,
  getOpenAIClient,
  evaluatePitch,
  buildVerdictInstruction,
  computeOverallScore,
  PERSONA_PROFILES,
} from "../src/services/aiService.ts";
import { config } from "../src/config/env.ts";
import { splitVerdictsBySpeaker } from "../src/utils/verdictSplit.ts";

const PERSONAS = (process.env.PERSONAS || Object.keys(PERSONA_PROFILES).join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
const LEVELS = (process.env.LEVELS || "50,85").split(",").map(Number).filter(Number.isFinite);
const TURNS = Number(process.env.TURNS || 7);
const SESSION_SECONDS = 8 * 60;

// A realistic seed founder with deliberate soft spots: a vague CAC on the
// first ask and an honest "don't know yet" on churn. Lets us see whether the
// panel follows up fairly or interrogates.
const FOUNDER_FACTS = `You are Amaka, founder of TraderSave, pitching live to investors. Stay in character.
FACTS (only use these; never invent other numbers):
- Problem: market traders in Lagos lose savings to informal "ajo" collectors who disappear; 70% of traders surveyed (n=212) had lost money this way.
- Product: a USSD + Android savings wallet with daily auto-save, locked goals, and agent cash-in at 40 partner kiosks.
- Stage: Seed. Raising $400k for 12% (post-money ~$3.3M). Use of funds: 50% agent network, 30% product, 20% compliance.
- Traction: launched 5 months ago; 3,100 active savers; $41k saved per month; revenue is 1% fee on withdrawals → about $1.9k MRR, growing ~18% month on month.
- Regulation: operating under a partner microfinance bank's licence; applying for our own PSSP licence, filing planned for Q1.
- Team: you ran ops at a Lagos fintech for 4 years; CTO built USSD rails at a telco.
- CAC: first time asked, say "it's pretty low, mostly word of mouth"; only if pressed, say "about $2.10 per saver blended, agents get a $1 bounty".
- Churn: honestly say you don't have a reliable 6-month churn number yet because you launched 5 months ago, and that 30-day retention is 64%.
STYLE: speak naturally in 1-4 sentences, like a nervous but prepared founder. Answer only what was asked.`;

const OPENING = "Hi everyone, I'm Amaka, founder of TraderSave. Market traders in Lagos lose their savings to informal collectors who vanish — 70% of the traders we surveyed have lost money that way. TraderSave is a USSD and Android savings wallet with daily auto-save and cash-in at partner kiosks. We launched five months ago, we have 3,100 active savers, and we're raising $400k to grow our agent network.";

const HARSH = [
  /\bnaive\b/i, /makes no sense/i, /\bridiculous\b/i, /\bunacceptable\b/i, /come on\b/i,
  /\bseriously\?/i, /you clearly don'?t/i, /you don'?t understand/i, /waste of (my|our) time/i,
  /not investable/i, /\bfrankly\b/i, /\bnonsense\b/i, /i'?m not buying/i, /that'?s a red flag/i,
];
const ACK = /\b(good|great|helpful|fair|love|nice|makes sense|appreciate|clear|strong|i like|impressive|solid|exactly what)\b/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function founderReply(panelLine: string, history: string[]): Promise<string> {
  const openai = getOpenAIClient();
  const res = await openai.chat.completions.create({
    model: config.azureOpenAiDeployment || "gpt-4o",
    messages: [
      { role: "system", content: FOUNDER_FACTS },
      { role: "user", content: `Conversation so far:\n${history.slice(-8).join("\n")}\n\nThe investor just said: "${panelLine}"\nReply as Amaka.` },
    ],
    max_completion_tokens: 400,
  });
  return (res.choices[0]?.message?.content || "").trim() || "Sorry, could you repeat that?";
}

function splitSpeaker(raw: string): { speaker: string; text: string; interest: string | null } {
  const interest = raw.match(/@@INTEREST\s+([^\n]*)/i)?.[1]?.trim() || null;
  const spoken = raw.replace(/@@INTEREST[^\n]*/gi, "").replace(/@@FLOOR[^\n]*/gi, "").trim();
  const m = spoken.match(/^\**([A-Za-z]+)\**\s*:\s*/);
  return m
    ? { speaker: m[1], text: spoken.slice(m[0].length).trim(), interest }
    : { speaker: "Marcus", text: spoken, interest };
}

interface RunResult {
  persona: string;
  level: number;
  turns: number;
  stacked: number;
  harshHits: string[];
  ackRate: number;
  maxStreak: number;
  earlyOut: boolean;
  interest: Record<string, number>;
  verdicts: Record<string, string>;
  overall: number | null;
  scores: any;
  transcriptLines: string[];
  error?: string;
}

async function runSession(persona: string, level: number): Promise<RunResult> {
  const r: RunResult = {
    persona, level, turns: 0, stacked: 0, harshHits: [], ackRate: 0, maxStreak: 0,
    earlyOut: false, interest: {}, verdicts: {}, overall: null, scores: null, transcriptLines: [],
  };
  const system = getMasterPrompt(false, "TraderSave", {
    description: "USSD + Android savings wallet for Lagos market traders",
    industry: "Fintech",
    fundingStage: "Seed",
    investorArchetype: persona,
    aggressiveness: level,
    riskAppetite: 60,
  });

  const history: Array<{ role: string; text: string }> = [];
  const transcript: any[] = [];
  const lines: string[] = [];
  let founderText = OPENING;
  let acks = 0;
  let lastSpeaker = "";
  let streak = 0;

  try {
    for (let t = 0; t < TURNS; t++) {
      const timeLeft = Math.round(SESSION_SECONDS * (1 - t / TURNS));
      const userInput = `[PITCH TIME REMAINING: ${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, "0")}]\n${founderText}`;
      transcript.push({ type: "user", text: founderText, inputMethod: "voice" });
      lines.push(`**Founder:** ${founderText}`);

      const raw = await generatePanelResponse(userInput, history, system);
      history.push({ role: "user", text: userInput }, { role: "assistant", text: raw });
      const { speaker, text, interest } = splitSpeaker(raw);
      transcript.push({ type: "ai", speaker, text });
      lines.push(`**${speaker}:** ${text}${interest ? `  _(${interest})_` : ""}`);

      r.turns++;
      if ((text.match(/\?/g) || []).length > 1) r.stacked++;
      for (const re of HARSH) if (re.test(text)) r.harshHits.push(`${speaker}: "${text.slice(0, 90)}"`);
      if (ACK.test(text)) acks++;
      streak = speaker === lastSpeaker ? streak + 1 : 1;
      lastSpeaker = speaker;
      r.maxStreak = Math.max(r.maxStreak, streak);
      const state = interest?.match(/=\s*(warming|neutral|cooling|out)/i)?.[1]?.toLowerCase();
      if (state) r.interest[state] = (r.interest[state] || 0) + 1;
      if (/\bi'?m out\b/i.test(text) && t < TURNS / 2) r.earlyOut = true;

      founderText = await founderReply(text, lines);
    }
    transcript.push({ type: "user", text: founderText, inputMethod: "voice" });
    lines.push(`**Founder:** ${founderText}`);

    const verdictRaw = await generatePanelResponse(
      buildVerdictInstruction("Marcus (Lead Investor), Sarah (Financial Analyst), Chen (Technical Partner)"),
      history,
      system,
    );
    const split = splitVerdictsBySpeaker(verdictRaw.replace(/@@INTEREST[^\n]*/gi, ""), ["Marcus", "Sarah", "Chen"]);
    for (const [name, text] of split) {
      const lower = text.toLowerCase();
      r.verdicts[name] = /\bi'?m in\b/.test(lower) && !/\bi'?m out\b/.test(lower) ? "IN"
        : /\bi'?m out\b/.test(lower) ? "OUT" : "ON THE FENCE";
      lines.push(`**Verdict — ${name}:** ${text}`);
    }

    const report = await evaluatePitch(transcript, "TraderSave", "", "panel", null, null, "Seed", SESSION_SECONDS);
    r.scores = report.scores;
    r.overall = computeOverallScore(report.scores);
  } catch (e: any) {
    r.error = e?.message || String(e);
  }
  r.ackRate = r.turns ? Math.round((acks / r.turns) * 100) : 0;
  r.transcriptLines = lines;
  return r;
}

async function main() {
  if (!config.azureOpenAiApiKey && !config.openAiApiKey) {
    console.error("No AI provider configured. Set AZURE_OPENAI_ENDPOINT/API_KEY/DEPLOYMENT (or OPENAI_API_KEY).");
    process.exit(1);
  }
  console.log(`Running ${PERSONAS.length} persona(s) × levels [${LEVELS.join(", ")}], ${TURNS} panel turns each...\n`);

  const results: RunResult[] = [];
  for (const persona of PERSONAS) {
    for (const level of LEVELS) {
      process.stdout.write(`▶ ${persona} @ ${level} ... `);
      const res = await runSession(persona, level);
      results.push(res);
      console.log(res.error ? `ERROR ${res.error}` : `overall ${res.overall}, harsh ${res.harshHits.length}, stacked ${res.stacked}, ack ${res.ackRate}%`);
      await sleep(500);
    }
  }

  const flag = (r: RunResult) =>
    r.error ? "⚠️ error"
    : r.harshHits.length > 0 || r.earlyOut || r.stacked > 1 || r.maxStreak > 3 ? "🔴 review"
    : r.ackRate < 15 ? "🟡 cold"
    : "🟢 ok";

  const out: string[] = [];
  out.push(`# Persona eval — ${new Date().toISOString()}`);
  out.push("");
  out.push(`Model deployment: \`${config.azureOpenAiDeployment || "gpt-4o"}\` · ${TURNS} panel turns per run · simulated seed-stage fintech founder.`);
  out.push("");
  out.push("| Persona | Toughness | Status | Overall | Harsh | Stacked Qs | Ack rate | Max streak | Early out | Verdicts |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const v = Object.entries(r.verdicts).map(([k, x]) => `${k[0]}:${x}`).join(" ");
    out.push(`| ${r.persona} | ${r.level} | ${flag(r)} | ${r.overall ?? "-"} | ${r.harshHits.length} | ${r.stacked} | ${r.ackRate}% | ${r.maxStreak} | ${r.earlyOut ? "yes" : "no"} | ${v || "-"} |`);
  }
  out.push("");
  out.push("**Pass criteria:** 0 harsh hits, 0 early walk-outs, ≤1 stacked-question turn, one panelist never drives more than 3 turns in a row, ack rate ≥15%.");
  out.push("");
  for (const r of results) {
    out.push(`## ${r.persona} @ ${r.level}`);
    if (r.error) out.push(`Error: ${r.error}`);
    if (r.harshHits.length) out.push(`Harsh lines:\n${r.harshHits.map((h) => `- ${h}`).join("\n")}`);
    if (r.scores) out.push(`Scores: ${JSON.stringify(r.scores)} · interest: ${JSON.stringify(r.interest)}`);
    out.push("");
    out.push(...r.transcriptLines.map((l) => `> ${l}\n>`));
    out.push("");
  }

  const dir = path.resolve("reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `persona-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(file, out.join("\n"));
  console.log(`\nReport written to ${file}`);
}

main();
