import jwt from "jsonwebtoken";
import { config } from "../config/env.ts";

/**
 * Every bearer token this backend mints, in one place.
 *
 * WHY THIS EXISTS. Founder tokens and organization tokens used to be the same
 * shape — `{ id, email }` — signed with the same secret. An organization
 * token carried `Organizations.id`, and every verifier resolved `id` against
 * `users`, so an org token authenticated as whichever founder happened to share
 * that numeric id. Tokens now carry an explicit principal type (`typ`) and each
 * verifier accepts exactly one type.
 *
 * Compatibility: founder tokens issued before `typ` existed have no `typ`
 * claim. They are still accepted by verifyUserToken — logging every founder out
 * is not acceptable — but legacy ORG tokens have the same untyped shape, so the
 * caller MUST additionally bind the token's `email` to the `users` row it
 * resolves (see authMiddleware). An org token's email is the organization's
 * address, which does not match the colliding founder's row, so it is refused.
 *
 * Signing algorithm and secret are unchanged (HS256, JWT_SECRET), so tokens
 * stay valid across Render, Lambda and the Live Pitch socket.
 */

const ALGORITHMS: jwt.Algorithm[] = ["HS256"];

export type PrincipalType = "user" | "org";

export interface UserTokenClaims {
  id: number;
  email: string;
  rememberMe?: boolean;
  /** Absent on legacy (pre-typ) founder tokens. */
  typ?: "user";
}

export interface OrgTokenClaims {
  typ: "org";
  /** Organizations.id */
  orgId: number;
  /** Organizations.org_code — the key members and analytics are scoped by. */
  orgCode: number;
  email: string;
  rememberMe?: boolean;
}

export class TokenError extends Error {
  constructor(public reason: "invalid" | "wrong_principal") {
    super(reason);
    this.name = "TokenError";
  }
}

function lifetime(rememberMe: boolean): jwt.SignOptions["expiresIn"] {
  // Sessions expire after 24h of inactivity (the frontend slides the window via
  // /auth/refresh); "Keep me logged in" extends the lifetime to 30 days.
  return rememberMe ? "30d" : "24h";
}

export function signUserToken(
  user: { id: number; email: string },
  rememberMe = false,
): string {
  return jwt.sign(
    { typ: "user", id: user.id, email: user.email, rememberMe },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: lifetime(rememberMe) },
  );
}

export function signOrgToken(
  org: { id: number; orgCode: number; email: string },
  rememberMe = false,
): string {
  return jwt.sign(
    {
      typ: "org",
      orgId: org.id,
      orgCode: org.orgCode,
      email: org.email,
      rememberMe,
    },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: lifetime(rememberMe) },
  );
}

function decode(token: unknown): Record<string, unknown> {
  if (typeof token !== "string" || !token) throw new TokenError("invalid");
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ALGORITHMS });
    if (!decoded || typeof decoded !== "object") throw new TokenError("invalid");
    return decoded as Record<string, unknown>;
  } catch (err) {
    if (err instanceof TokenError) throw err;
    throw new TokenError("invalid");
  }
}

/**
 * Accepts founder tokens only. Rejects org tokens, local-file tokens and resume
 * grants even though they share the signing secret.
 */
export function verifyUserToken(token: unknown): UserTokenClaims {
  const claims = decode(token);
  if (claims.typ !== undefined && claims.typ !== "user") {
    throw new TokenError("wrong_principal");
  }
  const id = claims.id;
  const email = claims.email;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new TokenError("invalid");
  }
  if (typeof email !== "string" || !email) throw new TokenError("invalid");
  return {
    id,
    email,
    rememberMe: claims.rememberMe === true,
    ...(claims.typ === "user" ? { typ: "user" as const } : {}),
  };
}

/** Accepts organization tokens only (must carry typ:"org"). */
export function verifyOrgToken(token: unknown): OrgTokenClaims {
  const claims = decode(token);
  if (claims.typ !== "org") throw new TokenError("wrong_principal");
  const { orgId, orgCode, email } = claims;
  if (typeof orgId !== "number" || !Number.isInteger(orgId) || orgId <= 0) {
    throw new TokenError("invalid");
  }
  if (typeof orgCode !== "number" || !Number.isFinite(orgCode)) {
    throw new TokenError("invalid");
  }
  if (typeof email !== "string" || !email) throw new TokenError("invalid");
  return { typ: "org", orgId, orgCode, email, rememberMe: claims.rememberMe === true };
}

/** Case-insensitive, whitespace-tolerant email equality for token binding. */
export function sameEmail(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}
