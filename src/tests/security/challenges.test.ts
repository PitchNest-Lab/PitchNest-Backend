import "../helpers/testEnv.ts";
import "../helpers/billingFounderEnvEnabled.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import sharp from "sharp";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { signUserToken } from "../helpers/tokens.ts";
import { config } from "../../config/env.ts";

/**
 * Hosted challenges end to end over HTTP (migrations 0038 and 0039), against the real
 * app and an in-memory database: who can see and change what, that every
 * requirement is verified on the server, and the discounted checkout.
 * The SQL functions themselves are proven in scripts/migrations/test-challenges.mjs.
 */

type Row = Record<string, any>;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

/** A chainable query that always fails with `error`, like a refused write. */
function failing(error: Row) {
  const proxy: any = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return (onFulfilled: any, onRejected: any) => Promise.resolve({ data: null, error }).then(onFulfilled, onRejected);
      return () => proxy;
    },
  });
  return proxy;
}

/** The fake, plus the column defaults, unique keys and functions migration 0038 provides. */
class ChallengeDb extends FakeSupabase {
  from(table: string): any {
    const query: any = super.from(table);
    if (table !== "challenge_participants") return query;
    const insert = query.insert.bind(query);
    query.insert = (input: Row | Row[]) => {
      const list = Array.isArray(input) ? input : [input];
      const existing = this.rows(table);
      if (list.some((row) => existing.some((e) => e.challenge_id === row.challenge_id && e.user_id === row.user_id))) {
        return failing({ code: "23505", message: "duplicate key value violates unique constraint \"challenge_participants_one_entry\"" });
      }
      return insert(list.map((row) => ({
        id: crypto.randomUUID(), status: "in_progress", business_id: null, best_session_id: null, best_score: null,
        best_score_at: null, completed_sessions: 0, score_checked_at: null, score_frozen_at: null,
        subscription_verified_at: null, subscription_tx_ref: null, eligible_at: null, social_platform: null,
        social_post_url: null, evidence_file: null, profile_link_confirmed: false, public_name_consent: false,
        rules_accepted_at: null, submitted_at: null, review_note: null, social_checks: {}, reviewed_at: null,
        profile_scores: {}, pitch_score_valid: true, judge_notes: null, shortlisted: false, judged_at: null,
        placement: null, joined_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row,
      })));
    };
    const update = query.update.bind(query);
    query.update = (patch: Row) => {
      if (patch.business_id && this.rows(table).some((e) => e.business_id === patch.business_id)) {
        return failing({ code: "23505", message: "duplicate key value violates unique constraint \"challenge_participants_one_per_business\"" });
      }
      return update(patch);
    };
    return query;
  }

  rpc(name: string, args: any): any {
    if (name === "refresh_challenge_scores") return Promise.resolve({ data: this.refresh(args.p_challenge_id, args.p_participant_id), error: null });
    if (name === "set_challenge_placements") return Promise.resolve(this.place(args));
    if (name === "reserve_discount_redemption") return Promise.resolve(this.reserve(args));
    if (name === "list_public_opportunities") {
      return Promise.resolve({ data: args.p_kind && args.p_kind !== "grant" ? [] : [EXTERNAL], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  /** refresh_challenge_scores, in JavaScript (the SQL is tested on Postgres). */
  refresh(challengeId: string, participantId: string | null): number {
    const challenge = this.rows("challenges").find((c) => c.id === challengeId);
    if (!challenge) return 0;
    const targets = this.rows("challenge_participants")
      .filter((p) => p.challenge_id === challengeId && !p.score_frozen_at && (!participantId || p.id === participantId));
    for (const entry of targets) {
      const scored = this.rows("sessions")
        .filter((s) => s.user_id === entry.user_id && s.created_at >= challenge.starts_at && s.created_at <= challenge.submission_deadline)
        .filter((s) => s.evaluation_report?.evaluationStatus === "complete" && challenge.eligible_session_modes.includes(s.mode))
        .map((s) => {
          const { delivery, clarity, scalability, readiness } = s.evaluation_report.scores;
          return { s, score: Math.round((delivery + clarity + scalability + readiness) / 4) };
        })
        .sort((a, b) => b.score - a.score || (a.s.created_at < b.s.created_at ? -1 : 1));
      Object.assign(entry, {
        best_score: scored[0]?.score ?? null,
        best_session_id: scored[0]?.s.id ?? null,
        best_score_at: scored[0]?.s.created_at ?? null,
        completed_sessions: scored.length,
        score_checked_at: new Date().toISOString(),
      });
    }
    return targets.length;
  }

  place(args: any) {
    const challenge = this.rows("challenges").find((c) => c.id === args.p_challenge_id);
    if (challenge.results_published_at) return { data: null, error: { message: "RESULTS_ALREADY_PUBLISHED" } };
    const entries = this.rows("challenge_participants").filter((p) => p.challenge_id === args.p_challenge_id);
    const places = new Set<number>();
    const winners = new Set<string>();
    for (const item of args.p_placements) {
      if (places.has(item.place)) return { data: null, error: { message: "DUPLICATE_PLACE" } };
      if (winners.has(item.participantId)) return { data: null, error: { message: "DUPLICATE_WINNER" } };
      if (entries.find((e) => e.id === item.participantId)?.status !== "approved") return { data: null, error: { message: "WINNER_NOT_ELIGIBLE" } };
      places.add(item.place);
      winners.add(item.participantId);
    }
    for (const entry of entries) entry.placement = null;
    for (const item of args.p_placements) entries.find((e) => e.id === item.participantId)!.placement = item.place;
    this.rows("admin_audit_log").push({ id: this.allocId(), actor_id: args.p_actor_id, action: "challenge.placements_set", challenge_id: args.p_challenge_id, subject_type: "challenge", subject_id: args.p_challenge_id, metadata: {}, created_at: new Date().toISOString() });
    return { data: args.p_placements.length, error: null };
  }

  reserve(args: any) {
    const code = this.rows("discount_codes").find((c) => c.id === args.p_code_id);
    if (!code?.active) return { data: "inactive", error: null };
    const payment = this.rows("payments").find((p) => p.tx_ref === args.p_tx_ref);
    if (!payment || payment.user_id !== args.p_user_id || payment.amount !== args.p_amount) {
      return { data: null, error: { message: "DISCOUNT_PAYMENT_MISMATCH" } };
    }
    if (payment.billing_mode !== "manual") return { data: "manual_only", error: null };
    if (args.p_amount !== Math.round(args.p_list_amount * (100 - code.percent_off)) / 100) {
      return { data: null, error: { message: "INVALID_DISCOUNT_AMOUNT" } };
    }
    const mine = this.rows("discount_redemptions").filter((r) => r.discount_code_id === code.id && r.user_id === args.p_user_id && r.status === "redeemed");
    if (mine.length >= code.periods) return { data: "already_used", error: null };
    this.rows("discount_redemptions").push({ id: crypto.randomUUID(), discount_code_id: code.id, user_id: args.p_user_id, tx_ref: args.p_tx_ref, status: "pending", list_amount: args.p_list_amount, amount: args.p_amount, currency: args.p_currency, created_at: new Date().toISOString() });
    return { data: "reserved", error: null };
  }
}

const EXTERNAL = {
  opportunity_id: "e1", title: "Lagos Seed Accelerator", organizer: "Example Ventures", kind: "accelerator",
  summary: "A programme for pre-seed founders.", eligibility: null, region: "West Africa", sector: null,
  source_url: "https://example.org/apply", opens_on: null, closes_on: iso(20).slice(0, 10), last_checked_at: iso(-1),
};

const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const CODE_ID = "33333333-3333-4333-8333-333333333333";
const BIZ_A = "44444444-4444-4444-8444-444444444444";
const BIZ_A_DRAFT = "55555555-5555-4555-8555-555555555555";
const BIZ_A_EXAMPLE = "66666666-6666-4666-8666-666666666666";
const BIZ_B = "77777777-7777-4777-8777-777777777777";
const BIZ_C = "88888888-8888-4888-8888-888888888888";

const FOUNDER_A = { id: 401, email: "ada@x.test" };
const FOUNDER_B = { id: 402, email: "bayo@x.test" };
const FOUNDER_C = { id: 403, email: "chi@x.test" };
const STAFF = { id: 409, email: "staff@x.test" };

const snapshot = (slug: string, name: string, extra: Row = {}) => ({
  slug, name, tagline: "Fast payments", description: "A complete description.", industry: "Fintech", stage: "Seed",
  region: "Nigeria", problem: "Slow transfers", solution: "Instant rails", targetCustomer: "SMEs",
  websiteUrl: "https://acme.example", logoFile: null, ...extra,
});
const complete = (scores: [number, number, number, number], mode = "panel", offsetDays = -1) => ({
  user_id: 0, mode, created_at: iso(offsetDays),
  evaluation_report: { evaluationStatus: "complete", scores: { delivery: scores[0], clarity: scores[1], scalability: scores[2], readiness: scores[3] } },
});

const db = new ChallengeDb();
let base = "";
let close: () => Promise<void>;
const realFetch = globalThis.fetch;
const flutterwave: Array<{ path: string; body: any }> = [];
const tokenA = signUserToken(FOUNDER_A);
const tokenB = signUserToken(FOUNDER_B);
const tokenC = signUserToken(FOUNDER_C);
const tokenStaff = signUserToken(STAFF);
const SLUG = "/api/challenges/pitchnest-challenge";

before(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("flutterwave.com")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      flutterwave.push({ path: new URL(url).pathname, body });
      if (new URL(url).pathname === "/v3/payments") {
        return new Response(JSON.stringify({ status: "success", data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/${body.tx_ref}` } }), { status: 200 });
      }
      if (new URL(url).pathname === "/v3/payment-plans") {
        return new Response(JSON.stringify({ status: "success", data: { id: 8800, ...body } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "error" }), { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  db.seed("users", [
    { ...FOUNDER_A, name: "Ada Founder", isEmailVerified: true, plan: "free", plan_expires_at: null },
    { ...FOUNDER_B, name: "Bayo Founder", isEmailVerified: true, plan: "free", plan_expires_at: null },
    { ...FOUNDER_C, name: "Chi Founder", isEmailVerified: true, plan: "pro", plan_expires_at: iso(25) },
    { ...STAFF, name: "Staff Member", isEmailVerified: true, plan: "free", plan_expires_at: null, is_staff: true },
  ]);
  db.seed("payments", [
    { id: 1, user_id: FOUNDER_B.id, tx_ref: "pn-402-1", status: "pending", amount: 7.5, currency: "USD", plan: "pro", term: "monthly", created_at: iso(-0.1) },
    { id: 2, user_id: FOUNDER_C.id, tx_ref: "pn-403-1", status: "successful", amount: 15, currency: "USD", plan: "pro", term: "monthly", created_at: iso(-5) },
  ]);
  db.seed("subscriptions", []);
  db.seed("discount_codes", [{
    id: CODE_ID, code: "PCHU01", description: null, percent_off: 50, plans: ["prep"], terms: ["monthly"], periods: 1,
    starts_at: null, ends_at: null, max_redemptions: null, new_customers_only: false, combine_with_offer: false, active: true,
  }]);
  db.seed("discount_redemptions", []);
  const rules = {
    organizer: "PitchNest", description: "Practice with AI investors.\n\nSecond paragraph.", region: "Online · open to founders everywhere",
    banner_file: null, promo_enabled: true, website_url: "https://www.pitchnest.app", prize_currency: "NGN",
    winners_announced_on: iso(20).slice(0, 10), eligibility: "Founders.", requirements: "", judging_criteria: "60/40.",
    terms: "Terms.", pitch_weight: 60, eligible_session_modes: ["solo", "panel"], min_completed_sessions: 1, required_plan: "prep",
    social_handles: { instagram: { handle: "@pitchnestapp", url: "https://instagram.com/pitchnestapp" } },
    discount_code_id: CODE_ID, confirmations: {}, results_published_at: null, created_at: iso(-5), updated_at: iso(-1),
  };
  db.seed("challenges", [
    { ...rules, id: CHALLENGE_ID, slug: "pitchnest-challenge", title: "PitchNest Challenge", tagline: "Practice. Pitch. Showcase. Win!",
      prizes: [{ place: 1, amount: 100000 }, { place: 2, amount: 60000 }], starts_at: iso(-3), submission_deadline: iso(10), status: "open" },
    { ...rules, id: DRAFT_ID, slug: "secret-draft", title: "Secret Draft Challenge", tagline: "Not announced yet at all.",
      prizes: [{ place: 1, amount: 5000 }], starts_at: iso(1), submission_deadline: iso(30), status: "draft" },
  ]);
  db.seed("challenge_participants", []);
  db.seed("businesses", [
    { id: BIZ_A, slug: "acme", name: "Acme", status: "published" },
    { id: BIZ_A_DRAFT, slug: "acme-labs", name: "Acme Labs", status: "draft" },
    { id: BIZ_A_EXAMPLE, slug: "fleetwise", name: "FleetWise", status: "published" },
    { id: BIZ_B, slug: "bayo-co", name: "Bayo Co", status: "published" },
    { id: BIZ_C, slug: "chi-foods", name: "Chi Foods", status: "published" },
  ]);
  db.seed("business_publications", [
    { business_id: BIZ_A, status: "active", public_snapshot: snapshot("acme", "Acme") },
    { business_id: BIZ_A_EXAMPLE, status: "active", public_snapshot: snapshot("fleetwise", "FleetWise", { isExample: true }) },
    { business_id: BIZ_B, status: "active", public_snapshot: snapshot("bayo-co", "Bayo Co", { problem: "" }) },
    { business_id: BIZ_C, status: "active", public_snapshot: snapshot("chi-foods", "Chi Foods") },
  ]);
  db.seed("business_members", [
    { business_id: BIZ_A, user_id: FOUNDER_A.id, role: "owner", status: "active" },
    { business_id: BIZ_A_DRAFT, user_id: FOUNDER_A.id, role: "owner", status: "active" },
    { business_id: BIZ_A_EXAMPLE, user_id: FOUNDER_A.id, role: "owner", status: "active" },
    { business_id: BIZ_B, user_id: FOUNDER_B.id, role: "owner", status: "active" },
    { business_id: BIZ_A, user_id: FOUNDER_B.id, role: "viewer", status: "active" },
    { business_id: BIZ_C, user_id: FOUNDER_C.id, role: "owner", status: "active" },
  ]);
  db.seed("sessions", [
    { id: 9001, ...complete([70, 72, 68, 70]), user_id: FOUNDER_A.id },
    { id: 9002, ...complete([95, 95, 95, 95], "coach"), user_id: FOUNDER_A.id },
    { id: 9003, ...complete([99, 99, 99, 99], "panel", -10), user_id: FOUNDER_A.id },
    { id: 9004, user_id: FOUNDER_A.id, mode: "panel", created_at: iso(-0.5), evaluation_report: { evaluationStatus: "insufficient_data", scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 } } },
    { id: 9005, ...complete([88, 86, 84, 86]), user_id: FOUNDER_C.id },
  ]);
  db.seed("notifications", []);
  db.seed("admin_audit_log", []);
  ({ base, close } = await startApp(db));
});

after(async () => {
  globalThis.fetch = realFetch;
  await close();
});

const notes = (userId: number, type: string) => db.rows("notifications").filter((n) => n.user_id === userId && n.type === type);
const entryOf = (userId: number) => db.rows("challenge_participants").find((p) => p.user_id === userId && p.challenge_id === CHALLENGE_ID);

test("public: a draft is a 404; a listed challenge shows its rules and nothing private", async () => {
  assert.equal((await call(base, "GET", "/api/public/challenges/secret-draft")).status, 404);
  const r = await call(base, "GET", "/api/public/challenges/pitchnest-challenge");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.phase, "open");
  assert.equal(r.json.data.prizePool, 160000);
  assert.deepEqual(r.json.data.discount, { code: "PCHU01", percentOff: 50, plans: ["prep"], terms: ["monthly"], periods: 1, endsAt: null, active: true });
  assert.equal(r.json.data.requiredPlan, "prep");
  for (const key of ["confirmations", "created_by", "discount_code_id", "status", "promo_enabled"]) {
    assert.equal(key in r.json.data, false, `${key} is private`);
  }
  assert.equal(r.json.data.results, null, "no results before they are published");
});

test("link previews: a shared challenge shows its title, tagline and poster; a draft shows nothing", async () => {
  const r = await fetch(`${base}/api/public/challenges/pitchnest-challenge/share-html`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /^text\/html/);
  const html = await r.text();
  assert.match(html, /<meta property="og:title" content="PitchNest Challenge" \/>/);
  assert.match(html, /<meta property="og:description" content="Practice\. Pitch\. Showcase\. Win! Practice with AI investors\. Second paragraph\." \/>/);
  assert.match(html, /<meta property="og:image" content="https?:\/\/[^"]+\/pitchnest-challenge-share\.jpg" \/>/, "before an upload, the card that ships with the website");
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(html, /<link rel="canonical" href="https?:\/\/[^"]+\/opportunities\/challenges\/pitchnest-challenge" \/>/);
  assert.match(html, /<meta name="robots" content="index, follow" \/>/);

  const draft = await fetch(`${base}/api/public/challenges/secret-draft/share-html`);
  assert.equal(draft.status, 404);
  const draftHtml = await draft.text();
  assert.match(draftHtml, /<meta name="robots" content="noindex, follow" \/>/);
  assert.doesNotMatch(draftHtml, /Secret Draft|Not announced/, "a draft's title and tagline never leak");
  const odd = await fetch(`${base}/api/public/challenges/${encodeURIComponent("<script>")}/share-html`);
  assert.equal(odd.status, 404);
  assert.doesNotMatch(await odd.text(), /<script>/, "nothing from the address is echoed unescaped");
});

test("hub: the hosted challenge comes first; external listings are unchanged", async () => {
  const r = await call(base, "GET", "/api/public/opportunities");
  assert.equal(r.status, 200);
  assert.equal(r.json.data[0].source, "pitchnest");
  assert.equal(r.json.data[0].kind, "competition");
  assert.equal(r.json.data[0].challenge.slug, "pitchnest-challenge");
  assert.match(r.json.data[0].sourceUrl, /\/opportunities\/challenges\/pitchnest-challenge$/);
  assert.equal(r.json.data.some((item: any) => item.title === "Secret Draft Challenge"), false, "drafts never list");
  const external = r.json.data.find((item: any) => item.id === "e1");
  assert.equal(external.source, "external");
  assert.equal(external.sourceUrl, "https://example.org/apply", "external links still go to the organizer");
  const grants = await call(base, "GET", "/api/public/opportunities?kind=grant");
  assert.equal(grants.json.data.some((item: any) => item.source === "pitchnest"), false, "a hosted challenge is a pitch competition");
  const competitions = await call(base, "GET", "/api/public/opportunities?kind=competition");
  assert.equal(competitions.json.data[0].source, "pitchnest");
});

test("pop-up: the open challenge, until staff switch it off", async () => {
  const r = await call(base, "GET", "/api/public/challenges/promo");
  assert.equal(r.json.data.slug, "pitchnest-challenge");
  assert.equal(r.json.data.phase, "open");
  db.rows("challenges")[0].promo_enabled = false;
  assert.equal((await call(base, "GET", "/api/public/challenges/promo")).json.data, null);
  db.rows("challenges")[0].promo_enabled = true;
});

test("joining needs a sign-in, makes one entry, and only on an open challenge", async () => {
  assert.equal((await call(base, "POST", `${SLUG}/join`)).status, 401);
  assert.equal((await call(base, "POST", "/api/challenges/secret-draft/join", { token: tokenA })).status, 404);
  const first = await call(base, "POST", `${SLUG}/join`, { token: tokenA });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.data.joined, true);
  const again = await call(base, "POST", `${SLUG}/join`, { token: tokenA });
  assert.equal(again.status, 200, "joining twice returns the same entry");
  assert.equal(db.rows("challenge_participants").filter((p) => p.user_id === FOUNDER_A.id).length, 1, "never a second entry");
  assert.equal(notes(FOUNDER_A.id, "challenge_joined").length, 1, "told once");
});

test("the score comes only from the founder's own sessions", async () => {
  const forged = await call(base, "PATCH", `${SLUG}/entry`, { token: tokenA, body: { bestScore: 100, best_score: 100, completedSessions: 9 } });
  assert.equal(forged.status, 400, "a score in the body is never accepted");
  const r = await call(base, "GET", `${SLUG}/entry`, { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.bestScore, 70, "coach, out-of-window and incomplete sessions don't count");
  assert.equal(r.json.data.completedSessions, 1);
  assert.equal(r.json.data.checklist.find((c: any) => c.key === "subscription").status, "not_started", "no paid plan yet");
  db.rows("sessions").push({ id: 9010, ...complete([82, 80, 79, 83], "solo"), user_id: FOUNDER_A.id });
  const improved = await call(base, "GET", `${SLUG}/entry`, { token: tokenA });
  assert.equal(improved.json.data.bestScore, 81, "a better session raises the best score");
  assert.equal(improved.json.data.bestSessionId, 9010);
});

test("only an owned, published, real and complete business can be entered", async () => {
  const patch = (businessId: string, token = tokenA) => call(base, "PATCH", `${SLUG}/entry`, { token, body: { businessId } });
  assert.equal((await patch(BIZ_B)).status, 404, "someone else's business");
  assert.equal((await patch(BIZ_A_DRAFT)).status, 422, "not published");
  assert.equal((await patch(BIZ_A_EXAMPLE)).status, 422, "an example business");
  const ok = await patch(BIZ_A);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.businessId, BIZ_A);
  assert.equal(ok.json.data.checklist.find((c: any) => c.key === "business").status, "completed");
  // A viewer of the same business can't use it, and it can't be entered twice.
  await call(base, "POST", `${SLUG}/join`, { token: tokenB });
  assert.equal((await patch(BIZ_A, tokenB)).status, 404, "a viewer doesn't own the business");
});

test("the social link must be a real post on the chosen platform", async () => {
  const patch = (body: Row) => call(base, "PATCH", `${SLUG}/entry`, { token: tokenA, body });
  assert.equal((await patch({ socialPlatform: "instagram", socialPostUrl: "https://x.com/a/status/1855012345678901234" })).status, 422);
  assert.equal((await patch({ socialPlatform: "instagram", socialPostUrl: "https://www.instagram.com/pitchnestapp/" })).status, 422);
  assert.equal((await patch({ socialPlatform: "myspace", socialPostUrl: "https://myspace.com/p/1" })).status, 400);
  const ok = await patch({ socialPlatform: "instagram", socialPostUrl: "https://www.instagram.com/p/C1a2B3c4D5e/", profileLinkConfirmed: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.social.url, "https://www.instagram.com/p/C1a2B3c4D5e/");
});

test("submission is refused until the server has verified every requirement", async () => {
  let r = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenA, body: { acceptRules: true } });
  assert.equal(r.status, 422);
  assert.ok(r.json.missing.some((m: string) => m.includes("Founder")), JSON.stringify(r.json));

  // A paid, settled Founder plan (Pro also qualifies as a higher plan).
  Object.assign(db.rows("users").find((u) => u.id === FOUNDER_A.id)!, { plan: "prep", plan_expires_at: iso(30) });
  db.rows("payments").push({ id: 3, user_id: FOUNDER_A.id, tx_ref: "pn-401-1", status: "successful", amount: 9.99, currency: "USD", plan: "prep", term: "monthly", created_at: iso(-0.01) });
  r = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenA, body: {} });
  assert.equal(r.status, 422, "the rules must be accepted");
  r = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenA, body: { acceptRules: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.status, "submitted");
  assert.equal(r.json.data.checklist.find((c: any) => c.key === "submitted").status, "completed");
  assert.equal(entryOf(FOUNDER_A.id)?.subscription_tx_ref, "pn-401-1", "the payment behind the plan is recorded");
  assert.equal(notes(FOUNDER_A.id, "challenge_submitted").length, 1);
  assert.equal(notes(FOUNDER_A.id, "challenge_eligible").length, 1, "told once when every automatic check passed");
});

test("a pending payment is never a subscription", async () => {
  const r = await call(base, "GET", `${SLUG}/entry`, { token: tokenB });
  assert.equal(r.json.data.checklist.find((c: any) => c.key === "subscription").status, "pending_verification");
  const submit = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenB, body: { acceptRules: true } });
  assert.equal(submit.status, 422);
  assert.ok(submit.json.missing.some((m: string) => m.includes("being confirmed")));
});

test("staff routes are invisible to founders", async () => {
  for (const [method, path] of [
    ["GET", "/api/staff/challenges"],
    ["GET", `/api/staff/challenges/${CHALLENGE_ID}/participants`],
    ["POST", `/api/staff/challenges/${CHALLENGE_ID}/status`],
    ["PUT", `/api/staff/challenges/${CHALLENGE_ID}/winners`],
    ["GET", "/api/staff/discounts"],
  ] as const) {
    assert.equal((await call(base, method, path, { token: tokenA, ...(method === "GET" ? {} : { body: {} }) })).status, 404, `${method} ${path}`);
  }
  assert.equal((await call(base, "GET", "/api/staff/challenges")).status, 401);
  const r = await call(base, "GET", "/api/staff/challenges", { token: tokenStaff });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 2);
});

test("a challenge goes public only once every part of the rules is confirmed", async () => {
  const status = (s: string) => call(base, "POST", `/api/staff/challenges/${DRAFT_ID}/status`, { token: tokenStaff, body: { status: s } });
  let r = await status("open");
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.pending, ["prizes", "dates", "discount", "social", "judging", "terms"]);
  for (const item of ["prizes", "dates", "discount", "social", "judging", "terms"]) {
    const confirmed = await call(base, "POST", `/api/staff/challenges/${DRAFT_ID}/confirm`, { token: tokenStaff, body: { item } });
    assert.equal(confirmed.status, 200);
  }
  // Editing a confirmed part makes that sign-off stale again.
  const edit = await call(base, "PATCH", `/api/staff/challenges/${DRAFT_ID}`, { token: tokenStaff, body: { prizes: [7000] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(edit.json.data.confirmations.find((c: any) => c.item === "prizes").stale, true);
  r = await status("published");
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.pending, ["prizes"]);
  await call(base, "POST", `/api/staff/challenges/${DRAFT_ID}/confirm`, { token: tokenStaff, body: { item: "prizes" } });
  r = await status("published");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.phase, "upcoming");
  const audit = db.rows("admin_audit_log").filter((a) => a.challenge_id === DRAFT_ID).map((a) => a.action);
  assert.ok(audit.includes("challenge.confirmed") && audit.includes("challenge.updated") && audit.includes("challenge.status"), audit.join());
  assert.equal(db.rows("admin_audit_log").find((a) => a.action === "challenge.status")?.actor_id, STAFF.id);
  // Founders have joined the open challenge, so it can't go back to draft.
  const back = await call(base, "POST", `/api/staff/challenges/${CHALLENGE_ID}/status`, { token: tokenStaff, body: { status: "draft" } });
  assert.equal(back.status, 409);
});

test("staff see every entry with its verified facts", async () => {
  await call(base, "POST", `${SLUG}/join`, { token: tokenC });
  const r = await call(base, "GET", `/api/staff/challenges/${CHALLENGE_ID}/participants`, { token: tokenStaff });
  assert.equal(r.status, 200);
  const ada = r.json.data.find((p: any) => p.userId === FOUNDER_A.id);
  assert.deepEqual(
    { name: ada.name, email: ada.email, subscription: ada.subscription, best: ada.bestScore, eligible: ada.eligible, business: ada.business.name },
    { name: "Ada Founder", email: "ada@x.test", subscription: "verified", best: 81, eligible: true, business: "Acme" },
  );
  const bayo = r.json.data.find((p: any) => p.userId === FOUNDER_B.id);
  assert.equal(bayo.subscription, "pending");
  assert.equal(bayo.eligible, false);
  assert.ok(bayo.missing.includes("subscription") && bayo.missing.includes("business"));
});

test("review: reasons are required, founders are told, and every decision is audited", async () => {
  const ada = entryOf(FOUNDER_A.id)!;
  const review = (id: string, body: Row) => call(base, "POST", `/api/staff/challenges/${CHALLENGE_ID}/participants/${id}/review`, { token: tokenStaff, body });
  assert.equal((await review(ada.id, { action: "request_correction" })).status, 400, "a correction needs a reason");
  let r = await review(ada.id, { action: "request_correction", note: "Tag @pitchnestapp in the caption." });
  assert.equal(r.status, 200);
  assert.equal(notes(FOUNDER_A.id, "challenge_correction").length, 1);
  const mine = await call(base, "GET", `${SLUG}/entry`, { token: tokenA });
  assert.equal(mine.json.data.reviewNote, "Tag @pitchnestapp in the caption.");
  assert.equal(mine.json.data.editable, true);
  // The founder fixes the post and resubmits.
  await call(base, "PATCH", `${SLUG}/entry`, { token: tokenA, body: { socialPostUrl: "https://www.instagram.com/p/C9fixed123/" } });
  const resubmit = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenA, body: { acceptRules: true } });
  assert.equal(resubmit.status, 200, JSON.stringify(resubmit.json));
  r = await review(ada.id, { action: "approve", socialChecks: { postPublic: true, scoreScreenshot: true, profileLink: true, tagged: true, collaboration: false, follows: true } });
  assert.equal(r.status, 200);
  assert.equal(entryOf(FOUNDER_A.id)?.status, "approved");
  assert.equal(notes(FOUNDER_A.id, "challenge_approved").length, 1);
  const again = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenA, body: { acceptRules: true } });
  assert.equal(again.status, 200);
  assert.equal(entryOf(FOUNDER_A.id)?.status, "approved", "submitting again never demotes an approved entry");
  const bayo = entryOf(FOUNDER_B.id)!;
  assert.equal((await review(bayo.id, { action: "approve" })).status, 409, "an entry that was never submitted can't be approved");
  assert.equal((await review(bayo.id, { action: "disqualify" })).status, 400, "a disqualification needs a documented reason");
  const actions = db.rows("admin_audit_log").filter((a) => a.subject_id === ada.id).map((a) => a.action);
  assert.deepEqual(actions, ["participant.request_correction", "participant.approve"]);
});

test("judging combines the verified pitch score and the profile rubric", async () => {
  const ada = entryOf(FOUNDER_A.id)!;
  const judge = (body: Row) => call(base, "POST", `/api/staff/challenges/${CHALLENGE_ID}/participants/${ada.id}/judging`, { token: tokenStaff, body });
  assert.equal((await judge({ profileScores: { completeness: 11 } })).status, 400);
  const r = await judge({ profileScores: { completeness: 8, problem: 7, solution: 9, market: 6, model: 7, traction: 5 }, shortlisted: true, judgeNotes: "Strong problem." });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.profileScore, 70);
  assert.equal(r.json.data.finalScore, 76.6, "60% of 81 plus 40% of 70");
  const invalid = await judge({ pitchScoreValid: false });
  assert.equal(invalid.json.data.finalScore, 28, "an invalidated pitch score counts as zero");
  await judge({ pitchScoreValid: true });
});

test("winners: approved entries only, one place each; results publish once every place is filled", async () => {
  const ada = entryOf(FOUNDER_A.id)!;
  const chi = entryOf(FOUNDER_C.id)!;
  const bayo = entryOf(FOUNDER_B.id)!;
  const winners = (placements: Row[]) => call(base, "PUT", `/api/staff/challenges/${CHALLENGE_ID}/winners`, { token: tokenStaff, body: { placements } });
  assert.equal((await winners([{ participantId: bayo.id, place: 1 }])).status, 409, "not approved");
  assert.equal((await winners([{ participantId: ada.id, place: 1 }, { participantId: ada.id, place: 2 }])).status, 409, "two prizes for one founder");
  let r = await winners([{ participantId: ada.id, place: 1 }]);
  assert.equal(r.status, 200);
  const publish = () => call(base, "POST", `/api/staff/challenges/${CHALLENGE_ID}/results/publish`, { token: tokenStaff });
  r = await publish();
  assert.equal(r.status, 409, "every prize place needs a winner");
  assert.match(r.json.error, /missing: 2/);

  // Chi submits a complete entry and is approved for second place.
  await call(base, "PATCH", `${SLUG}/entry`, { token: tokenC, body: { businessId: BIZ_C, socialPlatform: "x", socialPostUrl: "https://x.com/chi/status/1855012345678901234", profileLinkConfirmed: true, publicNameConsent: true } });
  const submitted = await call(base, "POST", `${SLUG}/entry/submit`, { token: tokenC, body: { acceptRules: true } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  await call(base, "POST", `/api/staff/challenges/${CHALLENGE_ID}/participants/${chi.id}/review`, { token: tokenStaff, body: { action: "approve" } });
  r = await winners([{ participantId: ada.id, place: 1 }, { participantId: chi.id, place: 2 }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.winnersPreview.map((w: any) => [w.place, w.businessName, w.founderName]), [[1, "Acme", null], [2, "Chi Foods", "Chi Founder"]]);

  r = await publish();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(notes(FOUNDER_B.id, "challenge_results").length, 1, "every participant hears the results");
  const page = await call(base, "GET", "/api/public/challenges/pitchnest-challenge");
  assert.deepEqual(page.json.data.results, [
    { place: 1, prize: 100000, businessName: "Acme", businessSlug: "acme", founderName: null },
    { place: 2, prize: 60000, businessName: "Chi Foods", businessSlug: "chi-foods", founderName: "Chi Founder" },
  ], "names appear only with consent; no emails or ids");
  assert.equal((await winners([{ participantId: chi.id, place: 1 }])).status, 409, "locked once published");
  const lockedEdit = await call(base, "PATCH", `${SLUG}/entry`, { token: tokenA, body: { socialPostUrl: "https://www.instagram.com/p/C9other123/" } });
  assert.equal(lockedEdit.status, 409, "a winning entry can't be changed");
});

test("images: the poster is public, the founder's screenshot is private", async () => {
  const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#1d4ed8" } }).png().toBuffer();
  const form = () => {
    const f = new FormData();
    f.append("image", new Blob([png], { type: "image/png" }), "poster.png");
    return f;
  };
  db.storageCalls.length = 0;
  const poster = await call(base, "PUT", `/api/staff/challenges/${CHALLENGE_ID}/image`, { token: tokenStaff, form: form() });
  assert.equal(poster.status, 200, JSON.stringify(poster.json));
  const upload = db.storageCalls.find((c) => c.op === "upload" && c.paths[0].endsWith(".webp"))!;
  assert.match(upload.paths[0], new RegExp(`^challenge-media/${CHALLENGE_ID}/banner-[a-f0-9]{32}\\.webp$`));
  assert.ok(poster.json.data.imageUrl);
  // Its link-preview card: a wide JPEG beside it, which previews then use.
  const card = db.storageCalls.find((c) => c.op === "upload" && c.paths[0].endsWith("-share.jpg"))!;
  assert.equal(card.paths[0], upload.paths[0].replace(/\.webp$/, "-share.jpg"));
  assert.equal(card.bucket, config.publicMediaBucket);
  assert.equal(card.contentType, "image/jpeg");
  const cardMeta = await sharp(card.body as Buffer).metadata();
  assert.deepEqual([cardMeta.format, cardMeta.width, cardMeta.height], ["jpeg", 1200, 630]);
  const preview = await (await fetch(`${base}/api/public/challenges/pitchnest-challenge/share-html`)).text();
  assert.ok(preview.includes(`<meta property="og:image" content="https://public.test/${config.publicMediaBucket}/${card.paths[0]}" />`), preview);
  const hub = await call(base, "GET", "/api/public/opportunities");
  assert.equal(hub.json.data[0].challenge.imageUrl, poster.json.data.imageUrl, "the hub card shows the poster");
  assert.equal((await call(base, "GET", "/api/public/challenges/promo")).json.data.imageUrl, poster.json.data.imageUrl, "so does the pop-up");

  db.storageCalls.length = 0;
  const evidence = await call(base, "PUT", `${SLUG}/entry/evidence`, { token: tokenB, form: form() });
  assert.equal(evidence.status, 200, JSON.stringify(evidence.json));
  const evidenceUpload = db.storageCalls.find((c) => c.op === "upload")!;
  assert.equal(upload.bucket, config.publicMediaBucket, "the poster goes to the public bucket");
  assert.equal(evidenceUpload.bucket, config.storageBucket, "the screenshot goes to the private bucket");
  assert.notEqual(config.storageBucket, config.publicMediaBucket);
  assert.match(evidenceUpload.paths[0], /^challenge-evidence\/[0-9a-f-]{36}\/evidence-[a-f0-9]{32}\.webp$/);
  const detail = await call(base, "GET", `/api/staff/challenges/${CHALLENGE_ID}/participants/${entryOf(FOUNDER_B.id)!.id}`, { token: tokenStaff });
  assert.equal(detail.status, 200);
  assert.match(detail.json.data.evidenceUrl, /^https:\/\/signed\.test\//, "reviewers get a short-lived signed link");

  // A new poster replaces the old one and its card; removing it removes both.
  const yellow = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#facc15" } }).png().toBuffer();
  const replaceForm = new FormData();
  replaceForm.append("image", new Blob([yellow], { type: "image/png" }), "poster-2.png");
  db.storageCalls.length = 0;
  const replaced = await call(base, "PUT", `/api/staff/challenges/${CHALLENGE_ID}/image`, { token: tokenStaff, form: replaceForm });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
  assert.deepEqual(db.storageCalls.find((c) => c.op === "remove")?.paths, [upload.paths[0], card.paths[0]]);
  const current = db.storageCalls.filter((c) => c.op === "upload").map((c) => c.paths[0]);
  db.storageCalls.length = 0;
  assert.equal((await call(base, "DELETE", `/api/staff/challenges/${CHALLENGE_ID}/image`, { token: tokenStaff })).status, 200);
  assert.deepEqual(db.storageCalls.find((c) => c.op === "remove")?.paths, current);
  const bundled = await (await fetch(`${base}/api/public/challenges/pitchnest-challenge/share-html`)).text();
  assert.match(bundled, /\/pitchnest-challenge-share\.jpg" \/>/, "without an upload, previews fall back to the bundled card");
});

test("discount: the preview and the checkout charge the same discounted, one-time price", async () => {
  const token = signUserToken({ id: 410, email: "dee@x.test" });
  db.rows("users").push({ id: 410, email: "dee@x.test", name: "Dee", isEmailVerified: true, plan: "free", plan_expires_at: null });
  const preview = await call(base, "GET", "/api/billing/discount?code=pchu01&plan=prep&term=monthly&currency=USD", { token });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(
    { list: preview.json.data.listAmount, amount: preview.json.data.amount, mode: preview.json.data.billingMode, id: "codeId" in preview.json.data },
    { list: 9.99, amount: 5, mode: "manual", id: false },
  );
  assert.equal((await call(base, "GET", "/api/billing/discount?code=pchu01&plan=prep&term=annual", { token })).json.reason, "not_applicable");
  assert.equal((await call(base, "GET", "/api/billing/discount?code=NOPE99", { token })).json.reason, "unknown");

  const autoRenew = await call(base, "POST", "/api/billing/checkout", { token, body: { plan: "prep", term: "monthly", discountCode: "PCHU01", billingMode: "auto_renew" } });
  assert.equal(autoRenew.status, 409);
  assert.equal(autoRenew.json.reason, "manual_only", "a code never discounts an automatic renewal");

  flutterwave.length = 0;
  const checkout = await call(base, "POST", "/api/billing/checkout", { token, body: { plan: "prep", term: "monthly", discountCode: "PCHU01" } });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.json));
  const payment = db.rows("payments").find((p) => p.user_id === 410)!;
  assert.deepEqual(
    { amount: payment.amount, mode: payment.billing_mode, plan: payment.plan, term: payment.term, providerPlan: payment.provider_plan_id },
    { amount: 5, mode: "manual", plan: "prep", term: "monthly", providerPlan: null },
    "the payment row records the discounted, one-time charge",
  );
  const init = flutterwave.find((c) => c.path === "/v3/payments")!;
  assert.equal(init.body.amount, 5);
  assert.equal("payment_plan" in init.body, false, "no Flutterwave payment plan, so it can never renew at half price");
  assert.equal(db.rows("discount_redemptions").find((r) => r.tx_ref === payment.tx_ref)?.status, "pending");
  assert.equal(flutterwave.some((c) => c.path === "/v3/payment-plans"), false);

  // Once redeemed, the same founder can't use a first-month code again.
  db.rows("discount_redemptions").find((r) => r.tx_ref === payment.tx_ref)!.status = "redeemed";
  const reuse = await call(base, "GET", "/api/billing/discount?code=PCHU01&plan=prep&term=monthly", { token });
  assert.equal(reuse.json.reason, "already_used");
  db.rows("discount_codes")[0].active = false;
  const inactive = await call(base, "POST", "/api/billing/checkout", { token: tokenB, body: { discountCode: "PCHU01" } });
  assert.equal(inactive.json.reason, "inactive");
  const plain = await call(base, "POST", "/api/billing/checkout", { token: tokenB, body: { plan: "pro", term: "monthly" } });
  assert.equal(plain.status, 200, "checkout without a code works exactly as before");
  assert.equal(db.rows("payments").filter((p) => p.user_id === FOUNDER_B.id).at(-1)?.amount, 15);
});
