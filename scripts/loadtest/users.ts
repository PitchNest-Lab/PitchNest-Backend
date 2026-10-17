// Creates and removes the throwaway accounts the live-room load test signs in
// as. Each simulated founder needs its own account: the server allows three
// live sockets per user and reserves a pitch attempt per connection.
//
// Accounts are verified, on a comped Pro plan that expires in two days, and
// have their trial marked cancelled so the trial-email job never mails them.
// They use a reserved .invalid domain, so no message can ever be delivered.
// Deleting them cascades to every session, PDF and founder-memory row the test
// wrote.
//
// Writes to the Supabase project in backend/.env — the same database the
// backend under test must be using.
//
// Usage (from backend/):
//   npx tsx scripts/loadtest/users.ts seed --count 20
//   npx tsx scripts/loadtest/users.ts cleanup
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

export const LOADTEST_EMAIL_DOMAIN = "pitchnest-loadtest.invalid";
export const USERS_FILE = path.resolve(import.meta.dirname, "out", "users.json");

export interface LoadTestUser {
  id: number;
  email: string;
  password: string;
  authVersion: number;
  /** Cached login token, filled in by liveRoom.ts --auth login. */
  token?: string;
}

function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function seed(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new Error("--count must be between 1 and 200");
  }
  const runId = crypto.randomBytes(3).toString("hex");
  const planExpiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const passwords: string[] = [];
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const password = crypto.randomBytes(18).toString("base64url");
    passwords.push(password);
    rows.push({
      name: `Load Test ${i}`,
      email: `loadtest-${runId}-${i}@${LOADTEST_EMAIL_DOMAIN}`,
      password: await bcrypt.hash(password, 10),
      isEmailVerified: true,
      onboardingCompleted: true,
      role: "Founder",
      auth_provider: "form",
      plan: "pro",
      plan_expires_at: planExpiresAt,
      trial_status: "cancelled",
    });
  }

  const { data, error } = await db().from("users").insert(rows).select("*");
  if (error) throw new Error(`Seeding failed: ${error.message}`);

  const existing = readUsers();
  const created: LoadTestUser[] = (data || []).map((row: any) => ({
    id: row.id,
    email: row.email,
    password: passwords[rows.findIndex((r) => r.email === row.email)],
    authVersion: Number(row.auth_version ?? 0),
  }));
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify([...existing, ...created], null, 2));
  console.log(`Created ${created.length} test accounts (run ${runId}); ${existing.length + created.length} in ${USERS_FILE}`);
}

async function cleanup() {
  const client = db();
  const { data: users, error } = await client
    .from("users")
    .select("id")
    .like("email", `%@${LOADTEST_EMAIL_DOMAIN}`);
  if (error) throw new Error(`Lookup failed: ${error.message}`);
  const ids = (users || []).map((u: any) => u.id);
  if (ids.length === 0) {
    console.log("No load-test accounts found.");
  } else {
    const { count: sessionCount } = await client
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .in("user_id", ids);
    const { error: deleteError } = await client.from("users").delete().in("id", ids);
    if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);
    const { count: left } = await client
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .in("user_id", ids);
    console.log(
      `Deleted ${ids.length} load-test accounts and ${sessionCount ?? 0} of their sessions` +
        (left ? ` — WARNING: ${left} sessions remain` : "."),
    );
  }
  if (fs.existsSync(USERS_FILE)) fs.rmSync(USERS_FILE);
}

export function readUsers(): LoadTestUser[] {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

// Run as a command only — liveRoom.ts imports readUsers/USERS_FILE from here.
if (path.basename(process.argv[1] || "") === "users.ts") {
  const [command, flag, value] = process.argv.slice(2);
  const run =
    command === "seed" ? seed(flag === "--count" ? Number(value) : 10)
    : command === "cleanup" ? cleanup()
    : Promise.reject(new Error("Usage: users.ts seed --count N | users.ts cleanup"));
  run.catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
