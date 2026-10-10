import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase.ts";
import {
  bearerToken,
  sameEmail,
  verifyOrgToken,
} from "../services/tokenService.ts";

/**
 * Gate for the organization dashboard (/api/organization/*).
 *
 * Accepts ONLY organization tokens (typ:"org", minted by orgLogin). Founder
 * tokens are refused, and so are legacy untyped tokens — the pre-fix org login
 * issued those without checking a password, so none of them can be trusted.
 *
 * The organization is re-read from the database on every request, so a
 * deleted organization or a changed contact email revokes access immediately.
 * The authorised org_code is attached as req.org and is the ONLY scope the
 * controllers use; a client-supplied orgId is at most cross-checked against it
 * (see resolveOrgScope).
 */

declare global {
  namespace Express {
    interface Request {
      org?: { id: number; orgCode: number; email: string };
    }
  }
}

export const orgAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: "Authentication required. Please log in." });
  }

  let claims;
  try {
    claims = verifyOrgToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }

  try {
    const { data: org, error } = await supabase
      .from("Organizations")
      .select("id, org_code, email")
      .eq("id", claims.orgId)
      .maybeSingle();

    if (
      error ||
      !org ||
      Number(org.org_code) !== claims.orgCode ||
      !sameEmail(org.email, claims.email)
    ) {
      return res.status(401).json({ error: "Organization access revoked. Please log in again." });
    }

    req.org = { id: Number(org.id), orgCode: Number(org.org_code), email: org.email };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};

/**
 * The organization scope for a request: always the authenticated org's code.
 *
 * The (unreleased) dashboard still posts an `orgId` in the body. It is tolerated
 * for compatibility but never trusted: if present it must equal the
 * authenticated org_code, otherwise the request is refused with 403. Returns
 * null after sending the 403.
 */
export function resolveOrgScope(req: Request, res: Response): number | null {
  const org = req.org;
  if (!org) {
    res.status(401).json({ error: "Authentication required. Please log in." });
    return null;
  }
  const claimed = req.body?.orgId ?? req.query?.orgId;
  if (claimed !== undefined && claimed !== null && claimed !== "") {
    if (String(claimed).trim() !== String(org.orgCode)) {
      res.status(403).json({ error: "You do not have access to that organization." });
      return null;
    }
  }
  return org.orgCode;
}
