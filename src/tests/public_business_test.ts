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
]);
assert.equal(summary.logoUrl, null, "no approved logo, no URL");
assert.equal("id" in summary, false);
assert.equal("transcript" in summary, false);

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

const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalEngagementFlag = config.discoverEngagementEnabled;
(config as any).discoverEngagementEnabled = true;
let recordedRpc: { name: string; args: any } | null = null;
const directoryCalls: string[] = [];
let bySupportResult: any = null;
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
  if (name === "discover_public_businesses_by_support" && bySupportResult) return bySupportResult;
  return {
    data: [
      {
        publication_id: "22222222-2222-4222-8222-222222222222",
        published_at: "2026-10-14T10:00:00.000Z",
        public_snapshot: privateSnapshot,
        support_count: 12,
      },
      {
        publication_id: "33333333-3333-4333-8333-333333333333",
        published_at: "2026-10-13T10:00:00.000Z",
        public_snapshot: { ...privateSnapshot, slug: "second", name: "Second" },
        support_count: 5,
      },
    ],
    error: null,
  };
};

try {
  const response = responseRecorder();
  await listPublicBusinesses(
    {
      query: {
        q: "  trade  ",
        type: "services",
        industry: "Commerce",
        limit: "1",
      },
    } as unknown as Request,
    response,
  );
  assert.equal(response.statusCode, 200);
  // Discover engagement is on, so the most-supported list (migration 0033).
  assert.equal(recordedRpc?.name, "discover_public_businesses_by_support");
  assert.equal(recordedRpc?.args.p_cursor_support_count, null);
  assert.equal(recordedRpc?.args.p_query, "trade");
  assert.equal(recordedRpc?.args.p_business_type, "services");
  assert.equal(recordedRpc?.args.p_limit, 2);
  assert.equal(response.body.order, "most_supported");
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].slug, "market-bridge");
  assert.equal(response.body.pagination.hasMore, true);
  assert.equal(decodeDirectoryCursor(response.body.pagination.nextCursor)?.supportCount, 12);
  // Counts ride along, looked up by the snapshot id, which is never emitted.
  assert.deepEqual(engagementArgs, { p_business_ids: [privateSnapshot.id], p_viewer_id: null });
  assert.deepEqual(response.body.data[0].engagement, { supportCount: 4, commentCount: 2 });
  assert.equal("id" in response.body.data[0], false);
  assert.equal(JSON.stringify(response.body).includes(privateSnapshot.id), false);

  // The next page continues after all three sort keys of the last row.
  await listPublicBusinesses(
    { query: { cursor: response.body.pagination.nextCursor } } as unknown as Request,
    responseRecorder(),
  );
  assert.equal(recordedRpc?.name, "discover_public_businesses_by_support");
  assert.equal(recordedRpc?.args.p_cursor_support_count, 12);
  assert.equal(recordedRpc?.args.p_cursor_published_at, "2026-10-14T10:00:00.000Z");
  assert.equal(recordedRpc?.args.p_cursor_publication_id, "22222222-2222-4222-8222-222222222222");

  // A newest-first cursor stays newest first.
  const newestPage = responseRecorder();
  await listPublicBusinesses(
    { query: { cursor: encodeDirectoryCursor(cursorInput) } } as unknown as Request,
    newestPage,
  );
  assert.equal(recordedRpc?.name, "discover_public_businesses");
  assert.equal(newestPage.body.order, "newest");

  // A database without 0033 lists newest first and says so once in the log.
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...parts: unknown[]) => void warnings.push(parts);
  try {
    bySupportResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      directoryCalls.length = 0;
      const fallback = responseRecorder();
      await listPublicBusinesses({ query: { limit: "1" } } as unknown as Request, fallback);
      assert.equal(fallback.statusCode, 200);
      assert.deepEqual(directoryCalls, ["discover_public_businesses_by_support", "discover_public_businesses"]);
      assert.equal(fallback.body.order, "newest");
      assert.equal(decodeDirectoryCursor(fallback.body.pagination.nextCursor)?.supportCount, undefined);
    }
    assert.equal(warnings.length, 1);

    // Any other database error stays an error, not a silent change of order.
    bySupportResult = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
    console.error = () => {};
    const failing = responseRecorder();
    await listPublicBusinesses({ query: {} } as unknown as Request, failing);
    assert.equal(failing.statusCode, 500);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    bySupportResult = null;
  }

  // With Discover engagement off, supports are not public: newest first.
  (config as any).discoverEngagementEnabled = false;
  directoryCalls.length = 0;
  const engagementOff = responseRecorder();
  await listPublicBusinesses({ query: {} } as unknown as Request, engagementOff);
  assert.deepEqual(directoryCalls, ["discover_public_businesses"]);
  assert.equal(engagementOff.body.order, "newest");
  (config as any).discoverEngagementEnabled = true;

  const invalidCursorResponse = responseRecorder();
  await listPublicBusinesses(
    { query: { cursor: "tampered" } } as unknown as Request,
    invalidCursorResponse,
  );
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

console.log("Public business serialization and discovery tests passed.");
