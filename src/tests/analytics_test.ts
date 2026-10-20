import "./testEnv.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import {
  CLIENT_EVENTS,
  EVENT_RULES,
  getEventSummary,
  isEventName,
  logEvent,
  recordClientEvent,
  sanitizeEventProperties,
} from "../services/eventService.ts";
import { listPublicBusinesses } from "../controllers/publicBusinessController.ts";

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

// ─── Property allowlists ─────────────────────────────────────────────────────
assert.deepEqual(
  sanitizeEventProperties("business_search_performed", {
    hasQuery: true,
    query: "my secret startup idea",
    filters: ["q", "industry", "email", "industry"],
    resultCount: 3.5,
  }),
  { hasQuery: true, filters: ["industry", "q"] },
  "search text and unknown keys never survive; bad counts are dropped",
);
assert.deepEqual(sanitizeEventProperties("business_profile_opened", { slug: "Market Bridge!" }), {});
assert.deepEqual(sanitizeEventProperties("business_profile_opened", { slug: "market-bridge" }), { slug: "market-bridge" });
assert.deepEqual(
  sanitizeEventProperties("practice_started_from_business", { mode: "hack", withQuestion: "yes", transcript: "..." }),
  {},
);
assert.deepEqual(sanitizeEventProperties("discover_viewed", { anything: 1 }), {});
assert.deepEqual(sanitizeEventProperties("community_thread_started", ["growth"]), {});
assert.equal(isEventName("business_published"), true);
assert.equal(isEventName("toString"), false, "prototype keys are not event names");
assert.equal(isEventName("deck_uploaded"), false);

// ─── The browser may only report page views ──────────────────────────────────
const refused = recorder();
recordClientEvent({ body: { name: "business_published" } } as unknown as Request, refused);
assert.equal(refused.statusCode, 400, "action events can only be recorded by the server");
const accepted = recorder();
recordClientEvent({ body: { name: "discover_viewed" } } as unknown as Request, accepted);
assert.equal(accepted.statusCode, 202);
assert.ok(CLIENT_EVENTS.every((name) => isEventName(name)));

// ─── Writes ──────────────────────────────────────────────────────────────────
const mutableSupabase = supabase as any;
const originalFrom = mutableSupabase.from;
const originalRpc = mutableSupabase.rpc;

try {
  const inserted: any[] = [];
  mutableSupabase.from = (table: string) => {
    assert.equal(table, "product_events");
    return {
      insert: (row: any) => {
        inserted.push(row);
        return Promise.resolve({ error: null });
      },
    };
  };

  // With the test guard on, nothing is written.
  logEvent("business_followed", { userId: 7 });
  await flush();
  assert.equal(inserted.length, 0, "the test guard blocks all writes");

  process.env.PITCHNEST_ANALYTICS = "on";
  logEvent("business_profile_opened", {
    userId: 7.5 as any,
    businessId: "not-a-uuid",
    properties: { slug: "market-bridge", email: "a@b.c" },
  });
  await flush();
  assert.deepEqual(inserted.at(-1), {
    name: "business_profile_opened",
    user_id: null,
    business_id: null,
    properties: { slug: "market-bridge" },
  });

  // A search records which filters were used, never the text.
  mutableSupabase.rpc = async (name: string) => {
    assert.match(name, /^discover_public_businesses(_by_support)?$/);
    return { data: [], error: null };
  };
  const searched = recorder();
  await listPublicBusinesses({ query: { q: "  confidential plan  ", region: "Lagos" } } as unknown as Request, searched);
  await flush();
  const searchEvent = inserted.find((row) => row.name === "business_search_performed");
  assert.ok(searchEvent);
  assert.deepEqual(searchEvent.properties, { hasQuery: true, filters: ["q", "region"], resultCount: 0 });
  assert.equal(JSON.stringify(inserted).includes("confidential"), false);
  assert.equal(JSON.stringify(inserted).includes("Lagos"), false);

  // Plain browsing is not a search.
  const before = inserted.length;
  await listPublicBusinesses({ query: {} } as unknown as Request, recorder());
  await flush();
  assert.equal(inserted.length, before);

  // A failing insert never throws into the caller.
  mutableSupabase.from = () => ({ insert: () => Promise.reject(new Error("db down")) });
  assert.doesNotThrow(() => logEvent("discover_viewed"));
  mutableSupabase.from = () => {
    throw new Error("client broken");
  };
  assert.doesNotThrow(() => logEvent("discover_viewed"));
  await flush();
} finally {
  process.env.PITCHNEST_ANALYTICS = "off";
  mutableSupabase.from = originalFrom;
  mutableSupabase.rpc = originalRpc;
}

// ─── Staff summary ───────────────────────────────────────────────────────────
try {
  let requestedDays: unknown;
  mutableSupabase.rpc = async (name: string, args: any) => {
    assert.equal(name, "staff_event_summary");
    requestedDays = args.p_days;
    return { data: [{ name: "discover_viewed", total: "12", unique_users: "4", anonymous: "8", last_seen: "2026-10-15T10:00:00Z" }], error: null };
  };
  const summary = recorder();
  await getEventSummary({ query: { days: "9999" } } as unknown as Request, summary);
  assert.equal(requestedDays, 365);
  assert.deepEqual(summary.body.data.events[0], {
    name: "discover_viewed",
    total: 12,
    uniqueUsers: 4,
    anonymous: 8,
    lastSeen: "2026-10-15T10:00:00Z",
  });
} finally {
  mutableSupabase.rpc = originalRpc;
}

// ─── Migration matches the server allowlist ──────────────────────────────────
const migration = readFileSync(new URL("../../migrations/0025_product_events.sql", import.meta.url), "utf8");
// The newest migration that (re)defines the allowed names is authoritative.
const migrationsDir = new URL("../../migrations/", import.meta.url);
const latestDefinition = readdirSync(migrationsDir)
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort()
  .map((file) => readFileSync(new URL(file, migrationsDir), "utf8"))
  .filter((sql) => /CHECK \(name IN \(/.test(sql))
  .at(-1) ?? "";
const listed = [...(latestDefinition.match(/CHECK \(name IN \(([\s\S]*?)\)\)/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
assert.deepEqual([...listed].sort(), Object.keys(EVENT_RULES).sort(), "database and server event lists must match");
assert.match(migration, /ON DELETE SET NULL/, "deleting an account unlinks its events");
assert.match(migration, /pg_column_size\(properties\) <= 1024/);
assert.match(migration, /REVOKE ALL ON FUNCTION staff_event_summary\(INTEGER\) FROM PUBLIC, anon, authenticated;/);
assert.doesNotMatch(migration, /transcript TEXT|deck_text|email TEXT/i);

console.log("Analytics tests passed.");
process.exit(0);
