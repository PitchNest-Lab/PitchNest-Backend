import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import {
  ensureFounderHandle,
  loadPublicFounder,
  normalizeHandle,
  slugifyHandle,
} from "../services/founderService.ts";
import { getPublicFounder, setFounderFollowState } from "../controllers/founderController.ts";
import { toNotificationView } from "../controllers/notificationController.ts";
import { sanitizeSettings } from "../controllers/authController.ts";

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const B3 = "33333333-3333-4333-8333-333333333333";

// ── Handles ─────────────────────────────────────────────────────────────────
assert.equal(slugifyHandle("Amaka Obi"), "amaka-obi");
assert.equal(slugifyHandle("Ñandú Café"), "nandu-cafe");
assert.equal(slugifyHandle("Jo"), "founder-jo");
assert.equal(slugifyHandle(""), "founder");
assert.equal(normalizeHandle("Amaka-Obi-1a2b"), "amaka-obi-1a2b");
assert.equal(normalizeHandle("../etc"), null);
assert.equal(normalizeHandle("ab"), null);

// ── In-memory database ──────────────────────────────────────────────────────
type Row = Record<string, any>;
const db: Record<string, Row[]> = {
  founder_handles: [
    { user_id: 1, handle: "amaka-obi-1a2b" },
    { user_id: 2, handle: "private-pat-0000" },
  ],
  business_members: [
    { business_id: B1, user_id: 1, status: "active", public_display_consent: true, public_title: "Co-founder & CEO" },
    { business_id: B2, user_id: 1, status: "active", public_display_consent: false, public_title: "Advisor" },
    { business_id: B3, user_id: 1, status: "active", public_display_consent: true, public_title: "" },
    { business_id: B1, user_id: 2, status: "active", public_display_consent: false, public_title: "" },
  ],
  businesses: [
    { id: B1, slug: "greenloop", status: "published" },
    { id: B2, slug: "market-bridge", status: "published" },
    { id: B3, slug: "stealth-co", status: "draft" },
  ],
  business_publications: [
    { business_id: B1, status: "active", approved_at: "2026-10-10T10:00:00.000Z", public_snapshot: { id: B1, slug: "greenloop", name: "GreenLoop", tagline: "Compost for city farms", businessType: "services" } },
    { business_id: B2, status: "active", approved_at: "2026-10-09T10:00:00.000Z", public_snapshot: { id: B2, slug: "market-bridge", name: "Market Bridge", businessType: "software" } },
  ],
  users: [
    { id: 1, name: "Amaka Obi", avatar_url: "https://storage.example/avatars/1/profile", email: "amaka@example.com" },
    { id: 2, name: "Private Pat", avatar_url: null, email: "pat@example.com" },
    { id: 3, name: "Follower Fola", avatar_url: null, email: "fola@example.com" },
  ],
  founder_follows: [{ founder_id: 1, follower_id: 4 }],
};
const writes: Array<{ table: string; op: string; row?: Row }> = [];

function fakeFrom(table: string) {
  let rows = [...(db[table] ?? [])];
  let countMode = false;
  let deleting = false;
  const query: any = {
    select: (_columns?: string, options?: { count?: string }) => {
      if (options?.count) countMode = true;
      return query;
    },
    eq: (column: string, value: unknown) => { rows = rows.filter((row) => row[column] === value); return query; },
    in: (column: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(row[column])); return query; },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    insert: async (row: Row) => {
      writes.push({ table, op: "insert", row });
      if (table === "founder_handles" && db.founder_handles.some((r) => r.handle === row.handle || r.user_id === row.user_id)) {
        return { error: { code: "23505", message: "duplicate" } };
      }
      db[table].push(row);
      return { error: null };
    },
    upsert: async (row: Row) => {
      writes.push({ table, op: "upsert", row });
      if (!db[table].some((r) => r.founder_id === row.founder_id && r.follower_id === row.follower_id)) db[table].push(row);
      return { error: null };
    },
    delete: () => { deleting = true; return query; },
    then: (resolve: (value: any) => void) => {
      if (deleting) {
        db[table] = db[table].filter((row) => !rows.includes(row));
        writes.push({ table, op: "delete" });
        return resolve({ error: null });
      }
      return resolve(countMode ? { count: rows.length, data: null, error: null } : { data: rows, error: null });
    },
  };
  return query;
}

const mutableSupabase = supabase as any;
const originalFrom = mutableSupabase.from;
mutableSupabase.from = fakeFrom;

function recorder() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    set(field: string, value: string) { this.headers[field] = value; return this; },
    json(body: any) { this.body = body; return this; },
  };
  return res as Response & { statusCode: number; body: any; headers: Record<string, string> };
}

try {
  // ── Visibility ────────────────────────────────────────────────────────────
  const page = await loadPublicFounder("amaka-obi-1a2b");
  assert.ok(page);
  assert.equal(page.founderId, 1);
  assert.deepEqual(Object.keys(page.founder), ["handle", "name", "avatarUrl", "businesses"], "no email, id or bio");
  assert.deepEqual(
    page.founder.businesses.map((b) => [b.slug, b.title]),
    [["greenloop", "Co-founder & CEO"]],
    "only published businesses the founder chose to appear on",
  );
  assert.equal("id" in page.founder.businesses[0], false);
  assert.equal(await loadPublicFounder("private-pat-0000"), null, "a founder who never consented has no page");
  assert.equal(await loadPublicFounder("nobody-here"), null);
  assert.equal(await loadPublicFounder("../../users"), null);

  // ── Public read and viewer state ──────────────────────────────────────────
  const anonymous = recorder();
  await getPublicFounder({ params: { handle: "amaka-obi-1a2b" } } as unknown as Request, anonymous);
  assert.equal(anonymous.statusCode, 200);
  assert.deepEqual(anonymous.body.data.viewer, { authenticated: false, isSelf: false, follows: false, followerCount: null });
  assert.match(anonymous.headers["Cache-Control"], /public/);

  const self = recorder();
  await getPublicFounder({ params: { handle: "amaka-obi-1a2b" }, user: { id: 1 } } as unknown as Request, self);
  assert.equal(self.body.data.viewer.isSelf, true);
  assert.equal(self.body.data.viewer.followerCount, 1, "the founder sees their own follower count");

  const stranger = recorder();
  await getPublicFounder({ params: { handle: "amaka-obi-1a2b" }, user: { id: 3 } } as unknown as Request, stranger);
  assert.equal(stranger.body.data.viewer.followerCount, null, "nobody else sees a person's follower count");
  assert.equal(stranger.body.data.viewer.follows, false);

  const hidden = recorder();
  await getPublicFounder({ params: { handle: "private-pat-0000" } } as unknown as Request, hidden);
  assert.equal(hidden.statusCode, 404);

  // ── Follow and unfollow ───────────────────────────────────────────────────
  writes.length = 0;
  const follow = recorder();
  await setFounderFollowState(true)(
    { params: { handle: "amaka-obi-1a2b" }, user: { id: 3 }, body: { followerId: 99 } } as unknown as Request,
    follow,
  );
  assert.equal(follow.statusCode, 200);
  assert.deepEqual(writes.find((w) => w.op === "upsert")?.row, { founder_id: 1, follower_id: 3 }, "the follower is always the signed-in user");

  const after = recorder();
  await getPublicFounder({ params: { handle: "amaka-obi-1a2b" }, user: { id: 3 } } as unknown as Request, after);
  assert.equal(after.body.data.viewer.follows, true);

  const unfollow = recorder();
  await setFounderFollowState(false)({ params: { handle: "amaka-obi-1a2b" }, user: { id: 3 } } as unknown as Request, unfollow);
  assert.equal(unfollow.body.data.following, false);
  assert.equal(db.founder_follows.some((row) => row.follower_id === 3), false);

  const selfFollow = recorder();
  await setFounderFollowState(true)({ params: { handle: "amaka-obi-1a2b" }, user: { id: 1 } } as unknown as Request, selfFollow);
  assert.equal(selfFollow.statusCode, 403);

  const privateFollow = recorder();
  await setFounderFollowState(true)({ params: { handle: "private-pat-0000" }, user: { id: 3 } } as unknown as Request, privateFollow);
  assert.equal(privateFollow.statusCode, 404, "a private person cannot be followed");

  // ── Handle allocation ─────────────────────────────────────────────────────
  assert.equal(await ensureFounderHandle(1, "Amaka Obi"), "amaka-obi-1a2b", "existing handles are stable");
  const created = await ensureFounderHandle(3, "Follower Fola");
  assert.match(String(created), /^follower-fola-[0-9a-f]{4}$/);
} finally {
  mutableSupabase.from = originalFrom;
}

// ── Notifications ───────────────────────────────────────────────────────────
const update = toNotificationView({
  notification_id: "n1",
  type: "founder_update",
  created_at: "2026-10-15T10:00:00.000Z",
  business_name: "GreenLoop",
  business_slug: "greenloop",
  founder_name: "Amaka Obi",
  excerpt: "We hit 1,000 farms",
});
assert.equal(update?.title, "Amaka Obi posted an update on GreenLoop");
assert.equal(update?.link, "/businesses/greenloop#updates");
const launch = toNotificationView({ notification_id: "n2", type: "founder_business", business_name: "GreenLoop", business_slug: "greenloop", founder_name: "Amaka Obi" });
assert.equal(launch?.title, "Amaka Obi is now on GreenLoop");
assert.equal(toNotificationView({ type: "founder_business", founder_name: "x" }), null, "no business, no notification");

// ── Settings switch ─────────────────────────────────────────────────────────
assert.equal((sanitizeSettings({ notifications: { followedFounders: false } }) as any).notifications.followedFounders, false);
assert.equal("followedFounders" in (sanitizeSettings({ notifications: {} }) as any).notifications, false, "missing means on");

// ── Migration ───────────────────────────────────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0029_founder_pages_and_follows.sql", import.meta.url), "utf8");
assert.match(migration, /notification_enabled\(recipient\.settings, 'followedFounders'\)/);
assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM business_follows/, "business followers are not told twice");
assert.match(migration, /founder_business_announcements[\s\S]*ON CONFLICT DO NOTHING/, "one announcement per founder and business");
assert.match(migration, /founder_shown_on_business\(note\.actor_id, note\.business_id\)/, "withdrawn founders vanish from old notifications");
assert.match(migration, /founder_follows_not_self CHECK \(founder_id <> follower_id\)/);
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0029'/);

console.log("Founder pages, follows and founder notification tests passed.");
process.exit(0);
