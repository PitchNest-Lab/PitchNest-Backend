import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config/env.ts";

/**
 * Internal-only gate for admin endpoints (Item C: transcript review).
 *
 * This is deliberately NOT a user role. Regular founder accounts have no admin
 * capability and this middleware never consults the users table. Access is a
 * single shared secret supplied in the `x-admin-key` header and compared in
 * constant time against ADMIN_API_KEY.
 *
 * If ADMIN_API_KEY is unset (the default), the admin surface is disabled and
 * every request 404s — the same response as a wrong key, so the endpoint's
 * existence is never advertised to an unauthenticated caller.
 */
function timingSafeMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Compare fixed-length SHA-256 digests so lengths never leak via early return timing
  const hashA = crypto.createHash("sha256").update(Buffer.from(a, "utf8")).digest();
  const hashB = crypto.createHash("sha256").update(Buffer.from(b, "utf8")).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export const adminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const expected = config.adminApiKey;
  const provided = req.header("x-admin-key") || "";

  // Disabled (no key configured) or wrong key → 404, never revealing the route.
  if (!expected || !provided || !timingSafeMatch(provided, expected)) {
    return res.status(404).json({ error: "Not found" });
  }

  next();
};
