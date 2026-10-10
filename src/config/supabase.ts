import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./env.ts";

// `let` + live ESM binding so tests can substitute an in-memory fake without a
// network. Every importer sees the replacement because ES modules export
// bindings, not values.
export let supabase: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
);

/** Test-only: swap the client. Refuses outside NODE_ENV=test. */
export function __setSupabaseForTests(client: unknown): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setSupabaseForTests is only available when NODE_ENV=test");
  }
  supabase = client as SupabaseClient;
}
