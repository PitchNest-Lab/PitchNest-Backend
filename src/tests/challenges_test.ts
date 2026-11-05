import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  challengePhase,
  confirmationHash,
  confirmationStates,
  entryEditable,
  finalJudgingScore,
  parsePrizeInput,
  parseProfileScores,
  parseSocialChecks,
  prizePool,
  profileCompleteness,
  profileRubricScore,
  readPrizes,
  readSocialHandles,
  slugifyChallengeTitle,
  validateChallengeInput,
  validateSocialPostUrl,
} from "../services/challengeService.ts";
import {
  discountedAmount,
  normalizeDiscountCode,
  staticRefusal,
  toPublicDiscount,
  validateDiscountInput,
  type DiscountCodeRow,
} from "../services/discountService.ts";
import { entryChecklist, submissionBlockers, toPublicChallenge } from "../controllers/challengeController.ts";
import { toNotificationView } from "../controllers/notificationController.ts";
import { challengeShareDescription, renderChallengeShareDocument } from "../utils/publicChallengeMetadata.ts";

// ─── Phase: status plus the deadline, read on every request ──────────────────
const NOW = new Date("2026-11-10T12:00:00Z");
const window = { starts_at: "2026-11-06T00:00:00+01:00", submission_deadline: "2026-11-18T23:59:00+01:00" };
assert.equal(challengePhase({ status: "draft", ...window }, NOW), "draft");
assert.equal(challengePhase({ status: "published", ...window }, NOW), "upcoming", "published = announced, not yet open");
assert.equal(challengePhase({ status: "open", ...window }, NOW), "open");
assert.equal(
  challengePhase({ status: "open", ...window }, new Date("2026-11-18T23:00:01Z")),
  "closed",
  "an open challenge past its deadline reads closed before anyone moves it on",
);
for (const status of ["closed", "judging", "completed", "cancelled"]) {
  assert.equal(challengePhase({ status, ...window }, NOW), status);
}
assert.equal(challengePhase({ status: "anything-else", ...window }, NOW), "draft");

assert.equal(entryEditable("open", "in_progress"), true);
assert.equal(entryEditable("open", "approved"), true, "before the deadline a founder may still improve an entry");
assert.equal(entryEditable("open", "disqualified"), false);
assert.equal(entryEditable("closed", "submitted"), false, "no late changes");
assert.equal(entryEditable("closed", "needs_correction"), true, "a requested correction stays open after the deadline");
assert.equal(entryEditable("completed", "needs_correction"), false);

// ─── Prizes ──────────────────────────────────────────────────────────────────
const prizes = readPrizes([{ place: 2, amount: 60000 }, { place: 1, amount: 100000 }, { place: 3, amount: 40000 }, { place: 0, amount: 5 }, { place: 4, amount: -1 }]);
assert.deepEqual(prizes.map((p) => p.place), [1, 2, 3], "sorted, invalid places dropped");
assert.equal(prizePool(prizes), 200000, "the pool is the sum of the prizes");
assert.deepEqual(parsePrizeInput([100000, 60000, 40000]).prizes, [
  { place: 1, amount: 100000 },
  { place: 2, amount: 60000 },
  { place: 3, amount: 40000 },
]);
assert.ok(parsePrizeInput([]).error);
assert.ok(parsePrizeInput([100, -5]).error);
assert.ok(parsePrizeInput([10.555]).error, "at most two decimals");

// ─── Social post links ───────────────────────────────────────────────────────
const ok = (platform: any, url: string) => {
  const result = validateSocialPostUrl(platform, url);
  assert.ok("url" in result, `${url} should be accepted: ${JSON.stringify(result)}`);
  return (result as { url: string }).url;
};
const refused = (platform: any, url: unknown) => {
  const result = validateSocialPostUrl(platform, url);
  assert.ok("error" in result, `${String(url)} should be refused`);
  return (result as { error: string }).error;
};
ok("instagram", "https://www.instagram.com/p/C1a2B3c4D5e/");
ok("instagram", "https://instagram.com/reel/C9xYz123AbC/?igsh=abc");
assert.equal(ok("instagram", "https://www.instagram.com/p/C1a2B3c4D5e/#comments"), "https://www.instagram.com/p/C1a2B3c4D5e/", "fragments are dropped");
ok("x", "https://x.com/founder_ng/status/1855012345678901234");
ok("x", "https://twitter.com/founder/status/1855012345678901234/photo/1");
ok("facebook", "https://www.facebook.com/founder.page/posts/pfbid02abc123");
ok("facebook", "https://www.facebook.com/permalink.php?story_fbid=123456&id=789");
ok("facebook", "https://www.facebook.com/share/p/1AbCdEf/");
assert.match(refused("instagram", "https://www.instagram.com/pitchnestapp/"), /post itself/, "a profile is not a post");
assert.match(refused("x", "https://x.com/pitchnestapp"), /post itself/);
assert.match(refused("facebook", "https://www.facebook.com/pitchnestapp"), /post itself/);
assert.match(refused("instagram", "https://x.com/someone/status/1855012345678901234"), /isn't a Instagram link|isn't a/, "the link must match the platform chosen");
refused("instagram", "http://www.instagram.com/p/C1a2B3c4D5e/");
refused("instagram", "https://user:pass@www.instagram.com/p/C1a2B3c4D5e/");
refused("x", "javascript:alert(1)");
refused("x", "https://evil.example/x.com/a/status/1855012345678901234");
refused("x", `https://x.com/a/status/1${"0".repeat(600)}`);
refused("x", 42);

assert.deepEqual(
  readSocialHandles({
    instagram: { handle: "@pitchnestapp", url: "https://instagram.com/pitchnestapp" },
    x: { handle: "@pitchnestapp", url: "https://evil.example/pitchnestapp" },
    tiktok: { handle: "@x", url: "https://tiktok.com/@x" },
  }),
  { instagram: { handle: "@pitchnestapp", url: "https://instagram.com/pitchnestapp" } },
  "only known platforms with their own https links survive",
);

// ─── Business profile completeness (the PUBLIC snapshot) ─────────────────────
const fullSnapshot = {
  slug: "acme", name: "Acme", tagline: "Fast payments", description: "Long enough.", industry: "Fintech", stage: "Seed",
  region: "Nigeria", problem: "Slow transfers", solution: "Instant rails", targetCustomer: "SMEs",
  websiteUrl: "https://acme.example", logoFile: "logo-0123456789abcdef0123456789abcdef.webp",
};
assert.deepEqual(profileCompleteness(fullSnapshot), { missingRequired: [], missingRecommended: [], complete: true, percent: 100 });
const partial = profileCompleteness({ ...fullSnapshot, problem: "  ", targetCustomer: null, logoFile: null });
assert.deepEqual(partial.missingRequired, ["Problem", "Target customers"]);
assert.deepEqual(partial.missingRecommended, ["Logo"]);
assert.equal(partial.complete, false);
assert.equal(profileCompleteness(null).complete, false, "no public snapshot, nothing complete");

// ─── Judging maths ───────────────────────────────────────────────────────────
const rubric = { completeness: 8, problem: 7, solution: 9, market: 6, model: 7, traction: 5 };
assert.equal(profileRubricScore(rubric), 70, "six criteria, 0-10 each, as a 0-100 score");
assert.equal(profileRubricScore({ ...rubric, traction: 11 }), null);
assert.equal(profileRubricScore({ completeness: 8 }), null, "every criterion must be scored");
assert.equal(finalJudgingScore({ bestScore: 80, pitchScoreValid: true, profileScore: 70, pitchWeight: 60 }), 76, "60% pitch, 40% profile");
assert.equal(finalJudgingScore({ bestScore: 80, pitchScoreValid: false, profileScore: 70, pitchWeight: 60 }), 28, "an invalidated pitch counts as zero");
assert.equal(finalJudgingScore({ bestScore: null, pitchScoreValid: true, profileScore: 70, pitchWeight: 60 }), null);
assert.equal(finalJudgingScore({ bestScore: 90, pitchScoreValid: true, profileScore: 50, pitchWeight: 100 }), 90);
assert.ok(parseProfileScores({ ...rubric, market: 6.5 }).error, "whole numbers only");
assert.deepEqual(parseProfileScores(rubric).scores, rubric);
assert.deepEqual(parseSocialChecks({ postPublic: true, tagged: "yes", extra: true }), {
  postPublic: true, scoreScreenshot: false, profileLink: false, tagged: false, collaboration: false, follows: false,
});

// ─── Confirmations: tied to the values they covered ──────────────────────────
const challengeRow: any = {
  prize_currency: "NGN",
  prizes: [{ place: 1, amount: 100000 }, { place: 2, amount: 60000 }, { place: 3, amount: 40000 }],
  ...window,
  winners_announced_on: "2026-11-21",
  social_handles: { instagram: { handle: "@pitchnestapp", url: "https://instagram.com/pitchnestapp" } },
  judging_criteria: "Pitch 60%, profile 40%.",
  pitch_weight: 60,
  eligible_session_modes: ["solo", "panel"],
  min_completed_sessions: 1,
  terms: "Terms.",
  eligibility: "Founders.",
  requirements: "",
  required_plan: "prep",
  confirmations: {},
};
const code: DiscountCodeRow = {
  id: "c1", code: "PCHU01", description: null, percent_off: 50, plans: ["prep"], terms: ["monthly"], periods: 1,
  starts_at: null, ends_at: null, max_redemptions: null, new_customers_only: false, combine_with_offer: false, active: false,
};
assert.ok(confirmationStates(challengeRow, code).every((s) => !s.confirmed && !s.stale), "nothing is confirmed by default");
challengeRow.confirmations = {
  prizes: { by: 5, at: "2026-11-05T00:00:00Z", hash: confirmationHash("prizes", challengeRow, code) },
  discount: { by: 5, at: "2026-11-05T00:00:00Z", hash: confirmationHash("discount", challengeRow, code) },
};
let states = confirmationStates(challengeRow, code);
assert.equal(states.find((s) => s.item === "prizes")?.confirmed, true);
challengeRow.prizes = [{ place: 1, amount: 120000 }, { place: 2, amount: 60000 }, { place: 3, amount: 20000 }];
states = confirmationStates(challengeRow, code);
assert.deepEqual(
  { confirmed: states.find((s) => s.item === "prizes")?.confirmed, stale: states.find((s) => s.item === "prizes")?.stale },
  { confirmed: false, stale: true },
  "changing the prizes after sign-off makes it stale",
);
assert.equal(states.find((s) => s.item === "discount")?.confirmed, true, "activating the code does not change what was confirmed");
assert.equal(
  confirmationStates(challengeRow, { ...code, active: true }).find((s) => s.item === "discount")?.confirmed,
  true,
);
assert.equal(
  confirmationStates(challengeRow, { ...code, percent_off: 60 }).find((s) => s.item === "discount")?.stale,
  true,
  "but changing the discount itself does",
);

// ─── Admin input ─────────────────────────────────────────────────────────────
const validChallenge = validateChallengeInput({
  title: "PitchNest Challenge",
  organizer: "PitchNest",
  tagline: "Practice. Pitch. Showcase. Win!",
  description: "A pitch competition for founders.",
  prizeCurrency: "ngn",
  prizes: [100000, 60000, 40000],
  startsAt: "2026-11-06T00:00:00+01:00",
  submissionDeadline: "2026-11-18T23:59:00+01:00",
  winnersAnnouncedOn: "2026-11-21",
  pitchWeight: 60,
  eligibleSessionModes: ["solo", "panel"],
  socialHandles: { instagram: { handle: "@pitchnestapp", url: "https://instagram.com/pitchnestapp" } },
  status: "open",
  confirmations: { prizes: { hash: "forged" } },
  createdBy: 999,
});
assert.deepEqual(validChallenge.errors, []);
assert.equal(validChallenge.values.prize_currency, "NGN");
assert.equal(validChallenge.values.submission_deadline, "2026-11-18T22:59:00.000Z", "stored in UTC");
for (const key of ["status", "confirmations", "created_by", "createdBy", "results_published_at", "banner_file"]) {
  assert.equal(key in validChallenge.values, false, `${key} cannot be set through the edit form`);
}
assert.ok(validateChallengeInput({ title: "x" }).errors.length > 3, "a new challenge needs its core fields");
assert.ok(
  validateChallengeInput({ startsAt: "2026-11-19T00:00:00Z", submissionDeadline: "2026-11-18T00:00:00Z" }, { partial: true }).errors
    .some((e) => e.includes("before")),
);
assert.ok(validateChallengeInput({ socialHandles: { x: { handle: "@pn", url: "https://evil.example/pn" } } }, { partial: true }).errors.length);
assert.ok(validateChallengeInput({ eligibleSessionModes: ["panel", "karaoke"] }, { partial: true }).errors.length);
assert.ok(validateChallengeInput({ pitchWeight: 101 }, { partial: true }).errors.length);
assert.equal(validateChallengeInput({ requiredPlan: "none" }, { partial: true }).values.required_plan, null);
assert.equal(slugifyChallengeTitle("PitchNest Challenge — Cohort 2!"), "pitchnest-challenge-cohort-2");

// ─── Discount maths and rules ────────────────────────────────────────────────
assert.equal(normalizeDiscountCode(" pchu01 "), "PCHU01");
assert.equal(normalizeDiscountCode("PC-01"), null);
assert.equal(normalizeDiscountCode("AB"), null);
assert.equal(discountedAmount(20800, 50), 10400, "50% off ₦20,800");
assert.equal(discountedAmount(15, 50), 7.5, "50% off $15");
assert.equal(discountedAmount(69.97, 50), 34.99, "half a kobo rounds up, as Postgres ROUND does");
assert.equal(discountedAmount(1990, 33), 1333.3);
const activeCode = { ...code, active: true };
assert.equal(staticRefusal(code, { plan: "pro", term: "monthly" }), "inactive", "a code is off until an admin activates it");
assert.equal(staticRefusal(activeCode, { plan: "prep", term: "monthly" }), null);
assert.equal(staticRefusal(activeCode, { plan: "pro", term: "monthly" }), "not_applicable", "Founder only");
assert.equal(staticRefusal(activeCode, { plan: "prep", term: "annual" }), "not_applicable", "first month only, not a discounted year");
assert.equal(staticRefusal({ ...activeCode, starts_at: "2026-11-20T00:00:00Z" }, { plan: "prep", term: "monthly" }, NOW), "not_started");
assert.equal(staticRefusal({ ...activeCode, ends_at: "2026-11-09T00:00:00Z" }, { plan: "prep", term: "monthly" }, NOW), "expired");
assert.deepEqual(toPublicDiscount(code, NOW), { code: "PCHU01", percentOff: 50, plans: ["prep"], terms: ["monthly"], periods: 1, endsAt: null, active: false });
assert.equal("max_redemptions" in toPublicDiscount(code), false);
const discountInput = validateDiscountInput({ code: "pchu02", percentOff: 50, plans: ["pro"], terms: ["monthly"], maxRedemptions: "", active: true });
assert.deepEqual(discountInput.errors, []);
assert.equal(discountInput.values.max_redemptions, null, "empty means no limit");
assert.ok(validateDiscountInput({ code: "PCHU03", percentOff: 100 }).errors.some((e) => e.includes("percentOff")), "never a free checkout");
assert.ok(validateDiscountInput({ periods: 0 }, { partial: true }).errors.length);
assert.ok(validateDiscountInput({ startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" }, { partial: true }).errors.length);

// ─── The founder's checklist and blockers ────────────────────────────────────
const business = {
  id: "b1", slug: "acme", name: "Acme", role: "owner", published: true, isExample: false,
  missingRequired: [], missingRecommended: [], complete: true, percent: 100, eligible: true,
};
const ready = {
  subscription: "verified" as const, requiredPlan: "prep", completedSessions: 2, minSessions: 1, bestScore: 78,
  business, socialUrl: "https://x.com/a/status/1855012345678901234", profileLinkConfirmed: true,
};
assert.deepEqual(submissionBlockers(ready), []);
assert.deepEqual(
  submissionBlockers({ ...ready, subscription: "pending" }),
  ["Your Founder payment is still being confirmed."],
  "a pending payment never counts as a subscription",
);
assert.ok(submissionBlockers({ ...ready, bestScore: null, completedSessions: 0 }).some((b) => b.includes("session")));
assert.ok(submissionBlockers({ ...ready, business: { ...business, eligible: false, missingRequired: ["Problem"] } }).some((b) => b.includes("Acme")));
const checklist = entryChecklist({ ...ready, hasPublishedBusiness: true, status: "needs_correction", submittedAt: "2026-11-10T00:00:00Z", reviewNote: "Tag @pitchnestapp." });
assert.equal(checklist.length, 9, "every requirement from the brief is a row");
assert.equal(checklist.find((c) => c.key === "socialReview")?.status, "needs_correction");
assert.equal(checklist.find((c) => c.key === "socialReview")?.detail, "Tag @pitchnestapp.");
assert.equal(checklist.find((c) => c.key === "subscription")?.status, "completed");
assert.equal(
  entryChecklist({ ...ready, subscription: "pending", hasPublishedBusiness: true, status: "in_progress", submittedAt: null })
    .find((c) => c.key === "subscription")?.status,
  "pending_verification",
);

// ─── Public projection ───────────────────────────────────────────────────────
const publicView = toPublicChallenge(
  { ...challengeRow, id: "11111111-1111-4111-8111-111111111111", slug: "pitchnest-challenge", title: "PitchNest Challenge", organizer: "PitchNest", tagline: "Practice. Pitch. Showcase. Win!", description: "D", status: "open", created_by: 5, confirmations: { prizes: { by: 5 } }, discount_code_id: "c1", banner_file: null },
  { discount: code, participantCount: 3, results: null, now: NOW },
);
for (const key of ["confirmations", "created_by", "updated_by", "discount_code_id", "status", "promo_enabled"]) {
  assert.equal(key in publicView, false, `${key} stays private`);
}
assert.equal(publicView.phase, "open");
assert.equal(publicView.prizePool, 200000);
assert.equal(publicView.profileWeight, 40);
assert.equal(publicView.results, null);

// ─── Notifications ───────────────────────────────────────────────────────────
const note = toNotificationView({
  notification_id: "n1", type: "challenge_correction", created_at: "2026-11-10T00:00:00Z", read_at: null,
  challenge_title: "PitchNest Challenge", challenge_slug: "pitchnest-challenge", excerpt: "Add your Discover link.",
});
assert.deepEqual(note, {
  id: "n1",
  type: "challenge_correction",
  title: "Your PitchNest Challenge entry needs a correction",
  excerpt: "Add your Discover link.",
  link: "/opportunities/challenges/pitchnest-challenge#my-entry",
  createdAt: "2026-11-10T00:00:00.000Z",
  read: false,
});
assert.equal(
  toNotificationView({ notification_id: "n2", type: "challenge_results", challenge_slug: "pitchnest-challenge", challenge_title: "PitchNest Challenge" })?.link,
  "/opportunities/challenges/pitchnest-challenge#results",
);
assert.equal(toNotificationView({ notification_id: "n3", type: "challenge_joined" }), null, "no slug, no link, no row");

// ─── Migration guards ────────────────────────────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0038_challenges_and_discounts.sql", import.meta.url), "utf8");
assert.match(migration, /CONSTRAINT challenge_participants_one_entry UNIQUE \(challenge_id, user_id\)/, "one entry per founder");
assert.match(migration, /challenge_participants_one_per_place[\s\S]*WHERE placement IS NOT NULL/, "one winner per place");
assert.match(migration, /challenge_participants_one_per_business/, "one entry per business");
assert.match(migration, /percent_off BETWEEN 1 AND 90/, "no free checkouts");
assert.match(migration, /active BOOLEAN NOT NULL DEFAULT FALSE/, "codes start inactive");
assert.match(migration, /'draft'\s*\nON CONFLICT \(slug\) DO NOTHING/, "the seeded challenge is a draft");
assert.match(migration, /v_payment\.billing_mode <> 'manual'/, "a code never discounts an automatic renewal");
assert.match(migration, /REVOKE ALL ON FUNCTION reserve_discount_redemption\([^)]*\)\s*FROM PUBLIC, anon, authenticated;/);
assert.match(migration, /REVOKE ALL ON FUNCTION refresh_challenge_scores\(UUID, UUID\) FROM PUBLIC, anon, authenticated;/);
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0038'/);
assert.doesNotMatch(migration, /evaluation_report\s*->\s*'transcript'/, "scores only; transcripts are never read");

// ─── Link previews: title, tagline and opening sentences, escaped ────────────
const longDescription = `The PitchNest Challenge gives startup founders an opportunity to strengthen their pitching skills, showcase their businesses, and compete for cash prizes.\n\nPractice with AI investors, improve your pitch readiness score, publish your business on PitchNest Discover, and share your progress.`;
const shareText = challengeShareDescription({ title: "PitchNest Challenge", tagline: "Practice. Pitch. Showcase. Win!", description: longDescription });
assert.equal(
  shareText,
  "Practice. Pitch. Showcase. Win! The PitchNest Challenge gives startup founders an opportunity to strengthen their pitching skills, showcase their businesses, and compete for cash prizes.",
  "the tagline, then whole sentences that fit",
);
assert.ok(shareText.length <= 200);
assert.equal(challengeShareDescription({ title: "Demo Day", tagline: "", description: "" }), "Demo Day: a pitch competition hosted by PitchNest.");
const hostile = renderChallengeShareDocument(
  { slug: "demo", title: `"><script>alert(1)</script>`, tagline: "Win & <b>grow</b>", description: "", imageUrl: "https://cdn.example/card.jpg?a=1&b=2" },
  "https://www.pitchnest.app",
  "demo",
);
assert.doesNotMatch(hostile, /<script>|<b>/, "staff text is escaped");
assert.match(hostile, /<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;" \/>/);
assert.match(hostile, /<meta property="og:image" content="https:\/\/cdn\.example\/card\.jpg\?a=1&amp;b=2" \/>/);
assert.match(hostile, /<meta property="og:url" content="https:\/\/www\.pitchnest\.app\/opportunities\/challenges\/demo" \/>/);
const missing = renderChallengeShareDocument(null, "https://www.pitchnest.app", "unavailable");
assert.match(missing, /<meta property="og:image" content="https:\/\/www\.pitchnest\.app\/og-image\.png" \/>/, "the site image when there is nothing to show");
assert.match(missing, /<title>Challenge not found — PitchNest<\/title>/);

console.log("Challenge tests passed.");
process.exit(0);
