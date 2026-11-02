import "./testEnv.ts";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import {
  BUSINESS_PUBLICATION_CONSENT_VERSION,
  getLegacyBusinessDraft,
  legacyProfileToBusinessDraft,
  publicationBlockers,
  publishBusiness,
  slugifyBusinessName,
  toPrivateBusiness,
  toPublicBusinessPreview,
  validateBusinessInput,
} from "../controllers/businessController.ts";
import {
  requireBusinessMembership,
  requireBusinessRole,
} from "../middleware/businessAccessMiddleware.ts";

type RecordedResponse = Response & { statusCode: number; body?: any };

function responseRecorder(): RecordedResponse {
  const response: Partial<RecordedResponse> = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this as RecordedResponse;
    },
    json(body: any) {
      this.body = body;
      return this as RecordedResponse;
    },
  };
  return response as RecordedResponse;
}

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

const valid = validateBusinessInput({
  name: "  Market Bridge  ",
  businessType: "services",
  tagline: "Trade infrastructure for local merchants",
  websiteUrl: "https://example.com/path",
});
assert.deepEqual(valid.errors, []);
assert.equal(valid.values.name, "Market Bridge");
assert.equal(valid.values.business_type, "services");

const invalid = validateBusinessInput({
  name: "x",
  businessType: "rocket",
  websiteUrl: "javascript:alert(1)",
});
assert.equal(invalid.errors.some((error) => error.includes("name")), true);
assert.equal(invalid.errors.some((error) => error.includes("businessType")), true);
assert.equal(invalid.errors.some((error) => error.includes("http")), true);

const partial = validateBusinessInput(
  { tagline: "Updated", createdBy: 999, status: "published" },
  { partial: true },
);
assert.deepEqual(partial.errors, []);
assert.deepEqual(partial.values, { tagline: "Updated" });

assert.equal(slugifyBusinessName("  Café & Market  "), "cafe-market");
assert.equal(slugifyBusinessName("🔥"), "business");

const row = {
  id: BUSINESS_ID,
  slug: "market-bridge",
  name: "Market Bridge",
  tagline: "Merchant infrastructure",
  description: "A sufficiently detailed business profile.",
  business_type: "services",
  industry: "Commerce",
  stage: "Early stage",
  region: "West Africa",
  problem: "Fragmented trade tools",
  solution: "One operating layer",
  target_customer: "Local merchants",
  website_url: "https://example.com",
  status: "draft",
  profile_version: 3,
  created_by: 7,
  created_at: "2026-10-14T00:00:00.000Z",
  updated_at: "2026-10-14T00:00:00.000Z",
  private_deck_url: "must-not-leak",
  transcript: "must-not-leak",
};
const privateView = toPrivateBusiness(row, "owner");
const publicPreview = toPublicBusinessPreview(row);
assert.equal(privateView.membershipRole, "owner");
assert.equal("created_by" in privateView, false);
assert.equal("private_deck_url" in privateView, false);
assert.equal("transcript" in publicPreview, false);
assert.equal("status" in publicPreview, false);
assert.deepEqual(publicationBlockers(row), []);
assert.deepEqual(publicationBlockers({ ...row, tagline: "", region: null }), [
  "tagline",
  "region",
]);
// The pitch story is required before publication, and kept short.
assert.deepEqual(publicationBlockers({ ...row, problem: "", solution: "   " }), ["problem", "solution"]);
assert.deepEqual(
  validateBusinessInput({ problem: "p".repeat(500), solution: "s".repeat(500) }, { partial: true }).errors,
  [],
);
assert.deepEqual(validateBusinessInput({ problem: "p".repeat(501), solution: "s".repeat(501) }, { partial: true }).errors, [
  "problem is too long (max 500 characters).",
  "solution is too long (max 500 characters).",
]);

const legacyDraft = legacyProfileToBusinessDraft({
  id: 41,
  user_id: 7,
  startup_name: "  Legacy Labs  ",
  industry: "SaaS & Enterprise",
  funding_stage: "Pre-Seed",
  goal: "funding",
  private_notes: "must-not-leak",
});
assert.equal(legacyDraft.available, true);
assert.deepEqual(legacyDraft.draft, {
  name: "Legacy Labs",
  businessType: "software",
  tagline: "",
  description: "",
  industry: "SaaS & Enterprise",
  stage: "Pre-Seed",
  region: "",
  problem: "",
  solution: "",
  targetCustomer: "",
  websiteUrl: "",
});
assert.equal("goal" in (legacyDraft.draft as object), false);
assert.deepEqual(legacyProfileToBusinessDraft(null), {
  available: false,
  draft: null,
});

const mutableSupabase = supabase as any;
const originalFrom = mutableSupabase.from;
let legacyProfileUserId: unknown;

mutableSupabase.from = (table: string) => {
  assert.equal(table, "profiles");
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      assert.equal(column, "user_id");
      legacyProfileUserId = value;
      return query;
    },
    maybeSingle: async () => ({
      data: {
        startup_name: "Authenticated Founder Co",
        industry: "Fintech",
        funding_stage: "Seed",
        goal: "must-not-be-selected-or-returned",
      },
      error: null,
    }),
  };
  return query;
};

try {
  const response = responseRecorder();
  await getLegacyBusinessDraft(
    {
      user: { id: 7, email: "owner@example.com", accountType: "user" },
      query: { userId: "999" },
      body: { userId: 999 },
    } as unknown as Request,
    response,
  );
  assert.equal(legacyProfileUserId, 7);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.draft.name, "Authenticated Founder Co");
  assert.equal("goal" in response.body.data.draft, false);
} finally {
  mutableSupabase.from = originalFrom;
}

let membership: any = {
  business_id: BUSINESS_ID,
  user_id: 7,
  role: "editor",
  public_display_consent: false,
};
let queriedBusinessId: unknown;
let queriedUserId: unknown;

mutableSupabase.from = (table: string) => {
  assert.equal(table, "business_members");
  let eqIndex = 0;
  const query = {
    select: () => query,
    eq: (_column: string, value: unknown) => {
      if (eqIndex === 0) queriedBusinessId = value;
      if (eqIndex === 1) queriedUserId = value;
      eqIndex += 1;
      return query;
    },
    maybeSingle: async () => ({ data: membership, error: null }),
  };
  return query;
};

try {
  const request = {
    params: { id: BUSINESS_ID },
    body: { businessId: OTHER_BUSINESS_ID, ownerId: 999 },
    user: { id: 7, email: "owner@example.com", accountType: "user" },
  } as unknown as Request;
  const response = responseRecorder();
  let nextCalled = false;
  await requireBusinessMembership(
    request,
    response,
    (() => {
      nextCalled = true;
    }) as NextFunction,
  );

  assert.equal(nextCalled, true);
  assert.equal(queriedBusinessId, BUSINESS_ID);
  assert.equal(queriedUserId, 7);
  assert.equal(request.businessMembership?.businessId, BUSINESS_ID);
  assert.equal(request.businessMembership?.userId, 7);
  assert.equal(request.businessMembership?.role, "editor");

  const publishResponse = responseRecorder();
  let publishNextCalled = false;
  requireBusinessRole("owner", "admin")(
    request,
    publishResponse,
    (() => {
      publishNextCalled = true;
    }) as NextFunction,
  );
  assert.equal(publishNextCalled, false);
  assert.equal(publishResponse.statusCode, 403);

  membership = null;
  const otherUserRequest = {
    params: { id: BUSINESS_ID },
    user: { id: 88, email: "other@example.com", accountType: "user" },
  } as unknown as Request;
  const otherUserResponse = responseRecorder();
  let otherUserNextCalled = false;
  await requireBusinessMembership(
    otherUserRequest,
    otherUserResponse,
    (() => {
      otherUserNextCalled = true;
    }) as NextFunction,
  );
  assert.equal(otherUserNextCalled, false);
  assert.equal(otherUserResponse.statusCode, 404);

  const malformedResponse = responseRecorder();
  await requireBusinessMembership(
    {
      params: { id: "not-a-uuid" },
      user: { id: 7, email: "owner@example.com", accountType: "user" },
    } as unknown as Request,
    malformedResponse,
    (() => assert.fail("Malformed ids must not reach the database")) as NextFunction,
  );
  assert.equal(malformedResponse.statusCode, 400);

  console.log("Business authorization and serialization tests passed.");
} finally {
  mutableSupabase.from = originalFrom;
}

// Publishing is refused before the database is asked, whatever the client sends.
const originalRpc = mutableSupabase.rpc;
let storedBusiness: any = { ...row, solution: "" };
let publishRpcCalls = 0;
mutableSupabase.from = (table: string) => {
  assert.equal(table, "businesses");
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: storedBusiness, error: null }),
  };
  return query;
};
mutableSupabase.rpc = async (name: string) => {
  assert.equal(name, "publish_business");
  publishRpcCalls += 1;
  return { data: [{ ...storedBusiness, status: "published" }], error: null };
};

try {
  const publishRequest = {
    body: {
      confirmed: true,
      consentVersion: BUSINESS_PUBLICATION_CONSENT_VERSION,
      profileVersion: row.profile_version,
    },
    businessMembership: { businessId: BUSINESS_ID, userId: 7, role: "owner" },
    user: { id: 7, email: "owner@example.com", accountType: "user" },
  } as unknown as Request;

  const refused = responseRecorder();
  await publishBusiness(publishRequest, refused);
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.body.error, "Complete these fields before publishing: solution.");
  assert.equal(publishRpcCalls, 0, "an incomplete profile never reaches publish_business");

  storedBusiness = { ...row };
  const allowed = responseRecorder();
  await publishBusiness(publishRequest, allowed).catch(() => undefined);
  assert.equal(publishRpcCalls, 1, "a complete profile goes on to publish_business");

  console.log("Business publication requirement tests passed.");
} finally {
  mutableSupabase.from = originalFrom;
  mutableSupabase.rpc = originalRpc;
}
