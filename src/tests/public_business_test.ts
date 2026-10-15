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
  "publishedAt",
]);
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
  "https://www.pitchnest.app",
  "market-bridge",
);
assert.match(profileHtml, /Market &lt;Bridge&gt;/);
assert.match(profileHtml, /name="robots" content="index, follow"/);
assert.match(profileHtml, /rel="canonical" href="https:\/\/www\.pitchnest\.app\/businesses\/market-bridge"/);
const unavailableHtml = injectPublicBusinessMetadata(
  htmlTemplate,
  null,
  "https://www.pitchnest.app",
  "private-draft",
);
assert.match(unavailableHtml, /name="robots" content="noindex, follow"/);

const cursorInput = {
  publishedAt: "2026-10-14T10:00:00.000Z",
  publicationId: "22222222-2222-4222-8222-222222222222",
};
assert.deepEqual(decodeDirectoryCursor(encodeDirectoryCursor(cursorInput)), cursorInput);
assert.equal(decodeDirectoryCursor("not-a-cursor"), null);

const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalEngagementFlag = config.discoverEngagementEnabled;
(config as any).discoverEngagementEnabled = true;
let recordedRpc: { name: string; args: any } | null = null;
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
  return {
    data: [
      {
        publication_id: "22222222-2222-4222-8222-222222222222",
        published_at: "2026-10-14T10:00:00.000Z",
        public_snapshot: privateSnapshot,
      },
      {
        publication_id: "33333333-3333-4333-8333-333333333333",
        published_at: "2026-10-13T10:00:00.000Z",
        public_snapshot: { ...privateSnapshot, slug: "second", name: "Second" },
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
  assert.equal(recordedRpc?.name, "discover_public_businesses");
  assert.equal(recordedRpc?.args.p_query, "trade");
  assert.equal(recordedRpc?.args.p_business_type, "services");
  assert.equal(recordedRpc?.args.p_limit, 2);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].slug, "market-bridge");
  assert.equal(response.body.pagination.hasMore, true);
  assert.ok(decodeDirectoryCursor(response.body.pagination.nextCursor));
  // Counts ride along, looked up by the snapshot id, which is never emitted.
  assert.deepEqual(engagementArgs, { p_business_ids: [privateSnapshot.id], p_viewer_id: null });
  assert.deepEqual(response.body.data[0].engagement, { supportCount: 4, commentCount: 2 });
  assert.equal("id" in response.body.data[0], false);
  assert.equal(JSON.stringify(response.body).includes(privateSnapshot.id), false);

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
  "https://www.pitchnest.app",
  "market-bridge",
);
assert.match(shareDocument, /<meta property="og:title" content="Market &lt;Bridge&gt; — PitchNest" \/>/);
assert.match(shareDocument, /href="https:\/\/www\.pitchnest\.app\/businesses\/market-bridge"/);
assert.doesNotMatch(shareDocument, /<Bridge>/);
const missingShareDocument = renderPublicBusinessShareDocument(null, "https://www.pitchnest.app", "private-draft");
assert.match(missingShareDocument, /name="robots" content="noindex, follow"/);
assert.match(missingShareDocument, /href="https:\/\/www\.pitchnest\.app\/discover"/);

const migration = readFileSync(
  new URL("../../migrations/0020_discover_public_reads.sql", import.meta.url),
  "utf8",
);
assert.match(migration, /publication\.status = 'active'/);
assert.match(migration, /business\.status = 'published'/);
assert.match(migration, /public_snapshot/);
assert.doesNotMatch(migration, /sessions|decks|transcripts|evaluation_report/i);

console.log("Public business serialization and discovery tests passed.");
