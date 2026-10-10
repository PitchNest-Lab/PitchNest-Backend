import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { FakeSupabase } from "./fakeSupabase.ts";
import { __setSupabaseForTests } from "../../config/supabase.ts";

/**
 * Boots the real Express app on an ephemeral port against a FakeSupabase.
 * The app is imported dynamically so config/env.ts sees the test environment.
 */
export async function startApp(db: FakeSupabase): Promise<{
  base: string;
  server: Server;
  close: () => Promise<void>;
}> {
  __setSupabaseForTests(db);
  const { default: app } = await import("../../app.ts");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: any;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
