/**
 * Conversation windowing for the live panel LLM (Option C).
 *
 * PROBLEM this solves: the panel used to see only the last N raw history
 * entries (`slice(-MAX_LLM_HISTORY)`). Because every founder pause finalizes an
 * STT utterance, and each utterance pushes TWO entries (user + assistant), a
 * long pitch evicted the founder's own early statements — e.g. a stated price —
 * long before Q&A, so the panel would re-ask for facts already given.
 *
 * STRATEGY:
 *  - PIN every founder ("user") entry: their words are the ground-truth record
 *    of what was actually said (pricing, CAC, dates, numbers). Never dropped to
 *    stay in budget.
 *  - Trim OLDEST panel ("assistant") entries first when over the token budget.
 *  - COMPACTION GUARD for pathological length (20+ min pitch): if the pinned
 *    founder text alone exceeds a threshold, compact the OLDEST founder turns
 *    into a single synthetic entry that preserves exact figures VERBATIM (it
 *    copies figure-bearing sentences character-for-character — it never
 *    paraphrases, so the recall bug cannot reappear at extreme length).
 *
 * No extra LLM call, no added latency on the founder's audio path.
 */

export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
}

// Rough token estimate: ~4 chars/token for English. Deliberately simple — the
// budget has generous headroom, so exact tokenization isn't needed.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
}

function entriesTokens(entries: HistoryEntry[]): number {
  return entries.reduce((sum, e) => sum + estimateTokens(e.text), 0);
}

// Approximate size of the master system prompt (getMasterPrompt + playbook +
// personas + optional market snapshot). Reserved out of the budget so the
// windowed history plus the system prompt stays within the target.
export const SYSTEM_PROMPT_TOKEN_ESTIMATE = 2600;

// Total input-token target for history + system prompt. History gets whatever
// is left after the system-prompt reserve (~7.4k tokens).
export const DEFAULT_TOKEN_BUDGET = 10000;

// When the founder's OWN pinned text exceeds this, compaction kicks in. ~4k
// tokens ≈ 3,000 spoken words ≈ a 15-20 min continuous pitch — pathological,
// not a realistic session.
export const FOUNDER_COMPACTION_THRESHOLD = 4000;

// Fraction of the oldest founder turns folded into the verbatim-figures digest
// when the guard fires.
const COMPACTION_OLDEST_FRACTION = 0.4;

// Sentence splitter that keeps the delimiter — used to pull out only the
// figure-bearing sentences verbatim.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Matches sentences that carry a stated figure/fact worth preserving exactly:
// currency (₦, $, £, €, "naira", "NGN"), percentages, plain numbers/counts,
// multipliers (2x), ranges, and metric keywords (CAC, LTV, MRR, ARR, churn,
// runway, margin, price/pricing, per month/user/year). Case-insensitive.
const FIGURE_RE =
  /[₦$£€]\s?\d|\b\d[\d,.]*\s?(?:%|k\b|m\b|bn\b|x\b|naira|ngn|usd|dollars?|users?|customers?|months?|years?|weeks?|days?)|\b\d[\d,.]*\b|\b(?:cac|ltv|mrr|arr|churn|runway|margin|gross|revenue|pricing|price|per\s+(?:month|user|year|seat)|subscription|tier|package)\b/i;

function hasFigure(sentence: string): boolean {
  return FIGURE_RE.test(sentence);
}

/**
 * Builds ONE synthetic founder entry that preserves, verbatim, every
 * figure-bearing sentence from the given (oldest) founder entries. Non-figure
 * chatter is dropped; figure sentences are copied character-for-character so
 * exact pricing/CAC/dates/numbers are never paraphrased or altered.
 */
export function buildVerbatimDigest(oldFounderEntries: HistoryEntry[]): HistoryEntry {
  const kept: string[] = [];
  for (const entry of oldFounderEntries) {
    for (const sentence of splitSentences(entry.text)) {
      if (hasFigure(sentence)) kept.push(sentence);
    }
  }
  const body = kept.length
    ? kept.join("\n")
    : "(no specific figures were stated in the earlier part of the pitch)";
  return {
    role: "user",
    text:
      "[EARLIER PITCH — KEY FACTS STATED VERBATIM BY THE FOUNDER]\n" +
      body +
      "\n[END EARLIER PITCH]",
  };
}

/**
 * Apply the pin-founder + token-budget window to the raw history.
 *
 * @param history        full ordered conversation history (mutated: NO — a new
 *                        array is returned; the caller's array is untouched)
 * @param tokenBudget    total input-token target (history + system prompt)
 * @param systemReserve  tokens reserved for the system prompt
 */
export function applyConversationWindow(
  history: HistoryEntry[],
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
  systemReserve: number = SYSTEM_PROMPT_TOKEN_ESTIMATE,
): HistoryEntry[] {
  const historyBudget = Math.max(0, tokenBudget - systemReserve);

  let founder = history.filter((e) => e.role === "user");
  const panel = history.filter((e) => e.role === "assistant");

  // ── Compaction guard (pathological length) ──────────────────────────────
  // If the founder's OWN pinned text is over threshold, fold the oldest 40%
  // of founder turns into a single verbatim-figures digest so pinned founder
  // memory stops growing unbounded WITHOUT losing any stated figure.
  if (entriesTokens(founder) > FOUNDER_COMPACTION_THRESHOLD && founder.length > 2) {
    const cut = Math.max(1, Math.floor(founder.length * COMPACTION_OLDEST_FRACTION));
    const oldest = founder.slice(0, cut);
    const recent = founder.slice(cut);
    founder = [buildVerbatimDigest(oldest), ...recent];
  }

  // Founder entries are pinned — always kept in full.
  const founderTokens = entriesTokens(founder);

  // Panel entries fill whatever budget remains, newest first (drop oldest).
  let remaining = Math.max(0, historyBudget - founderTokens);
  const keptPanel: HistoryEntry[] = [];
  for (let i = panel.length - 1; i >= 0; i--) {
    const t = estimateTokens(panel[i].text);
    if (t > remaining) break;
    keptPanel.push(panel[i]);
    remaining -= t;
  }
  keptPanel.reverse();

  // Re-interleave into original chronological order. The founder list may have
  // been compacted (a synthetic digest replaces the oldest turns), so it no
  // longer maps 1:1 onto `history`; mergeChronological emits any synthetic
  // digest first, then walks `history` preserving the original relative order
  // of the surviving real founder + panel entries.
  const keptPanelSet = new Set(keptPanel);
  return mergeChronological(history, founder, keptPanelSet);
}

/**
 * Merge founder + surviving-panel entries back into chronological order.
 * `founder` may start with a synthetic digest (not present in `history`); any
 * such leading synthetic entries are emitted first, then the remainder is
 * interleaved by original position.
 */
function mergeChronological(
  history: HistoryEntry[],
  founder: HistoryEntry[],
  keptPanelSet: Set<HistoryEntry>,
): HistoryEntry[] {
  // Split synthetic (not in history) vs real founder entries, preserving order.
  const historySet = new Set(history);
  const synthetic = founder.filter((e) => !historySet.has(e));
  const realFounderSet = new Set(founder.filter((e) => historySet.has(e)));

  const out: HistoryEntry[] = [...synthetic];
  for (const entry of history) {
    if (entry.role === "user" && realFounderSet.has(entry)) out.push(entry);
    else if (entry.role === "assistant" && keptPanelSet.has(entry)) out.push(entry);
  }
  return out;
}
