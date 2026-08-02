/**
 * Two-step AI interruption — floor hand-back matching (Item D).
 *
 * When a panelist interrupts, it first signals INTENT only ("hold on, I have a
 * question") and the server holds the conversational floor. The founder's next
 * utterance is not treated as pitch content until they explicitly hand the
 * floor back ("go ahead", "ask away"). This module detects that hand-back.
 *
 * Design mirrors endSessionIntent.ts: dependency-free, instant phrase matching
 * (never an LLM call, so it adds zero turn latency). The mechanic is bounded by
 * the caller — a missed hand-back only makes the panel re-signal once and then
 * ask anyway, so a false negative can never strand the founder.
 */

// Normalize STT/chat text for matching: lowercase, strip most punctuation,
// collapse whitespace. Keeps apostrophes so contractions match cleanly.
function normalize(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Founder yields the floor so the panel can ask. Anchored to short, deliberate
// "the floor is yours" phrasings. A rambling founder who keeps pitching will
// NOT match these (that's the point — they haven't handed the floor back).
const HANDBACK_PATTERNS: RegExp[] = [
  /\bgo (ahead|for it|on)\b/,
  /\b(please )?ask( away| it| your question)?\b/,
  /\b(fire|shoot) away\b/,
  /\bshoot\b/,
  /\bwhat('?s| is) (your|the) question\b/,
  /\b(yes|yeah|yep|sure|okay|ok|of course|absolutely) (go ahead|ask|please)\b/,
  /\bgot a question\b.*\bgo\b/,
  /\bi'?m listening\b/,
  /\b(the )?floor('?s| is) yours\b/,
  /\bwhat (would|did) you (like to|want to)? ?(know|ask)\b/,
  /\b(sorry )?(go|please) (ahead|on)\b/,
];

// A short bare affirmation ("sure", "yes", "okay") is a hand-back ONLY when the
// whole utterance is essentially just that — otherwise "sure, our margins are
// 40 percent" (continued pitching) would falsely yield the floor.
const BARE_AFFIRMATIONS = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "okay",
  "ok",
  "of course",
  "go on",
  "go ahead",
  "please do",
]);

/**
 * True if the founder's utterance hands the conversational floor back to the
 * panel (so the held question may now be asked).
 */
export function detectFloorHandback(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (BARE_AFFIRMATIONS.has(t)) return true;
  // A very short utterance that starts with an affirmation counts too
  // ("yeah go ahead", "okay ask"), but a long one that merely opens with
  // "sure ..." and continues pitching does not.
  const wordCount = t.split(" ").length;
  return HANDBACK_PATTERNS.some((re) => re.test(t)) && wordCount <= 8;
}
