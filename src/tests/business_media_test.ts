import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import {
  MediaError,
  isMediaFile,
  processBusinessImage,
  publicMediaUrl,
  reencodeImage,
  sniffImageType,
  toPublicTeam,
} from "../services/businessMediaService.ts";
import { toPublicBusinessSummary } from "../controllers/publicBusinessController.ts";
import { updateMyPublicProfile } from "../controllers/businessController.ts";
import { injectPublicBusinessMetadata } from "../utils/publicBusinessMetadata.ts";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const TRUSTED_AVATAR_URL = `${new URL(config.supabaseUrl).origin}/storage/v1/object/public/${config.avatarBucket}/avatars/1/profile`;

async function photo(width: number, height: number, withGps = false): Promise<Buffer> {
  let image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg();
  if (withGps) {
    image = image.withExif({
      IFD0: { Make: "PhoneMaker", Model: "Phone 1" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 27/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "3/1 23/1 0/1" },
    });
  }
  return image.toBuffer();
}

// ── Byte sniffing ───────────────────────────────────────────────────────────
assert.equal(sniffImageType(await photo(10, 10)), "jpeg");
assert.equal(sniffImageType(await sharp({ create: { width: 4, height: 4, channels: 4, background: "#fff" } }).png().toBuffer()), "png");
assert.equal(sniffImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).webp().toBuffer()), "webp");
assert.equal(sniffImageType(Buffer.from("GIF89a....")), "gif");
assert.equal(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null, "SVG is never accepted");
assert.equal(sniffImageType(Buffer.from("not an image")), null);

// ── Processing strips metadata and normalises size ──────────────────────────
const gpsPhoto = await photo(3000, 1000, true);
assert.ok((await sharp(gpsPhoto).metadata()).exif, "fixture really carries EXIF");

const cover = await processBusinessImage("cover", gpsPhoto);
assert.ok(isMediaFile("cover", cover.file), "cover file name is content-hashed WebP");
const coverMeta = await sharp(cover.buffer).metadata();
assert.equal(coverMeta.format, "webp");
assert.equal(coverMeta.width, 1600);
assert.equal(coverMeta.height, 600);
assert.equal(coverMeta.exif, undefined, "GPS and camera metadata are gone");
assert.equal((await processBusinessImage("cover", gpsPhoto)).file, cover.file, "same image, same name");

const wordmark = await processBusinessImage("logo", await photo(2000, 500));
const logoMeta = await sharp(wordmark.buffer).metadata();
assert.ok(isMediaFile("logo", wordmark.file));
assert.equal(logoMeta.width, 512, "logos keep their shape within 512px");
assert.equal(logoMeta.height, 128);

await assert.rejects(processBusinessImage("logo", await photo(40, 40)), (e: any) => e instanceof MediaError && e.status === 422);
await assert.rejects(processBusinessImage("cover", Buffer.from("plain text")), (e: any) => e instanceof MediaError && e.status === 415);
await assert.rejects(processBusinessImage("logo", Buffer.alloc(3 * 1024 * 1024, 1)), (e: any) => e instanceof MediaError && e.status === 413);
await assert.rejects(
  processBusinessImage("logo", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100)])),
  (e: any) => e instanceof MediaError && e.status === 415,
  "business images do not accept GIF",
);
const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#09f" } }).gif().toBuffer();
const avatar = await reencodeImage(gif, { width: 512, height: 512, fit: "cover", minWidth: 32, minHeight: 32, allowGif: true });
assert.equal((await sharp(avatar).metadata()).format, "webp", "avatars may start as GIF and are stored as WebP");

// ── Public URLs only for well-formed approved files ─────────────────────────
const logoUrl = publicMediaUrl("logo", BUSINESS_ID, wordmark.file);
assert.ok(logoUrl?.includes(`/${config.publicMediaBucket}/business-media/${BUSINESS_ID}/${wordmark.file}`));
assert.equal(publicMediaUrl("logo", BUSINESS_ID, "../../avatars/7/profile"), null);
assert.equal(publicMediaUrl("logo", BUSINESS_ID, cover.file), null, "a cover file is not a logo");
assert.equal(publicMediaUrl("cover", "not-a-uuid", cover.file), null);

const summary = toPublicBusinessSummary(
  { id: BUSINESS_ID, slug: "market-bridge", name: "Market Bridge", logoFile: wordmark.file, coverFile: "cover-evil.svg" },
  "2026-10-15T10:00:00.000Z",
);
assert.equal(summary.logoUrl, logoUrl);
assert.equal(summary.coverUrl, null, "a malformed snapshot value never becomes a URL");
assert.equal("logoFile" in summary, false);

// Link previews use the business's own image.
const shared = injectPublicBusinessMetadata(
  "<html><head><title>x</title></head><body></body></html>",
  { ...summary, coverUrl: "https://cdn.example/cover.webp", description: "", problem: "", solution: "", targetCustomer: "", websiteUrl: "", team: [] },
  "https://example.app",
  "market-bridge",
);
assert.match(shared, /property="og:image" content="https:\/\/cdn\.example\/cover\.webp"/);

// ── Public team: allowlisted fields, role order, cap ────────────────────────
const team = toPublicTeam(
  [
    { user_id: 3, role: "editor", public_title: "  Head of Growth ", joined_at: "2026-02-01" },
    { user_id: 1, role: "owner", public_title: null, joined_at: "2026-01-01" },
    { user_id: 4, role: "viewer", public_title: "x", joined_at: "2026-03-01" },
  ],
  [
    { id: 1, name: "Amaka Obi", avatar_url: TRUSTED_AVATAR_URL },
    { id: 3, name: "Tunde Bello", avatar_url: "javascript:alert(1)" },
    { id: 4, name: "  ", avatar_url: null },
  ],
);
assert.deepEqual(team, [
  { name: "Amaka Obi", title: "", avatarUrl: TRUSTED_AVATAR_URL, handle: null },
  { name: "Tunde Bello", title: "Head of Growth", avatarUrl: null, handle: null },
]);
assert.deepEqual(Object.keys(team[0]), ["name", "title", "avatarUrl", "handle"], "no ids, emails or roles");
assert.equal(
  toPublicTeam([{ user_id: 1, role: "owner" }], [{ id: 1, name: "Amaka Obi" }], new Map([[1, "amaka-obi-1a2b"]]))[0].handle,
  "amaka-obi-1a2b",
  "a team member links to their founder page",
);

// ── A member changes only their own public profile ──────────────────────────
const mutableSupabase = supabase as any;
const originalFrom = mutableSupabase.from;
const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
mutableSupabase.from = (table: string) => {
  const query: any = {
    update: (...args: unknown[]) => { calls.push({ table, op: "update", args }); return query; },
    insert: async (...args: unknown[]) => { calls.push({ table, op: "insert", args }); return { error: null }; },
    eq: (...args: unknown[]) => { calls.push({ table, op: "eq", args }); return query; },
    select: () => query,
    maybeSingle: async () => ({ data: { public_display_consent: true, public_title: "Co-founder & CEO" }, error: null }),
  };
  return query;
};
function recorder() {
  const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };
  return res as Response & { statusCode: number; body: any };
}
try {
  const res = recorder();
  await updateMyPublicProfile(
    {
      user: { id: 7 },
      businessMembership: { businessId: BUSINESS_ID, role: "viewer" },
      body: { consent: true, title: "Co-founder &\n CEO", userId: 99 },
    } as unknown as Request,
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.publicDisplayConsent, true);
  assert.equal(res.body.data.publicTitle, "Co-founder & CEO");
  assert.match(res.body.data.founderHandle, /^founder-[0-9a-f]{4}$/, "consenting creates a founder page handle");
  const update = calls.find((c) => c.table === "business_members" && c.op === "update")!;
  assert.equal((update.args[0] as any).public_display_consent, true);
  assert.equal((update.args[0] as any).public_title, "Co-founder & CEO", "control characters collapse to spaces");
  const filters = calls.filter((c) => c.table === "business_members" && c.op === "eq").map((c) => c.args);
  assert.deepEqual(filters, [["business_id", BUSINESS_ID], ["user_id", 7], ["status", "active"]], "the caller's own row, never a body-supplied id");

  const bad = recorder();
  await updateMyPublicProfile(
    { user: { id: 7 }, businessMembership: { businessId: BUSINESS_ID, role: "owner" }, body: { consent: "yes" } } as unknown as Request,
    bad,
  );
  assert.equal(bad.statusCode, 400);
  const long = recorder();
  await updateMyPublicProfile(
    { user: { id: 7 }, businessMembership: { businessId: BUSINESS_ID, role: "owner" }, body: { consent: true, title: "x".repeat(81) } } as unknown as Request,
    long,
  );
  assert.equal(long.statusCode, 400);
} finally {
  mutableSupabase.from = originalFrom;
}

// ── Migration ───────────────────────────────────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0028_business_media_and_team.sql", import.meta.url), "utf8");
assert.match(migration, /'logoFile', current_business\.logo_file/);
assert.match(migration, /NEW\.logo_file, NEW\.cover_file/, "image changes bump profile_version");
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0028'/);

console.log("Business media, public team and avatar re-encoding tests passed.");
process.exit(0);
