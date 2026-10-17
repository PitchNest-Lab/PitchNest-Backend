import "./testEnv.ts";
import assert from "node:assert/strict";
import {
  inferSttLocale,
  localeFromBrowser,
  localeFromRegion,
} from "../utils/transcriptionLocales.ts";
import {
  MAX_SESSION_PHRASES,
  buildSessionPhrases,
  extractTermsFromText,
  mergeSessionPhrases,
} from "../utils/speechPhrases.ts";

// ── Locale from a free-text business region ─────────────────────────────────
assert.equal(localeFromRegion("Lagos, Nigeria"), "en-NG");
assert.equal(localeFromRegion("Nairobi"), "en-KE");
assert.equal(localeFromRegion("accra and kumasi"), "en-GH");
assert.equal(localeFromRegion("Cape Town, South Africa"), "en-ZA");
assert.equal(localeFromRegion("Dar es Salaam"), "en-TZ");
assert.equal(localeFromRegion("Bengaluru, India"), "en-IN");
assert.equal(localeFromRegion("West Africa"), null, "a region naming no country gives no locale");
assert.equal(localeFromRegion("Nigeria and Kenya"), null, "two countries are ambiguous");
assert.equal(localeFromRegion(""), null);
assert.equal(localeFromRegion(42), null);

// ── Locale from browser languages ───────────────────────────────────────────
assert.equal(localeFromBrowser(["en-GH", "en"]), "en-GH");
assert.equal(localeFromBrowser(["en_ke"]), "en-KE", "underscores and case are normalised");
assert.equal(localeFromBrowser(["en-US", "en-GB"]), null, "device-default English says nothing about the speaker");
assert.equal(localeFromBrowser(["fr-FR", "en-NG"]), "en-NG");
assert.equal(localeFromBrowser("en-NG"), null, "non-array input is ignored");
assert.equal(localeFromBrowser([123, null, "x".repeat(40)]), null);

// ── Precedence ──────────────────────────────────────────────────────────────
assert.deepEqual(
  inferSttLocale({ chosen: "en-GB", region: "Lagos", browserLanguages: ["en-KE"] }),
  { locale: "en-GB", source: "setting" },
  "a saved setting always wins",
);
assert.deepEqual(
  inferSttLocale({ chosen: null, region: "Accra", browserLanguages: ["en-KE"] }),
  { locale: "en-GH", source: "business_region" },
);
assert.deepEqual(
  inferSttLocale({ region: "West Africa", browserLanguages: ["en-KE"] }),
  { locale: "en-KE", source: "browser" },
);
assert.deepEqual(
  inferSttLocale({ chosen: "xx-XX", region: "", browserLanguages: ["en-US"], fallback: "en-NG" }),
  { locale: "en-NG", source: "default" },
);

// ── Session vocabulary ──────────────────────────────────────────────────────
const deck = `
AgroLink Africa
The Problem: smallholder farmers in Kano State lose 40% of produce.
AgroLink connects farmers to Shoprite and Jumia buyers through cooperatives.
Our partners: Dangote Foundation, NIRSAL, and the Kano State Ministry of Agriculture.
Traction: 1,200 farmers onboarded across Kano and Kaduna. Kaduna pilot with NIRSAL.
TAM is $2B. Team: Amaka Obi (CEO), Tunde Bello (CTO).
`;
const terms = extractTermsFromText(deck);
for (const expected of ["AgroLink", "NIRSAL", "Kano State", "Dangote Foundation", "Kaduna"]) {
  assert.ok(terms.includes(expected), `deck term "${expected}" is extracted`);
}
assert.equal(terms.includes("TAM"), false, "terms already in the shared pitch list are skipped");
assert.equal(terms.some((t) => /^(the|our|team|problem|traction)$/i.test(t)), false, "slide words are skipped");
assert.equal(terms.some((t) => t.startsWith("The ")), false, "sentence-initial words are trimmed from names");
assert.deepEqual(extractTermsFromText(""), []);
assert.deepEqual(extractTermsFromText(undefined), []);

const phrases = buildSessionPhrases({
  businessName: "AgroLink Africa",
  industry: "Agritech",
  description: "Marketplace linking Kano farmers to Shoprite and Jumia. Shoprite pilot live.",
});
assert.equal(phrases[0], "AgroLink Africa", "the full business name comes first");
assert.ok(phrases.includes("AgroLink"));
assert.ok(phrases.includes("Agritech"));
assert.ok(phrases.includes("Shoprite"));
assert.deepEqual(buildSessionPhrases({ businessName: "Unknown Pitch" }), [], "the placeholder name is not vocabulary");

// Merging dedupes case-insensitively, reports only new terms, and caps.
const current = ["AgroLink"];
assert.deepEqual(mergeSessionPhrases(current, ["agrolink", "Kano", "Kano"]), ["Kano"]);
const many = Array.from({ length: MAX_SESSION_PHRASES + 50 }, (_, i) => `Term${i}`);
const capped: string[] = [];
mergeSessionPhrases(capped, many);
assert.equal(capped.length, MAX_SESSION_PHRASES);

console.log("Speech locale inference and session vocabulary tests passed.");
process.exit(0);
