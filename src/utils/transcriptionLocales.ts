/**
 * Speech-to-text locale catalogue — the single source of truth for which
 * recognition languages a founder may choose, and which domain vocabulary the
 * recognizer is biased toward.
 *
 * WHY THIS EXISTS. Recognition used to be hardcoded to "en-US" while the panel
 * prompts explicitly instructed the model to tolerate "Nigerian English and
 * other regional variants" (aiService.ts) and never to penalise transcription
 * artifacts. The prompt was apologising for a problem the config created: Azure
 * transcribes markedly better when the locale matches the speaker, and every
 * mis-transcribed word was flowing straight into the readiness score. For an
 * Africa-first product that was the most consequential line in the codebase, so
 * en-NG is now the DEFAULT rather than an opt-in.
 *
 * WHY AN ALLOWLIST AND NOT FREE TEXT. The chosen value is persisted in the
 * users.settings JSONB bag and handed directly to the Azure SDK. An unrecognised
 * locale there is not a cosmetic problem — it is a failed recognition config at
 * the start of every session. So the value is validated on WRITE (where the
 * setting is saved) and again on READ (where the recognizer is built), and
 * anything unknown falls back to the default rather than reaching the service.
 *
 * WHY ENGLISH-ONLY. The panel speaks English and the whole evaluation pipeline
 * scores English output. Offering fr-FR here would transcribe French speech and
 * then feed it to an English scorer — worse than not offering it at all. When
 * the report has genuinely multilingual support, this list is where that starts.
 *
 * Locale support checked against the Azure Speech language-support table:
 * en-NG, en-KE, en-GH, en-ZA and en-TZ are all supported for real-time
 * (streaming) speech-to-text. Note the same table shows NO post-stream
 * refinement for any African English locale — one more reason to get the locale
 * right up front rather than hoping the model cleans up after us.
 */

/** Used whenever a user has expressed no preference. */
export const DEFAULT_STT_LOCALE = "en-NG";

export interface TranscriptionLocale {
  /** BCP-47 tag passed to the Azure SDK. */
  code: string;
  /** Human label for the settings picker. */
  label: string;
  /** One-line guidance shown under the picker. */
  note?: string;
}

/**
 * Order matters: this is the order the settings picker renders in. African
 * locales lead deliberately — they are the product's core market, and a picker
 * that buries them under en-US teaches founders the wrong default.
 */
export const TRANSCRIPTION_LOCALES: readonly TranscriptionLocale[] = [
  { code: "en-NG", label: "English (Nigeria)", note: "Recommended for Nigerian English." },
  { code: "en-KE", label: "English (Kenya)" },
  { code: "en-GH", label: "English (Ghana)" },
  { code: "en-ZA", label: "English (South Africa)" },
  { code: "en-TZ", label: "English (Tanzania)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "en-US", label: "English (United States)" },
  { code: "en-IN", label: "English (India)" },
];

const SUPPORTED: ReadonlySet<string> = new Set(
  TRANSCRIPTION_LOCALES.map((l) => l.code),
);

/** True when `v` is a locale this app is willing to hand to Azure. */
export function isSupportedSttLocale(v: unknown): v is string {
  return typeof v === "string" && SUPPORTED.has(v);
}

/**
 * Coerces any stored/requested value to something the SDK will accept.
 * Fail-safe by design: an unknown value becomes the default rather than
 * becoming a broken recognizer.
 */
export function resolveSttLocale(
  v: unknown,
  fallback: string = DEFAULT_STT_LOCALE,
): string {
  if (isSupportedSttLocale(v)) return v;
  return isSupportedSttLocale(fallback) ? fallback : DEFAULT_STT_LOCALE;
}

// ── Automatic locale ─────────────────────────────────────────────────────────
//
// Most founders never open Settings, so without inference every unset account
// is recognised as Nigerian English. When the founder has not chosen, the
// locale is inferred from what we already know, most reliable first:
//   1. their business's region (free text, so matched on country and city names)
//   2. a browser language naming a specific African or Indian English variant
//   3. the configured default
// Browser en-US and en-GB are ignored on purpose: they are the factory setting on
// most phones and laptops sold in our markets, so they say nothing about how the
// founder speaks. A founder in the US or UK picks their variant in Settings.

const REGION_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(nigeria|nigerian|lagos|abuja|ibadan|port harcourt|kano|enugu|kaduna)\b/i, "en-NG"],
  [/\b(kenya|kenyan|nairobi|mombasa|kisumu|nakuru|eldoret)\b/i, "en-KE"],
  [/\b(ghana|ghanaian|accra|kumasi|tamale|takoradi)\b/i, "en-GH"],
  [/\b(south africa|south african|johannesburg|joburg|cape town|durban|pretoria|gauteng)\b/i, "en-ZA"],
  [/\b(tanzania|tanzanian|dar es salaam|dodoma|arusha|zanzibar|mwanza)\b/i, "en-TZ"],
  [/\b(united kingdom|england|scotland|wales|london|manchester|birmingham)\b/i, "en-GB"],
  [/\b(india|indian|bengaluru|bangalore|mumbai|delhi|hyderabad|chennai|pune)\b/i, "en-IN"],
  [/\b(united states|usa|new york|san francisco|california|texas)\b/i, "en-US"],
];

/** A locale for a free-text region, or null when it names none or several. */
export function localeFromRegion(region: unknown): string | null {
  if (typeof region !== "string" || !region.trim()) return null;
  const text = region.slice(0, 200);
  const matches = new Set(REGION_HINTS.filter(([pattern]) => pattern.test(text)).map(([, code]) => code));
  return matches.size === 1 ? [...matches][0] : null;
}

const BROWSER_TRUSTED_LOCALES: ReadonlySet<string> = new Set(["en-NG", "en-KE", "en-GH", "en-ZA", "en-TZ", "en-IN"]);

/** "en_ng" / "EN-ng" → "en-NG". Non-language-region tags return "". */
function canonicalTag(raw: string): string {
  const [lang, region] = raw.trim().split(/[-_]/);
  return lang && region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : "";
}

/** A trusted locale from navigator.languages, or null. Input is untrusted. */
export function localeFromBrowser(languages: unknown): string | null {
  if (!Array.isArray(languages)) return null;
  for (const raw of languages.slice(0, 5)) {
    if (typeof raw !== "string" || raw.length > 35) continue;
    const tag = canonicalTag(raw);
    if (BROWSER_TRUSTED_LOCALES.has(tag)) return tag;
  }
  return null;
}

export type SttLocaleSource = "setting" | "business_region" | "browser" | "default";

export function inferSttLocale(input: {
  /** The founder's saved setting, if any. */
  chosen?: unknown;
  region?: unknown;
  browserLanguages?: unknown;
  fallback?: string;
}): { locale: string; source: SttLocaleSource } {
  if (isSupportedSttLocale(input.chosen)) return { locale: input.chosen, source: "setting" };
  const fromRegion = localeFromRegion(input.region);
  if (fromRegion) return { locale: fromRegion, source: "business_region" };
  const fromBrowser = localeFromBrowser(input.browserLanguages);
  if (fromBrowser) return { locale: fromBrowser, source: "browser" };
  return { locale: resolveSttLocale(input.fallback), source: "default" };
}

/** Where a locale appears in the picker, for logging. -1 when unknown. */
export function sttLocaleLabel(code: string): string {
  return TRANSCRIPTION_LOCALES.find((l) => l.code === code)?.label ?? code;
}

/**
 * Domain vocabulary the recognizer is biased toward.
 *
 * A phrase list BIASES recognition; it does not constrain it the way a grammar
 * would, so ordinary conversational speech is unaffected. This matters more than
 * it looks: a mis-heard adjective is cosmetic, but a mis-heard METRIC is a wrong
 * number in the transcript, and the transcript is what the panel scores. "CAC"
 * arriving as "cake" does not just read badly — it silently removes a real
 * metric from the founder's answer and can turn a strong answer into a vague one.
 *
 * Kept to short, distinctive, spoken-aloud tokens. Sentences and long clauses
 * make poor phrase-list entries: they dilute the biasing and rarely match a
 * real utterance verbatim.
 */
export const PITCH_PHRASE_LIST: readonly string[] = [
  // ── Metrics and acronyms most likely to be garbled ──────────────────────
  "TAM", "SAM", "SOM", "CAC", "LTV", "ARPU", "ARPPU", "MRR", "ARR", "GMV",
  "EBITDA", "CAGR", "YoY", "QoQ", "MoM", "ROI", "ROAS", "CPM", "CPC", "CPA",
  "NPS", "DAU", "MAU", "KYC", "AML", "API", "SDK", "MVP", "POC", "LOI",
  "GTM", "ICP", "SaaS", "B2B", "B2C", "B2B2C", "D2C", "SKU", "COGS", "OPEX",
  "ESOP", "IPO", "M&A",

  // ── Money, including local denominations ────────────────────────────────
  "naira", "kobo", "NGN", "shillings", "cedis", "rand", "kwacha", "USD",
  "dollars", "basis points",

  // ── Fundraising and legal vocabulary ────────────────────────────────────
  "pre-seed", "seed round", "Series A", "Series B", "cap table",
  "liquidation preference", "SAFE note", "convertible note", "term sheet",
  "due diligence", "valuation cap", "post-money", "pre-money", "dilution",
  "vesting", "cliff", "drag-along", "pro-rata", "lead investor", "syndicate",
  "runway", "burn rate", "bridge round", "down round", "secondary sale",

  // ── Business and unit-economics vocabulary ──────────────────────────────
  "unit economics", "gross margin", "contribution margin", "working capital",
  "cohort retention", "net revenue retention", "payback period",
  "customer acquisition cost", "lifetime value", "take rate",
  "average order value", "repeat rate",

  // ── African market nouns: places, rails, regulators, players ────────────
  "Lagos", "Abuja", "Nairobi", "Accra", "Kampala", "Johannesburg",
  "Cape Town", "M-Pesa", "Flutterwave", "Paystack", "Moniepoint", "PiggyVest",
  "Safaricom", "MTN", "Airtel", "CBN", "NDPR", "NITDA", "SEC Nigeria",
  "AfCFTA", "BVN", "NIN", "CAC Nigeria", "mobile money", "airtime",
  "USSD", "agent network", "remittance", "diaspora", "informal sector",
  "SME", "MSME", "last mile",

  // ── Operating vocabulary ────────────────────────────────────────────────
  "pilot", "proof of concept", "rollout", "onboarding", "churn", "retention",
  "referral", "marketplace", "logistics", "lead generation", "conversion rate",
];
