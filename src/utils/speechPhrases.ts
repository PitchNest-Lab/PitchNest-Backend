import { PITCH_PHRASE_LIST } from "./transcriptionLocales.ts";

/**
 * Per-session vocabulary for the speech recognizer.
 *
 * PITCH_PHRASE_LIST covers the words every pitch shares. What it cannot cover is
 * the words only THIS founder says: their company and product names,
 * competitors, partners, towns, and the acronyms of their industry. Those proper
 * nouns are exactly what recognizers mangle most, for every accent, and a
 * mangled company name lands in the transcript the panel scores.
 *
 * Terms come from text the founder supplied (business name, industry,
 * description, deck). They only bias recognition; they never reach a prompt, so
 * they need length limits, not prompt-injection cleaning.
 */

/** Per-session cap, on top of the shared list. */
export const MAX_SESSION_PHRASES = 120;
const MAX_PHRASE_LENGTH = 50;
/** Deck text beyond this is not scanned; the opening slides carry the names. */
const MAX_SCAN_CHARS = 60_000;

const BASE = new Set(PITCH_PHRASE_LIST.map((p) => p.toLowerCase()));

/** Capitalised words that are capitalised only because they start a sentence
 *  or a slide line, plus generic deck vocabulary. */
const STOPWORDS = new Set(
  [
    "the", "this", "that", "these", "those", "there", "their", "they", "them", "then", "than",
    "we", "our", "ours", "us", "you", "your", "it", "its", "he", "she", "his", "her",
    "a", "an", "and", "or", "but", "if", "so", "not", "no", "yes", "all", "any", "each",
    "in", "on", "for", "with", "to", "of", "at", "by", "from", "as", "into", "over", "per",
    "is", "are", "was", "were", "be", "been", "has", "have", "had", "will", "can", "may",
    "what", "why", "how", "who", "when", "where", "which", "our", "more", "most", "new",
    "slide", "page", "table", "figure", "total", "year", "years", "month", "months",
    "today", "now", "next", "first", "second", "third", "key", "why", "about", "contact",
    "problem", "solution", "market", "traction", "team", "ask", "financials", "business",
    "model", "revenue", "growth", "product", "customers", "customer", "competition",
    "vision", "mission", "summary", "overview", "thank", "thanks", "appendix",
  ].map((w) => w.toLowerCase()),
);

function clean(term: string): string {
  return term
    .replace(/[^\p{L}\p{N}&'.\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.'\-]+|[.'\-]+$/g, "");
}

function usable(term: string): boolean {
  if (term.length < 2 || term.length > MAX_PHRASE_LENGTH) return false;
  const lower = term.toLowerCase();
  if (BASE.has(lower) || STOPWORDS.has(lower)) return false;
  return /\p{L}/u.test(term);
}

/**
 * Ranked distinctive terms from free text: brand-like words (PiggyVest,
 * eNaira), acronyms (NGO, KYB), multi-word proper names (Lagos State) and
 * capitalised words used more than once.
 */
export function extractTermsFromText(text: unknown, limit = MAX_SESSION_PHRASES): string[] {
  if (typeof text !== "string" || !text.trim() || limit <= 0) return [];
  const source = text.slice(0, MAX_SCAN_CHARS);
  const scores = new Map<string, { term: string; score: number }>();

  const bump = (raw: string, weight: number) => {
    // "The Lagos Office" → "Lagos Office": a sentence-initial word is not part
    // of the name.
    const words = clean(raw).split(" ");
    while (words.length > 1 && STOPWORDS.has(words[0].toLowerCase())) words.shift();
    while (words.length > 1 && STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
    const term = words.join(" ");
    if (!usable(term)) return;
    const key = term.toLowerCase();
    const entry = scores.get(key);
    if (entry) entry.score += weight;
    else scores.set(key, { term, score: weight });
  };

  // Brand-like: an inner capital (PiggyVest, eNaira, AgroLink).
  for (const m of source.matchAll(/\b[\p{L}]*\p{Ll}\p{Lu}[\p{L}\p{N}]*\b/gu)) bump(m[0], 3);
  // Acronyms, optionally plural (NGO, NGOs, KYB).
  for (const m of source.matchAll(/\b\p{Lu}[\p{Lu}\p{N}&]{1,7}s?\b/gu)) bump(m[0], 2);
  // Two or three capitalised words in a row (Lagos State, Dangote Group).
  for (const m of source.matchAll(/\b\p{Lu}\p{Ll}{2,}(?:[ ]\p{Lu}\p{Ll}{2,}){1,2}\b/gu)) bump(m[0], 2);
  // Single capitalised words; only kept if they recur (see the filter below).
  for (const m of source.matchAll(/\b\p{Lu}\p{Ll}{3,}\b/gu)) bump(m[0], 1);

  return [...scores.values()]
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((entry) => entry.term);
}

/**
 * The session's starting vocabulary: the business name (whole and its
 * distinctive words), the industry, and terms from the description.
 */
export function buildSessionPhrases(input: {
  businessName?: unknown;
  industry?: unknown;
  description?: unknown;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const term = clean(raw);
    const key = term.toLowerCase();
    if (!usable(term) || seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  const name = typeof input.businessName === "string" ? input.businessName : "";
  if (name && name !== "Unknown Pitch") {
    add(name);
    for (const word of name.split(/\s+/)) if (word.length >= 4) add(word);
  }
  add(input.industry);
  for (const term of extractTermsFromText(input.description, MAX_SESSION_PHRASES)) add(term);

  return out.slice(0, MAX_SESSION_PHRASES);
}

/** Adds `next` to `current` without duplicates, respecting the session cap.
 *  Returns only the terms that were new, for incremental recognizer updates. */
export function mergeSessionPhrases(current: string[], next: string[]): string[] {
  const seen = new Set(current.map((p) => p.toLowerCase()));
  const added: string[] = [];
  for (const term of next) {
    if (current.length >= MAX_SESSION_PHRASES) break;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    current.push(term);
    added.push(term);
  }
  return added;
}
