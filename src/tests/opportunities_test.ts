import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import {
  createOpportunity,
  listPublicOpportunities,
  opportunityState,
  toPublicOpportunity,
  toStaffOpportunity,
  updateOpportunity,
  validateOpportunityInput,
} from "../controllers/opportunityController.ts";

function queryStub(resolve: (calls: any[][]) => { data: any; error: any }) {
  const calls: any[][] = [];
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (onFulfilled: any, onRejected: any) =>
            Promise.resolve(resolve(calls)).then(onFulfilled, onRejected);
        }
        if (prop === "maybeSingle" || prop === "single") return async () => resolve(calls);
        return (...args: any[]) => {
          calls.push([String(prop), ...args]);
          return proxy;
        };
      },
    },
  );
  return { proxy, calls };
}

function recorder() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(field: string, value: string) {
      this.headers[field] = value;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
}

// ─── Status is computed from dates ───────────────────────────────────────────
const TODAY = "2026-10-15";
assert.deepEqual(opportunityState(null, null, TODAY), { state: "rolling", daysLeft: null });
assert.deepEqual(opportunityState("2026-11-01", "2026-12-01", TODAY).state, "upcoming");
assert.deepEqual(opportunityState(null, "2026-12-01", TODAY), { state: "open", daysLeft: 47 });
assert.deepEqual(opportunityState(null, "2026-10-20", TODAY), { state: "closing_soon", daysLeft: 5 });
assert.deepEqual(opportunityState(null, "2026-10-15", TODAY), { state: "closing_soon", daysLeft: 0 }, "closing day is still open");
assert.deepEqual(opportunityState(null, "2026-10-14", TODAY), { state: "closed", daysLeft: -1 });

// ─── Validation ──────────────────────────────────────────────────────────────
const valid = validateOpportunityInput({
  title: "  Lagos Seed Accelerator \n Cohort 4 ",
  organizer: "Example Ventures",
  kind: "accelerator",
  summary: "A 12-week programme for pre-seed founders in West Africa.",
  sourceUrl: "https://example.org/apply",
  region: "West Africa",
  opensOn: "2026-10-01",
  closesOn: "2026-11-30",
});
assert.deepEqual(valid.errors, []);
assert.equal(valid.values.title, "Lagos Seed Accelerator Cohort 4", "titles collapse to one line");
assert.equal(valid.values.source_url, "https://example.org/apply");

const missing = validateOpportunityInput({ title: "Short" });
assert.ok(missing.errors.some((e) => e.includes("organizer")));
assert.ok(missing.errors.some((e) => e.includes("summary")));
assert.ok(missing.errors.some((e) => e.includes("sourceUrl")), "every listing must link its official source");
assert.ok(missing.errors.some((e) => e.includes("kind")));

for (const badUrl of ["javascript:alert(1)", "ftp://example.org", "not a url", "https://exa mple.org"]) {
  assert.ok(
    validateOpportunityInput({ ...valid.values, title: "Valid title", organizer: "Org", kind: "grant", summary: "x".repeat(20), sourceUrl: badUrl }).errors.some((e) => e.includes("sourceUrl")),
    `must refuse ${badUrl}`,
  );
}
assert.ok(validateOpportunityInput({ closesOn: "2026-13-45" }, { partial: true }).errors.length > 0);
assert.ok(
  validateOpportunityInput({ opensOn: "2026-12-01", closesOn: "2026-11-01" }, { partial: true }).errors.some((e) => e.includes("opensOn")),
);
assert.deepEqual(validateOpportunityInput({ status: "published" }, { partial: true }).values, { status: "published" });
assert.ok(validateOpportunityInput({ status: "deleted" }, { partial: true }).errors.length > 0);
assert.deepEqual(
  validateOpportunityInput({ closesOn: "" }, { partial: true }).values,
  { closes_on: null },
  "clearing a date is allowed",
);

// ─── Serializers ─────────────────────────────────────────────────────────────
const row = {
  opportunity_id: "o1",
  title: "Lagos Seed Accelerator",
  organizer: "Example Ventures",
  kind: "accelerator",
  summary: "A programme.",
  eligibility: null,
  region: "West Africa",
  sector: null,
  source_url: "javascript:alert(1)",
  opens_on: "2026-10-01",
  closes_on: "2026-10-20",
  last_checked_at: "2026-10-10T09:00:00.000Z",
  created_by: 7,
  status: "published",
};
const publicView = toPublicOpportunity(row, TODAY);
assert.equal(publicView.sourceUrl, "", "unsafe links never reach the page");
assert.equal(publicView.state, "closing_soon");
assert.equal("created_by" in publicView, false);
assert.equal("status" in publicView, false, "draft/published state is staff-only");

const staleView = toStaffOpportunity({ ...row, last_checked_at: "2026-08-01T00:00:00.000Z" }, new Date("2026-10-15T12:00:00Z"));
assert.equal(staleView.stale, true, "listings not re-checked in 30 days are flagged");
assert.equal(toStaffOpportunity(row, new Date("2026-10-15T12:00:00Z")).stale, false);

// ─── Handlers ────────────────────────────────────────────────────────────────
const mutableSupabase = supabase as any;
const originalRpc = mutableSupabase.rpc;
const originalFrom = mutableSupabase.from;

try {
  let rpcArgs: any = null;
  mutableSupabase.rpc = async (name: string, args: any) => {
    assert.equal(name, "list_public_opportunities");
    rpcArgs = args;
    return { data: [row], error: null };
  };
  const listed = recorder();
  await listPublicOpportunities({ query: { kind: "accelerator", includeClosed: "true" } } as unknown as Request, listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(rpcArgs.p_kind, "accelerator");
  assert.equal(rpcArgs.p_include_closed, true);
  const badKind = recorder();
  await listPublicOpportunities({ query: { kind: "lottery" } } as unknown as Request, badKind);
  assert.equal(badKind.statusCode, 400);

  let inserted: any = null;
  mutableSupabase.from = (table: string) => {
    assert.equal(table, "opportunities");
    return queryStub((calls) => {
      inserted = calls.find(([op]) => op === "insert")?.[1];
      return { data: { ...inserted, id: "o2", created_at: "x", updated_at: "y" }, error: null };
    }).proxy;
  };
  const created = recorder();
  await createOpportunity(
    {
      body: {
        title: "Climate Founders Grant",
        organizer: "Example Foundation",
        kind: "grant",
        summary: "Non-dilutive grants for clean energy founders.",
        sourceUrl: "https://example.org/grant",
        createdBy: 999,
        status: "published",
      },
      user: { id: 7, email: "staff@example.com", accountType: "user" },
    } as unknown as Request,
    created,
  );
  assert.equal(created.statusCode, 201);
  assert.equal(inserted.created_by, 7, "the staff member is recorded, never a body id");
  assert.equal(inserted.status, "published");
  assert.ok(inserted.last_checked_at);

  const badId = recorder();
  await updateOpportunity({ params: { id: "1;drop" }, body: { title: "New title" }, user: { id: 7 } } as unknown as Request, badId);
  assert.equal(badId.statusCode, 404);
} finally {
  mutableSupabase.rpc = originalRpc;
  mutableSupabase.from = originalFrom;
}

// ─── Migration guards ────────────────────────────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0024_opportunities.sql", import.meta.url), "utf8");
assert.match(migration, /opportunity\.status = 'published'/, "the public feed only returns published listings");
assert.match(migration, /CURRENT_DATE - 60/, "long-closed listings drop out");
assert.match(migration, /source_url TEXT NOT NULL/);
assert.match(migration, /REVOKE ALL ON FUNCTION list_public_opportunities\([^)]*\) FROM PUBLIC, anon, authenticated;/);
assert.match(migration, /INSERT INTO schema_migrations[\s\S]*'0024'/);

console.log("Opportunity tests passed.");
process.exit(0);
