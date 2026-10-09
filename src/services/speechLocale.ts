/**
 * Accent-aware speech recognition settings.
 *
 * Azure Speech has regional English models (Nigeria, Ghana, Kenya, South
 * Africa, ...). Recognising a Nigerian founder with the en-US model was the
 * main reason accented speech came through garbled, so the locale is chosen
 * per session. Azure's automatic language identification cannot pick between
 * two English variants (it works at the language level), so the accent comes
 * from the founder's choice in setup, with a default from the environment.
 */

/** Regional English models offered to founders. Order = display order. */
export const SPEECH_LOCALES: Record<string, string> = {
  "en-NG": "Nigerian English",
  "en-GH": "Ghanaian English",
  "en-KE": "Kenyan English",
  "en-ZA": "South African English",
  "en-TZ": "Tanzanian English",
  "en-GB": "British English",
  "en-IN": "Indian English",
  "en-US": "American English",
};

/** Locale every Azure region supports; the fallback if a regional model fails. */
export const FALLBACK_SPEECH_LOCALE = "en-US";

/**
 * Resolves the recognition locale for a session: the founder's choice if it is
 * one we offer, else the configured default, else en-US. Client input is
 * untrusted, so only exact allowlisted values pass.
 */
export function resolveSpeechLocale(requested: unknown, configuredDefault?: string): string {
  if (typeof requested === "string" && SPEECH_LOCALES[requested]) return requested;
  if (configuredDefault && SPEECH_LOCALES[configuredDefault]) return configuredDefault;
  return FALLBACK_SPEECH_LOCALE;
}

// Words founders say constantly that general-purpose models mishear, plus
// African market terms the en-US model has rarely seen. Fed to the recognizer
// as a phrase list so they are recognised as said.
const PITCH_VOCABULARY = [
  "pre-seed", "seed round", "Series A", "Series B", "angel investor", "term sheet",
  "valuation", "pre-money", "post-money", "cap table", "equity", "SAFE note",
  "runway", "burn rate", "gross margin", "unit economics", "EBITDA", "break-even",
  "CAC", "LTV", "MRR", "ARR", "GMV", "TAM", "SAM", "SOM", "KPI", "MVP", "ROI",
  "churn", "retention", "go-to-market", "B2B", "B2C", "SaaS", "fintech", "agritech",
  "healthtech", "edtech", "proptech", "logistics", "marketplace", "subscription",
  "pilot", "letter of intent", "traction", "product-market fit", "scalability",
  "Naira", "Cedi", "Shilling", "Rand", "kobo",
  "Paystack", "Flutterwave", "M-Pesa", "Moniepoint", "OPay", "Interswitch", "MTN", "Airtel",
  "mobile money", "USSD", "POS agents", "BVN", "CBN", "SEC Nigeria", "NAFDAC",
  "Lagos", "Abuja", "Port Harcourt", "Ibadan", "Kano", "Uyo", "Akwa Ibom", "Enugu",
  "Accra", "Kumasi", "Nairobi", "Mombasa", "Kampala", "Kigali", "Dar es Salaam",
  "Johannesburg", "Cape Town", "Cairo", "Dakar", "Abidjan",
  "Y Combinator", "Techstars", "Tony Elumelu Foundation", "iDICE",
];

/** Azure accepts large phrase lists, but returns diminish; keep it focused. */
const MAX_PHRASES = 250;
const MAX_PHRASE_LEN = 50;
const MAX_DECK_TERMS = 80;

/**
 * Pulls likely names and acronyms out of deck text: ALL-CAPS acronyms
 * ("ARR", "USSD") and Capitalised multi-word names ("Kora Pay", "Lagos
 * Island"). Skips plain sentence-initial words by requiring either an
 * acronym or a run of two or more capitalised words, or a capitalised word
 * that appears at least twice.
 */
export function extractDeckTerms(deckText: string): string[] {
  if (!deckText) return [];
  const text = deckText.slice(0, 20000);
  const counts = new Map<string, number>();
  const bump = (t: string, by = 1) => counts.set(t, (counts.get(t) || 0) + by);

  for (const m of text.matchAll(/\b[A-Z][A-Z0-9&]{1,9}\b/g)) bump(m[0], 2);
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g)) bump(m[0], 2);
  // Capitalised words, including CamelCase product names ("TraderSave").
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)) bump(m[0]);

  const STOP = new Set([
    "The", "This", "That", "These", "Our", "We", "You", "Your", "And", "But", "For", "With",
    "From", "Into", "Over", "What", "Why", "How", "When", "Where", "Who", "Slide", "Page",
    "Problem", "Solution", "Market", "Team", "Traction", "Business", "Model", "Ask", "Thank",
    "Thanks", "Vision", "Mission", "Competition", "Financials", "Product", "Overview",
  ]);
  return [...counts.entries()]
    .filter(([t, n]) => !STOP.has(t) && (n >= 2 || /\s/.test(t) || /^[A-Z0-9&]+$/.test(t)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DECK_TERMS)
    .map(([t]) => t);
}

/**
 * Phrase list for one session: the startup's own name, terms from its deck,
 * then common pitch and African-market vocabulary. Deduplicated
 * case-insensitively and capped.
 */
export function buildSpeechPhrases(opts: {
  businessName?: string;
  industry?: string;
  deckText?: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p !== "string") return;
    const clean = p.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (clean.length < 2 || clean.length > MAX_PHRASE_LEN) return;
    const key = clean.toLowerCase();
    if (seen.has(key) || out.length >= MAX_PHRASES) return;
    seen.add(key);
    out.push(clean);
  };

  add(opts.businessName);
  add(opts.industry);
  for (const t of extractDeckTerms(opts.deckText || "")) add(t);
  for (const t of PITCH_VOCABULARY) add(t);
  return out;
}
