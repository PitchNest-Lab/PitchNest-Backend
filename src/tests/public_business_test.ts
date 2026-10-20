import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import {
  decodeDirectoryCursor,
  encodeDirectoryCursor,
  listPublicBusinesses,
  toPublicBusinessProfile,
  toPublicBusinessSummary,
} from "../controllers/publicBusinessController.ts";
import {
  injectPublicBusinessMetadata,
  renderPublicBusinessShareDocument,
} from "../utils/publicBusinessMetadata.ts";
import { config } from "../config/env.ts";

type RecordedResponse = Response & {
  statusCode: number;
  body?: any;
  headers: Record<string, string>;
};

function responseRecorder(): RecordedResponse {
  const response: Partial<RecordedResponse> = {
    statusCode: 200,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this as RecordedResponse;
    },
    set(field: string | Record<string, string>, value?: string | string[]) {
      if (typeof field === "string" && value !== undefined) {
        this.headers![field] = Array.isArray(value) ? value.join(", ") : value;
      } else if (field && typeof field === "object") {
        Object.assign(this.headers!, field);
      }
      return this as RecordedResponse;
    },
    json(body: any) {
      this.body = body;
      return this as RecordedResponse;
    },
  };
  return response as RecordedResponse;
}

const privateSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "market-bridge",
  name: "Market Bridge",
  tagline: "Trade infrastructure for local merchants",
  description: "A public approved description.",
  businessType: "services",
  industry: "Commerce",
  stage: "Seed",
  region: "West Africa",
  problem: "Fragmented trade tools",
  solution: "One operating layer",
  targetCustomer: "Local merchants",
  websiteUrl: "https://example.com/path",
  status: "published",
  createdBy: 7,
  privateDeckUrl: "private/deck.pdf",
  transcript: "must-not-leak",
  evaluationReport: { score: 99 },
};

const summary = toPublicBusinessSummary(privateSnapshot, "2026-10-14T10:00:00.000Z");
assert.deepEqual(Object.keys(summary), [
  "slug",
  "name",
  "tagline",
  "businessType",
  "industry",
  "stage",
  "region",
  "logoUrl",
  "coverUrl",
  "publishedAt",
  "isExample",
]);
assert.equal(summary.logoUrl, null, "no approved logo, no URL");
assert.equal("id" in summary, false);
assert.equal("transcript" in summary, false);
// Only a snapshot flagged true is an example; anything else is a real business.
assert.equal(summary.isExample, false);
assert.equal(toPublicBusinessSummary({ ...privateSnapshot, isExample: true }, null).isExample, true);
assert.equal(toPublicBusinessSummary({ ...privateSnapshot, isExample: "true" }, null).isExample, false);

const profile = toPublicBusinessProfile(privateSnapshot, "2026-10-14T10:00:00.000Z");
assert.equal(profile.description, "A public approved description.");
assert.equal(profile.websiteUrl, "https://example.com/path");
assert.equal("privateDeckUrl" in profile, false);
assert.equal("evaluationReport" in profile, false);

const htmlTemplate = `<!doctype html><html><head>
  <meta name="description" content="default" />
  <meta property="og:title" content="default" />
  <title>PitchNest</title>
</head><body><div id="root"></div></body></html>`;
const profileHtml = injectPublicBusinessMetadata(
  htmlTemplate,
  { ...profile, name: "Market <Bridge>" },
  "https://site.example",
  "market-bridge",
);
assert.match(profileHtml, /Market &lt;Bridge&gt;/);
assert.match(profileHtml, /name="robots" content="index, follow"/);
assert.match(profileHtml, /rel="canonical" href="https:\/\/site\.example\/businesses\/market-bridge"/);
const unavailableHtml = injectPublicBusinessMetadata(
  htmlTemplate,
  null,
  "https://site.example",
  "private-draft",
);
assert.match(unavailableHtml, /name="robots" content="noindex, follow"/);
// Example profiles are kept out of search results.
const exampleHtml = injectPublicBusinessMetadata(
  htmlTemplate,
  { ...profile, isExample: true },
  "https://site.example",
  "market-bridge",
);
assert.match(exampleHtml, /name="robots" content="noindex, follow"/);

const cursorInput = {
  publishedAt: "2026-10-14T10:00:00.000Z",
  publicationId: "22222222-2222-4222-8222-222222222222",
};
assert.deepEqual(decodeDirectoryCursor(encodeDirectoryCursor(cursorInput)), cursorInput);
assert.equal(decodeDirectoryCursor("not-a-cursor"), null);
// A most-supported cursor also carries the support count, a whole number.
const supportCursor = { supportCount: 12, ...cursorInput };
assert.deepEqual(decodeDirectoryCursor(encodeDirectoryCursor(supportCursor)), supportCursor);
for (const supportCount of [-1, 1.5, "12", null]) {
  assert.equal(decodeDirectoryCursor(encodeDirectoryCursor({ ...cursorInput, supportCount } as any)), null);
}
// A cursor from the real-first list also says which side of the examples it is on.
const rankedCursor = { isExample: false, supportCount: 12, ...cursorInput };
assert.deepEqual(decodeDirectoryCursor(encodeDirectoryCursor(rankedCursor)), rankedCursor);
for (const isExample of ["false", 0, null]) {
  assert.equal(decodeDirectoryCursor(encodeDirectoryCursor({ ...cursorInput, isExample } as any)), null);
}

const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalEngagementFlag = config.discoverEngagementEnabled;
(config as any).discoverEngagementEnabled = true;
let recordedRpc: { name: string; args: any } | null = null;
const directoryCalls: string[] = [];
// Functions the fake database lacks, and one that fails for another reason.
const missing = new Set<string>();
let failWith: { name: string; error: any } | null = null;
let engagementArgs: any = null;
mutableSupabase.rpc = async (name: string, args: any) => {
  if (name === "public_business_engagement") {
    engagementArgs = args;
    return {
      data: [
        {
          engaged_business_id: privateSnapshot.id,
          support_count: 4,
          follower_count: 9,
          comment_count: 2,
          viewer_supports: false,
          viewer_follows: false,
          viewer_is_member: false,
        },
      ],
      error: null,
    };
  }
  recordedRpc = { name, args };
  directoryCalls.push(name);
  if (missing.has(name)) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  if (failWith?.name === name) return { data: null, error: failWith.error };
  return {
    data: [
      {
        publication_id: "22222222-2222-4222-8222-222222222222",
        published_at: "2026-10-14T10:00:00.000Z",
        public_snapshot: privateSnapshot,
        support_count: 12,
        is_example: false,
      },
      {
        publication_id: "33333333-3333-4333-8333-333333333333",
        published_at: "2026-10-13T10:00:00.000Z",
        public_snapshot: { ...privateSnapshot, slug: "second", name: "Second", isExample: true },
        support_count: 5,
        is_example: true,
      },
    ],
    error: null,
  };
};
const list = async (query: Record<string, string>) => {
  directoryCalls.length = 0;
  const response = responseRecorder();
  await listPublicBusinesses({ query } as unknown as Request, response);
  return response;
};

try {
  const response = await list({ q: "  trade  ", type: "services", industry: "Commerce", limit: "1" });
  assert.equal(response.statusCode, 200);
  // Engagement is on: real businesses first, then most supported (migration 0034).
  assert.deepEqual(directoryCalls, ["discover_public_businesses_ranked"]);
  assert.equal(recordedRpc?.args.p_by_support, true);
  assert.equal(recordedRpc?.args.p_cursor_is_example, null);
  assert.equal(recordedRpc?.args.p_cursor_support_count, null);
  assert.equal(recordedRpc?.args.p_query, "trade");
  assert.equal(recordedRpc?.args.p_business_type, "services");
  assert.equal(recordedRpc?.args.p_limit, 2);
  assert.equal(response.body.order, "most_supported");
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].slug, "market-bridge");
  assert.equal(response.body.data[0].isExample, false);
  assert.equal(response.body.pagination.hasMore, true);
  assert.deepEqual(decodeDirectoryCursor(response.body.pagination.nextCursor), { isExample: false, supportCount: 12, ...cursorInput });
  // Counts ride along, looked up by the snapshot id, which is never emitted.
  assert.deepEqual(engagementArgs, { p_business_ids: [privateSnapshot.id], p_viewer_id: null });
  assert.deepEqual(response.body.data[0].engagement, { supportCount: 4, commentCount: 2 });
  assert.equal("id" in response.body.data[0], false);
  assert.equal(JSON.stringify(response.body).includes(privateSnapshot.id), false);

  // The next page continues after every sort key of the last row.
  await list({ cursor: response.body.pagination.nextCursor });
  assert.deepEqual(directoryCalls, ["discover_public_businesses_ranked"]);
  assert.equal(recordedRpc?.args.p_by_support, true);
  assert.equal(recordedRpc?.args.p_cursor_is_example, false);
  assert.equal(recordedRpc?.args.p_cursor_support_count, 12);
  assert.equal(recordedRpc?.args.p_cursor_published_at, "2026-10-14T10:00:00.000Z");
  assert.equal(recordedRpc?.args.p_cursor_publication_id, "22222222-2222-4222-8222-222222222222");

  // An example on the page says so.
  const both = await list({ limit: "2" });
  assert.deepEqual(both.body.data.map((business: any) => business.isExample), [false, true]);

  // Cursors handed out before 0034 keep the order of their page.
  await list({ cursor: encodeDirectoryCursor(supportCursor) });
  assert.deepEqual(directoryCalls, ["discover_public_businesses_by_support"]);
  assert.equal(recordedRpc?.args.p_cursor_support_count, 12);
  const newestPage = await list({ cursor: encodeDirectoryCursor(cursorInput) });
  assert.deepEqual(directoryCalls, ["discover_public_businesses"]);
  assert.equal(newestPage.body.order, "newest");

  // A database without 0034 falls back to 0033's order, and without 0033 to
  // newest first. Each missing function is logged once.
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...parts: unknown[]) => void warnings.push(parts);
  try {
    missing.add("discover_public_businesses_ranked");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fallback = await list({ limit: "1" });
      assert.equal(fallback.statusCode, 200);
      assert.deepEqual(directoryCalls, ["discover_public_businesses_ranked", "discover_public_businesses_by_support"]);
      assert.equal(fallback.body.order, "most_supported");
      assert.deepEqual(decodeDirectoryCursor(fallback.body.pagination.nextCursor), { supportCount: 12, ...cursorInput });
    }
    missing.add("discover_public_businesses_by_support");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fallback = await list({ limit: "1" });
      assert.equal(fallback.statusCode, 200);
      assert.deepEqual(directoryCalls, [
        "discover_public_businesses_ranked",
        "discover_public_businesses_by_support",
        "discover_public_businesses",
      ]);
      assert.equal(fallback.body.order, "newest");
      assert.deepEqual(decodeDirectoryCursor(fallback.body.pagination.nextCursor), cursorInput);
    }
    assert.equal(warnings.length, 2);
    missing.clear();

    // Any other database error stays an error, not a silent change of order.
    failWith = { name: "discover_public_businesses_ranked", error: { code: "57014", message: "canceling statement due to statement timeout" } };
    console.error = () => {};
    const failing = await list({});
    assert.equal(failing.statusCode, 500);
    assert.deepEqual(directoryCalls, ["discover_public_businesses_ranked"]);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    missing.clear();
    failWith = null;
  }

  // With Discover engagement off, supports are not public: real businesses
  // first, then newest first.
  (config as any).discoverEngagementEnabled = false;
  const engagementOff = await list({ limit: "1" });
  assert.deepEqual(directoryCalls, ["discover_public_businesses_ranked"]);
  assert.equal(recordedRpc?.args.p_by_support, false);
  assert.equal(engagementOff.body.order, "newest");
  assert.deepEqual(decodeDirectoryCursor(engagementOff.body.pagination.nextCursor), { isExample: false, ...cursorInput });
  await list({ cursor: engagementOff.body.pagination.nextCursor });
  assert.equal(recordedRpc?.args.p_by_support, false);
  assert.equal(recordedRpc?.args.p_cursor_is_example, false);
  assert.equal(recordedRpc?.args.p_cursor_support_count, 0);
  (config as any).discoverEngagementEnabled = true;

  const invalidCursorResponse = await list({ cursor: "tampered" });
  assert.equal(invalidCursorResponse.statusCode, 400);
} finally {
  mutableSupabase.rpc = originalRpc;
  (config as any).discoverEngagementEnabled = originalEngagementFlag;
}

// Crawler share document: escaped, canonical, and noindex when unavailable.
const shareDocument = renderPublicBusinessShareDocument(
  { ...profile, name: "Market <Bridge>" },
  "https://site.example",
  "market-bridge",
);
assert.match(shareDocument, /<meta property="og:title" content="Market &lt;Bridge&gt; — PitchNest" \/>/);
assert.match(shareDocument, /href="https:\/\/site\.example\/businesses\/market-bridge"/);
assert.doesNotMatch(shareDocument, /<Bridge>/);
const missingShareDocument = renderPublicBusinessShareDocument(null, "https://site.example", "private-draft");
assert.match(missingShareDocument, /name="robots" content="noindex, follow"/);
assert.match(missingShareDocument, /href="https:\/\/site\.example\/discover"/);

const migration = readFileSync(
  new URL("../../migrations/0020_discover_public_reads.sql", import.meta.url),
  "utf8",
);
assert.match(migration, /publication\.status = 'active'/);
assert.match(migration, /business\.status = 'published'/);
assert.match(migration, /public_snapshot/);
assert.doesNotMatch(migration, /sessions|decks|transcripts|evaluation_report/i);

const supportOrderMigration = readFileSync(
  new URL("../../migrations/0033_discover_most_supported.sql", import.meta.url),
  "utf8",
);
assert.match(supportOrderMigration, /publication\.status = 'active'/);
assert.match(supportOrderMigration, /business\.status = 'published'/);
assert.match(supportOrderMigration, /FROM business_supports/);
assert.match(supportOrderMigration, /GRANT EXECUTE ON FUNCTION discover_public_businesses_by_support\([^)]*\) TO service_role;/);
assert.doesNotMatch(supportOrderMigration, /sessions|decks|transcripts|evaluation_report/i);

const exampleMigration = readFileSync(
  new URL("../../migrations/0034_example_businesses.sql", import.meta.url),
  "utf8",
);
assert.match(exampleMigration, /publication\.status = 'active'/);
assert.match(exampleMigration, /business\.status = 'published'/);
assert.match(exampleMigration, /GRANT EXECUTE ON FUNCTION discover_public_businesses_ranked\([^)]*\) TO service_role;/);
assert.match(exampleMigration, /GRANT EXECUTE ON FUNCTION list_public_pitches\([^)]*\) TO service_role;/);
assert.doesNotMatch(exampleMigration, /sessions|decks|transcripts|evaluation_report/i);

console.log("Public business serialization and discovery tests passed.");
