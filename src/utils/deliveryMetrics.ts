/**
 * Delivery metrics computed from the REAL transcript.
 *
 * WHY THIS IS ITS OWN MODULE. These numbers originally lived inside
 * pdfService.ts, because the PDF was the only place they appeared. They now feed
 * two consumers — the PDF report and the cross-session founder profile — and a
 * second copy of a filler-word regex is exactly the kind of thing that drifts
 * until the report and the panel disagree about how much filler the founder
 * used. One implementation, imported twice.
 *
 * THE RULE THIS FILE IS BUILT ON: code owns every number, and anything not
 * derivable from the saved transcript is returned as null so the caller renders
 * nothing at all rather than a fabricated placeholder. A founder can personally
 * disprove a wrong number about their own speech, and one discredited figure
 * costs more than the whole feature is worth.
 */

/**
 * Words that read as filler in spoken pitch delivery.
 *
 * Deliberately includes "like" and "actually", which are only filler in
 * context — a phrase-level classifier would be more precise, but it would also
 * need the surrounding words, and this is a trend signal rather than a
 * judgement. Over-counting slightly is acceptable here precisely because the
 * output is only ever compared with itself across sessions.
 */
const FILLER_RE =
  /\b(?:u+m+|u+h+|e+r+|e+h+|a+h+|hmm+|like|y'?know|you know|i mean|sort of|kind of|kinda|sorta|basically|literally|actually)\b/gi;

/**
 * Plausible bounds for speaking rate, in words per minute.
 *
 * Conversational English sits roughly between 100 and 200 WPM; a practised
 * pitch can run higher and a very deliberate one lower. These bounds are NOT
 * used to clamp a value — they are used to REJECT one. A number outside this
 * range means the timing data is wrong, not that the founder speaks at 500 WPM,
 * and the honest answer to bad timing data is "not measured".
 */
const MIN_PLAUSIBLE_WPM = 60;
const MAX_PLAUSIBLE_WPM = 400;

/**
 * How much timed speech a session needs before a rate is worth reporting.
 *
 * One 8-second utterance extrapolated to a per-minute figure is arithmetic on
 * almost nothing. Two turns and half a minute is the smallest sample that still
 * describes the session rather than a fragment of it.
 */
const MIN_TIMED_TURNS = 2;
const MIN_TIMED_SECONDS = 30;

export interface DeliveryMetrics {
  founderWords: number | null;
  fillerPct: number | null;
  questionsAsked: number | null;
  talkRatioPct: number | null;
  /**
   * Speaking rate in words per minute, or null when it cannot be honestly
   * measured.
   *
   * NULL FOR EVERY SESSION RECORDED BEFORE THIS FIELD EXISTED. The transcript
   * carries no per-utterance timing on older rows, so there is nothing to
   * compute from and no way to backfill — the audio was never analysed for
   * speech-versus-silence boundaries. Null here is the correct answer for those
   * rows, not a gap to be filled by estimating.
   */
  paceWpm: number | null;
}

/** Word count by whitespace, which is what the transcript actually preserves. */
const wordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;

/** A finite, positive number, or null. Rejects NaN, Infinity, 0 and strings. */
function positiveOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function computeDeliveryMetrics(transcript: unknown): DeliveryMetrics {
  const empty: DeliveryMetrics = {
    founderWords: null,
    fillerPct: null,
    questionsAsked: null,
    talkRatioPct: null,
    paceWpm: null,
  };
  if (!Array.isArray(transcript) || transcript.length === 0) return empty;

  let founderWords = 0;
  let fillerCount = 0;
  let panelWords = 0;
  let questionsAsked = 0;
  let hasFounderTurn = false;
  // Pace accumulators — see paceWpm above.
  let timedFounderWords = 0;
  let timedSeconds = 0;
  let timedTurns = 0;

  for (const m of transcript as any[]) {
    if (m?.type === "user") {
      hasFounderTurn = true;
      // Voice turns store the verbatim utterance in `fullText`; `text` holds a
      // short summary. Use the raw utterance so word and filler counts reflect
      // what the founder actually said, not the summarized version.
      const raw = String(m.fullText || m.text || "");
      const words = wordCount(raw);
      founderWords += words;
      const fillers = raw.match(FILLER_RE);
      if (fillers) fillerCount += fillers.length;

      // Pace counts only turns the recorder actually timed. A typed answer, or
      // a voice turn from a client that does not report utterance duration,
      // contributes nothing here — see the null rule on paceWpm.
      const spoke = positiveOrNull(m.speakSeconds);
      if (spoke !== null && words > 0) {
        timedTurns += 1;
        timedSeconds += spoke;
        timedFounderWords += words;
      }
    } else if (m?.text) {
      const t = String(m.text);
      panelWords += wordCount(t);
      // A panel turn that contains a question mark counts as one question asked.
      if (/\?/.test(t)) questionsAsked += 1;
    }
  }

  if (!hasFounderTurn) return empty;
  const totalWords = founderWords + panelWords;

  let paceWpm: number | null = null;
  if (timedTurns >= MIN_TIMED_TURNS && timedSeconds >= MIN_TIMED_SECONDS) {
    const rate = Math.round((timedFounderWords / timedSeconds) * 60);
    // Out of range means the timings are bad, not that the founder is unusual.
    if (rate >= MIN_PLAUSIBLE_WPM && rate <= MAX_PLAUSIBLE_WPM) paceWpm = rate;
  }

  return {
    founderWords: founderWords > 0 ? founderWords : 0,
    fillerPct: founderWords > 0 ? Math.round((fillerCount / founderWords) * 100) : null,
    questionsAsked, // 0 is a real, valid answer
    talkRatioPct: totalWords > 0 ? Math.round((founderWords / totalWords) * 100) : null,
    paceWpm,
  };
}

/**
 * How many words the founder actually spoke, or null when there is no transcript.
 * Exported separately because callers that only need this do not want the regex
 * work that computeDeliveryMetrics also does.
 */
export function founderWordCount(transcript: unknown): number | null {
  if (!Array.isArray(transcript) || transcript.length === 0) return null;
  let words = 0;
  let seen = false;
  for (const m of transcript as any[]) {
    if (m?.type !== "user") continue;
    seen = true;
    words += wordCount(String(m.fullText || m.text || ""));
  }
  return seen ? words : null;
}
