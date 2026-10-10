import "../helpers/testEnv.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { TEST_JWT_SECRET } from "../helpers/testEnv.ts";
import {
  signOrgToken,
  signUserToken,
  verifyOrgToken,
  verifyUserToken,
  TokenError,
} from "../../services/tokenService.ts";
import {
  __resetGrantsForTests,
  attachConnection,
  issueGrant,
  markGrantEnded,
  remainingSeconds,
  resolveResume,
  RESUME_GRACE_MS,
} from "../../services/liveSessionGrants.ts";
import { signLocalFileUrl } from "../../services/storageService.ts";
import { isClientRecordingValueAcceptable } from "../../utils/recordingAuth.ts";

const reason = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (e) {
    return e instanceof TokenError ? e.reason : "other";
  }
};

// ── Token principals ───────────────────────────────────────────────────────

test("founder token is accepted as a user and refused as an org", () => {
  const t = signUserToken({ id: 7, email: "f@x.test" });
  assert.equal(verifyUserToken(t).id, 7);
  assert.equal(reason(() => verifyOrgToken(t)), "wrong_principal");
});

test("org token is accepted as an org and refused as a user", () => {
  const t = signOrgToken({ id: 7, orgCode: 4321, email: "org@x.test" });
  assert.equal(verifyOrgToken(t).orgCode, 4321);
  assert.equal(reason(() => verifyUserToken(t)), "wrong_principal");
});

test("legacy untyped token is a (compatible) user token but never an org token", () => {
  const legacy = jwt.sign({ id: 7, email: "f@x.test", rememberMe: false }, TEST_JWT_SECRET!);
  assert.equal(verifyUserToken(legacy).id, 7);
  assert.equal(reason(() => verifyOrgToken(legacy)), "wrong_principal");
});

test("forged signature, alg=none and expired tokens are rejected", () => {
  const forged = jwt.sign({ typ: "user", id: 7, email: "f@x.test" }, "attacker-secret");
  assert.equal(reason(() => verifyUserToken(forged)), "invalid");

  const forgedOrg = jwt.sign({ typ: "org", orgId: 1, orgCode: 1, email: "o@x.test" }, "attacker-secret");
  assert.equal(reason(() => verifyOrgToken(forgedOrg)), "invalid");

  const none = jwt.sign({ typ: "user", id: 7, email: "f@x.test" }, "", { algorithm: "none" });
  assert.equal(reason(() => verifyUserToken(none)), "invalid");

  const expired = jwt.sign({ typ: "user", id: 7, email: "f@x.test" }, TEST_JWT_SECRET!, { expiresIn: -10 });
  assert.equal(reason(() => verifyUserToken(expired)), "invalid");
});

test("other signed artefacts (file tokens, resume grants) are not bearer tokens", () => {
  const fileUrl = signLocalFileUrl("x.pdf", 7);
  const fileToken = new URL(fileUrl, "http://h").searchParams.get("token");
  assert.equal(reason(() => verifyUserToken(fileToken)), "invalid");

  __resetGrantsForTests();
  const { resumeToken } = issueGrant({ userId: 7, attempt: null, grantedMinutes: 10 });
  assert.notEqual(reason(() => verifyUserToken(resumeToken)), "accepted");
  assert.notEqual(reason(() => verifyOrgToken(resumeToken)), "accepted");
});

// ── Resume grants ──────────────────────────────────────────────────────────

test("resume without any prior admission is refused", () => {
  __resetGrantsForTests();
  const r = resolveResume({ userId: 7 });
  assert.equal(r.ok, false);
});

test("legitimate reconnect: registry fallback and signed token both resume the same admission", () => {
  __resetGrantsForTests();
  const { grant, resumeToken } = issueGrant({
    userId: 7,
    attempt: { pitchRootId: 55, attemptNumber: 3 },
    grantedMinutes: 10,
  });
  const viaRegistry = resolveResume({ userId: 7 });
  assert.ok(viaRegistry.ok && viaRegistry.grant.sid === grant.sid);
  const viaToken = resolveResume({ userId: 7, resumeToken });
  assert.ok(viaToken.ok && viaToken.grant.sid === grant.sid);
  assert.deepEqual(viaToken.ok && viaToken.grant.attempt, { pitchRootId: 55, attemptNumber: 3 });
});

test("a signed token survives a process restart (registry empty)", () => {
  __resetGrantsForTests();
  const { grant, resumeToken } = issueGrant({ userId: 7, attempt: null, grantedMinutes: 10 });
  __resetGrantsForTests();
  const r = resolveResume({ userId: 7, resumeToken });
  assert.ok(r.ok && r.grant.sid === grant.sid && r.source === "token");
});

test("another user's resume token, or a tampered one, is refused", () => {
  __resetGrantsForTests();
  const { resumeToken } = issueGrant({ userId: 7, attempt: null, grantedMinutes: 10 });
  assert.equal(resolveResume({ userId: 8, resumeToken }).ok, false);
  const tampered = resumeToken.slice(0, -2) + (resumeToken.endsWith("A") ? "BB" : "AA");
  assert.equal(resolveResume({ userId: 7, resumeToken: tampered }).ok, false);
  const forged = jwt.sign({ typ: "resume", sid: "x", uid: 7, att: null, min: 40, dl: Date.now() + 1e9 }, "attacker");
  assert.equal(resolveResume({ userId: 7, resumeToken: forged }).ok, false);
});

test("an ended session can never be resumed (no second report from one admission)", () => {
  __resetGrantsForTests();
  const { grant, resumeToken } = issueGrant({ userId: 7, attempt: null, grantedMinutes: 10 });
  markGrantEnded(grant.sid);
  assert.equal(resolveResume({ userId: 7 }).ok, false);
  assert.equal(resolveResume({ userId: 7, resumeToken }).ok, false);
});

test("resume is refused after the admission's deadline + grace, and never extends time", () => {
  __resetGrantsForTests();
  const t0 = Date.now();
  const { grant } = issueGrant({ userId: 7, attempt: null, grantedMinutes: 10, now: t0 });
  assert.equal(remainingSeconds(grant, t0 + 4 * 60 * 1000), 6 * 60);
  const late = t0 + 10 * 60 * 1000 + RESUME_GRACE_MS + 1;
  assert.equal(resolveResume({ userId: 7, now: late }).ok, false);
});

test("only one live connection holds a grant; a newer resume displaces the older socket", () => {
  __resetGrantsForTests();
  const { grant } = issueGrant({ userId: 7, attempt: null, grantedMinutes: 10 });
  const a = {}, b = {};
  assert.equal(attachConnection(grant.sid, a), null);
  assert.equal(attachConnection(grant.sid, b), a);
});

// ── Client-proposed recording values ──────────────────────────────────────

test("set_video_url accepts only the caller's own server-issued recording keys", () => {
  assert.equal(isClientRecordingValueAcceptable("pitches/7/1700000000000_pitch.webm", 7), true);
  assert.equal(isClientRecordingValueAcceptable("/uploads/rec_7_1700000000000_pitch.webm", 7), true);

  for (const bad of [
    "pitches/8/1700000000000_pitch.webm", // another user's prefix
    "/uploads/rec_8_1_pitch.webm",
    "decks/1700000000000_victim.pdf", // another object class
    "pitches/1700000000000_legacy.webm", // legacy shape — never client-proposable
    "pitches/7/../8/x.webm",
    "pitches/7/..",
    "/uploads/../../etc/passwd",
    "https://evil.test/x.webm",
    "avatars/7_1.png",
    "",
    null,
    { path: "pitches/7/x" },
  ]) {
    assert.equal(isClientRecordingValueAcceptable(bad, 7), false, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(isClientRecordingValueAcceptable("pitches/7/1_x.webm", null), false);
});
