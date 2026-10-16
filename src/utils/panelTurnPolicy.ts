/**
 * Live panel turn policy — speaker rotation and panelist hand-offs.
 *
 * The prompt asks the panel to rotate speakers and keep follow-ups short, but a
 * model that finds a weak answer keeps drilling it: one 10-minute session ran
 * nine straight Sarah turns reconciling unit-economics figures while Marcus and
 * Chen never spoke. And when a panelist passes the floor by name ("Marcus,
 * please close"), nothing triggers the named panelist's turn — the room goes
 * silent and the founder is left thinking the question is theirs.
 *
 * Design mirrors floorControl.ts: dependency-free, instant phrase matching
 * (never an LLM call, so it adds zero turn latency).
 */

export const PANELISTS = ["Marcus", "Sarah", "Chen"] as const;

/** Consecutive turns one panelist may take before another must speak. */
export const MAX_SAME_SPEAKER_TURNS = 3;

const NAME_ALT = PANELISTS.join("|");

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function lastSentence(text: string): string {
  const sentences = (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences[sentences.length - 1] || "";
}

// A hand-off is a request aimed at another panelist, not a passing mention
// ("as Marcus said", "Sarah's point on churn"). Each pattern captures the name.
const HANDOFF_PATTERNS: RegExp[] = [
  // "Marcus, please close…" / "Chen — your take on the stack?"
  new RegExp(
    `^(?:(?:and|so|okay|ok|now|right|well)[,\\s]+)?(${NAME_ALT})\\s*[,:—–-]\\s*(?:please\\b|can you\\b|could you\\b|would you\\b|will you\\b|why don'?t you\\b|go ahead\\b|over to you\\b|your (?:take|thoughts|turn|view|call|read|verdict)\\b|take (?:it|us|over)\\b|close\\b|wrap\\b|bring (?:us|it)\\b|what do you\\b|what'?s your\\b|anything\\b|do you\\b|want to\\b|i'?ll let you\\b)`,
    "i",
  ),
  // "Over to you, Marcus." / "I'll hand it over to Chen."
  new RegExp(
    `\\b(?:over to you|i'?ll (?:hand|pass|turn) it (?:over |back )?to|handing (?:it )?(?:over |back )?to|passing (?:it )?(?:over )?to|let me (?:hand|pass|turn) (?:it )?(?:over |back )?to)\\s*,?\\s*(${NAME_ALT})\\b`,
    "i",
  ),
  // "Marcus will close us out." / "Chen can pick that up."
  new RegExp(
    `^(${NAME_ALT})\\s+(?:will|can|should|is going to|wants to)\\s+(?:close|wrap|take|pick|follow|jump|weigh|give)\\b`,
    "i",
  ),
  // Trailing vocative question: "What's your read, Chen?" — but not a
  // statement like "Good point, Sarah."
  new RegExp(`,\\s*(${NAME_ALT})\\s*\\?+$`, "i"),
];

/**
 * The panelist the speaker handed the floor to at the END of their turn, or
 * null. Only the final sentence counts — a hand-off mid-turn followed by the
 * speaker's own question to the founder still leaves the founder on the spot.
 * A panelist "handing off" to themself is ignored.
 */
export function detectPanelHandoff(spokenText: string, speaker: string): string | null {
  const sentence = lastSentence(spokenText);
  if (!sentence) return null;
  for (const re of HANDOFF_PATTERNS) {
    const m = sentence.match(re);
    if (!m) continue;
    const target = capitalize(m[1]);
    if (target.toLowerCase() === (speaker || "").toLowerCase()) return null;
    return target;
  }
  return null;
}

/** True when the founder addressed a panelist by name this turn. */
export function founderNamesPanelist(text: string): boolean {
  return new RegExp(`\\b(?:${NAME_ALT})\\b`, "i").test(text || "");
}

/**
 * Turn metadata forcing a different panelist and a fresh area once one
 * panelist has held the floor for MAX_SAME_SPEAKER_TURNS turns in a row, or ""
 * when none is needed. The founder naming a panelist always wins: if they ask
 * Sarah something directly, Sarah answers even on a streak.
 */
export function buildRotationDirective(
  lastSpeaker: string | null,
  streak: number,
  founderText: string,
): string {
  if (!lastSpeaker || streak < MAX_SAME_SPEAKER_TURNS) return "";
  if (founderNamesPanelist(founderText)) return "";
  const others = PANELISTS.filter((p) => p.toLowerCase() !== lastSpeaker.toLowerCase());
  return (
    `[TURN DIRECTIVE: ${lastSpeaker} has taken the last ${streak} panel turns. ` +
    `${lastSpeaker} does not speak this turn. Treat the founder's latest answer as final for that thread — ` +
    `carry any remaining gap in your @@INTEREST concern instead of asking about it again — ` +
    `and have ${others.join(" or ")} open a different area of the pitch.]`
  );
}

/** System cue for the panelist a hand-off named, so they actually speak. */
export function buildHandoffCue(from: string, to: string): string {
  return (
    `[SYSTEM: ${from} just handed the floor to ${to}. ${to} — speak now, in your own voice, ` +
    `picking up exactly what ${from} asked of you. Address the founder, 1-2 sentences, ` +
    `and end with at most one question for the founder. Do not hand the floor on to anyone else.]`
  );
}
