import "../helpers/testEnv.ts";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { signUserToken } from "../helpers/tokens.ts";
import fs from "node:fs";
import path from "node:path";
import { signLocalFileUrl, uploadDir } from "../../services/storageService.ts";

const db = new FakeSupabase();
let base = "";
let close: () => Promise<void>;

const ATTACKER = { id: 30, email: "attacker@x.test" };
const VICTIM = { id: 31, email: "victim@x.test" };
const attackerToken = signUserToken(ATTACKER);

const VICTIM_DECK = "decks/1700000000000_victim_deck.pdf";
const VICTIM_LEGACY_REC = "pitches/1700000000001_victim_pitch.webm";

function seed() {
  db.storageCalls = [];
  db.seed("users", [
    { ...ATTACKER, isEmailVerified: true, password: bcrypt.hashSync("attacker-pass", 4) },
    { ...VICTIM, isEmailVerified: true, password: bcrypt.hashSync("victim-pass", 4) },
  ]);
  db.seed("decks", [{ id: 900, user_id: VICTIM.id, file_url: VICTIM_DECK, name: "Victim deck" }]);
  db.seed("sessions", [
    // Victim's own legacy recording (pre-fix key shape, no user segment).
    { id: 800, user_id: VICTIM.id, video_url: VICTIM_LEGACY_REC },
    // Attacker rows poisoned through the old, unvalidated set_video_url.
    { id: 801, user_id: ATTACKER.id, video_url: VICTIM_DECK },
    { id: 802, user_id: ATTACKER.id, video_url: VICTIM_LEGACY_REC },
    { id: 803, user_id: ATTACKER.id, video_url: `pitches/${VICTIM.id}/1700000000002_v.webm` },
    { id: 804, user_id: ATTACKER.id, video_url: "avatars/31_1.png" },
    { id: 805, user_id: ATTACKER.id, video_url: "https://evil.test/x.webm" },
    // Attacker's own legitimate recordings.
    { id: 806, user_id: ATTACKER.id, video_url: `pitches/${ATTACKER.id}/1700000000003_mine.webm` },
    { id: 807, user_id: ATTACKER.id, video_url: "pitches/1700000000004_attacker_legacy.webm" },
  ]);
  db.seed("profiles", []);
}

before(async () => {
  seed();
  ({ base, close } = await startApp(db));
});
beforeEach(() => seed());
after(async () => close());

const signedPaths = () =>
  db.storageCalls.filter((c) => c.op === "createSignedUrl").flatMap((c) => c.paths);

test("H6: a session row pointing at someone else's object never yields a signed URL", async () => {
  for (const id of [801, 802, 803, 804, 805]) {
    const r = await call(base, "GET", `/api/sessions/${id}/recording`, { token: attackerToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { url: "", available: false }, `session ${id} must not expose a URL`);
  }
  assert.deepEqual(signedPaths(), [], "no object may be signed for foreign references");
});

test("H6: the owner still gets signed URLs for their own recordings (new and unshared legacy)", async () => {
  const mine = await call(base, "GET", "/api/sessions/806/recording", { token: attackerToken });
  assert.equal(mine.json.available, true);
  const legacy = await call(base, "GET", "/api/sessions/807/recording", { token: attackerToken });
  assert.equal(legacy.json.available, true);
  assert.deepEqual(signedPaths(), [
    `pitches/${ATTACKER.id}/1700000000003_mine.webm`,
    "pitches/1700000000004_attacker_legacy.webm",
  ]);

  const victimOwn = await call(base, "GET", "/api/sessions/800/recording", {
    token: signUserToken(VICTIM),
  });
  // Victim's legacy key is also referenced by the attacker's poisoned row; it
  // fails closed for the victim too rather than risk the attacker's access.
  // (Documented trade-off; see the remediation report.)
  assert.equal(victimOwn.json.available, false);
});

test("H6: another user's session is still a 404 (unchanged ownership check)", async () => {
  const r = await call(base, "GET", "/api/sessions/800/recording", { token: attackerToken });
  assert.equal(r.status, 404);
});

test("H6: account deletion only removes the deleting user's own recordings", async () => {
  const r = await call(base, "POST", "/api/auth/delete-account", {
    body: { email: ATTACKER.email, password: "attacker-pass" },
  });
  assert.equal(r.status, 200);
  const removed = db.storageCalls.filter((c) => c.op === "remove").flatMap((c) => c.paths);
  assert.ok(!removed.includes(VICTIM_DECK), "victim deck must not be deleted");
  assert.ok(!removed.includes(VICTIM_LEGACY_REC), "victim recording must not be deleted");
  assert.ok(!removed.includes(`pitches/${VICTIM.id}/1700000000002_v.webm`));
  assert.ok(!removed.includes("avatars/31_1.png"));
  assert.ok(removed.includes(`pitches/${ATTACKER.id}/1700000000003_mine.webm`), "own recording is purged");
  assert.ok(removed.includes("pitches/1700000000004_attacker_legacy.webm"), "own legacy recording is purged");
});

test("H6: a local-file token cannot read another user's file via a poisoned session row", async () => {
  // Attacker row claims the victim's local fallback file.
  db.rows("sessions").push({ id: 808, user_id: ATTACKER.id, video_url: "/uploads/1700000000005_victim.pdf" });
  db.rows("decks").push({ id: 901, user_id: VICTIM.id, file_url: "/uploads/1700000000005_victim.pdf" });
  // The file must really exist, or a 404 proves nothing.
  const victimFile = path.join(uploadDir, "1700000000005_victim.pdf");
  fs.writeFileSync(victimFile, "%PDF-1.4 victim secret");
  try {
    const url = signLocalFileUrl("1700000000005_victim.pdf", ATTACKER.id);
    const r = await call(base, "GET", url);
    assert.equal(r.status, 404);
    assert.ok(!String(r.json).includes("victim secret"));
  } finally {
    fs.rmSync(victimFile, { force: true });
  }
});

test("H6: deleting a poisoned session row never deletes the object it points at", async () => {
  for (const id of [802, 803]) {
    const r = await call(base, "DELETE", `/api/sessions/${id}`, { token: attackerToken });
    assert.equal(r.status, 200, `session ${id} → ${r.status}`);
  }
  const removed = db.storageCalls.filter((c) => c.op === "remove").flatMap((c) => c.paths);
  assert.deepEqual(removed, [], "victim objects stay in place");
  assert.ok(!db.rows("sessions").some((s) => s.id === 802 || s.id === 803), "the attacker's rows are gone");

  const own = await call(base, "DELETE", "/api/sessions/806", { token: attackerToken });
  assert.equal(own.status, 200);
  assert.deepEqual(
    db.storageCalls.filter((c) => c.op === "remove").flatMap((c) => c.paths),
    [`pitches/${ATTACKER.id}/1700000000003_mine.webm`],
  );
});

test("H6: a local-file token cannot read another user's rec_ file via a poisoned session row", async () => {
  const victimName = `rec_${VICTIM.id}_1700000000006_v.webm`;
  db.rows("sessions").push({ id: 809, user_id: ATTACKER.id, video_url: `/uploads/${victimName}` });
  const victimFile = path.join(uploadDir, victimName);
  fs.writeFileSync(victimFile, "victim audio");
  try {
    const r = await call(base, "GET", signLocalFileUrl(victimName, ATTACKER.id));
    assert.equal(r.status, 404);
    assert.ok(!String(r.json).includes("victim audio"));
  } finally {
    fs.rmSync(victimFile, { force: true });
  }
});

test("H6: recording uploads are keyed under the uploader's own prefix", async () => {
  const form = new FormData();
  form.append("video", new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm" }), "../../decks/evil.webm");
  const r = await call(base, "POST", "/api/upload-video", { token: attackerToken, form });
  assert.equal(r.status, 200);
  assert.match(r.json.videoUrl, new RegExp(`^pitches/${ATTACKER.id}/\\d+_[A-Za-z0-9._-]+$`));
  const uploaded = db.storageCalls.filter((c) => c.op === "upload").flatMap((c) => c.paths);
  assert.deepEqual(uploaded, [r.json.videoUrl]);
});
