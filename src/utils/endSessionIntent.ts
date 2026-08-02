/**
 * Lightweight, dependency-free intent matching for the voice-triggered
 * "end the session" flow. Runs on each final founder transcript chunk on the
 * server (both STT voice input and typed chat), BEFORE the text is sent to the
 * LLM as a normal pitch turn.
 *
 * Design: deliberately conservative phrase matching, NOT an LLM call — it must
 * be instant and add zero latency/cost to the turn. False positives are made
 * safe by the caller's confirmation step: an accidental match only makes the
 * lead panelist ask "shall we end here?", which the founder can decline by
 * simply continuing to talk. Nothing ends without an explicit affirmation.
 *
 * Known limitations (documented for the caller):
 * - Phrase-based, so it can miss unusual phrasings ("shut it down", heavy
 *   accents mis-transcribed by STT) → false negative. The founder can always
 *   fall back to the manual End Session button.
 * - Common pitch phrases like "that's all" or "I'm done" can match mid-pitch
 *   → false positive. This is intentionally tolerated because the confirmation
 *   step catches it: the founder says "no"/keeps talking and the pitch resumes
 *   with no state change.
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

// End-of-session intent. Anchored to reasonably specific phrases so ordinary
// pitch narration doesn't constantly trip it (the confirmation step is the
// real safety net, but tighter patterns mean fewer needless confirms).
const END_INTENT_PATTERNS: RegExp[] = [
  /\bend (the |this )?(session|pitch|call|meeting|interview)\b/,
  /\bend it (here|now)\b/,
  /\b(let'?s |can we |could we |shall we )?wrap (this |it )?up\b/,
  /\bwrap up (the |this )?(session|pitch)\b/,
  /\b(let'?s |can we |could we |shall we )(finish|conclude|stop|close|end)\b/,
  /\b(i'?m|i am|we'?re|we are) (all )?(done|finished)( pitching| here| now| with (my|our|the) (pitch|presentation))?\b(?!\s+(with|researching|building|testing|working|talking|explaining|going))/,
  // "I'm done" only as a terminal statement — avoids "I'm done researching X".
  /\bi'?m done\b(?!\s+\w)/,
  /\bthat'?s (my|the) (pitch|presentation)\b/,
  /\bthat'?s it for (me|us|now|my pitch|today)\b/,
  /\bthat'?s all (from me|for me|for now|i (have|had|got))\b/,
  /\b(let'?s |we can )?call it (a day|here|there)?\b/,
  /\bfinish (the |this )?(session|pitch)\b/,
  /\bconclude (the |this )?(session|pitch)\b/,
];

// Affirmative responses to "would you like to end the session here?".
const AFFIRMATIVE_PATTERNS: RegExp[] = [
  /\b(yes|yeah|yep|yup|yah|sure|okay|ok|correct|confirm(ed)?|absolutely|definitely|indeed)\b/,
  /\b(please do|go ahead|do it|end it|wrap it up|let'?s do it|let'?s end|sounds good|that'?s right|i'?m done|we'?re done)\b/,
];

// Explicit "no, keep going" responses. Checked first — if a reply is negative
// it is never treated as an affirmation even if it also contains "yes"-ish
// noise from mis-transcription.
const NEGATIVE_PATTERNS: RegExp[] = [
  /\b(no|nope|nah|not yet|not now|not done|not finished|keep going|keep pitching|carry on|continue|let'?s continue|hold on|wait|don'?t|do not|never mind|cancel)\b/,
];

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/** True if the founder's utterance expresses intent to end the session. */
export function detectEndSessionIntent(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  return anyMatch(END_INTENT_PATTERNS, t);
}

/**
 * Classify the founder's reply to the confirmation question.
 * "affirm"  → end the session.
 * "decline" → negative OR anything ambiguous (safe default: keep pitching).
 */
export function classifyConfirmationReply(text: string): "affirm" | "decline" {
  const t = normalize(text);
  if (!t) return "decline";
  if (anyMatch(NEGATIVE_PATTERNS, t)) return "decline";
  if (anyMatch(AFFIRMATIVE_PATTERNS, t)) return "affirm";
  return "decline";
}
