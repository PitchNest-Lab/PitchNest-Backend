import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase.ts";
import { verifyAccessToken } from "../utils/accessToken.ts";

export type AccountType = "user" | "organization";
export type OrganizationRole = "owner" | "admin" | "facilitator" | "member";

export interface AuthenticatedIdentity {
  id: number;
  email: string;
  rememberMe?: boolean;
  authVersion?: number;
  accountType: AccountType;
  orgCode?: string;
}

export interface AuthenticatedOrganization {
  id: number;
  email: string;
  orgCode: string;
  role: OrganizationRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedIdentity;
      organization?: AuthenticatedOrganization;
    }
  }
}

type RequiredAccountType = AccountType | "any";

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function createAuthMiddleware(requiredType: RequiredAccountType) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Authentication required. Please log in." });
    }

    try {
      const decoded = verifyAccessToken(token);
      const accountType: AccountType =
        decoded.accountType === "organization" ? "organization" : "user";

      if (
        !Number.isInteger(decoded.id) ||
        (requiredType !== "any" && accountType !== requiredType)
      ) {
        return res.status(403).json({ error: "This account cannot access that resource." });
      }

      if (accountType === "organization") {
        const { data: organization, error } = await supabase
          .from("Organizations")
          .select("id, email, org_code, auth_version")
          .eq("id", decoded.id)
          .maybeSingle();

        if (error || !organization || organization.org_code == null) {
          return res.status(401).json({
            error: "Organization access was revoked. Please log in again.",
          });
        }

        const tokenAuthVersion = Number.isInteger(decoded.authVersion)
          ? Number(decoded.authVersion)
          : 0;
        if ((organization.auth_version ?? 0) !== tokenAuthVersion) {
          return res.status(401).json({
            error: "This session was revoked. Please log in again.",
          });
        }

        const identity: AuthenticatedIdentity = {
          id: organization.id,
          email: organization.email,
          rememberMe: decoded.rememberMe === true,
          authVersion: organization.auth_version ?? 0,
          accountType: "organization",
          orgCode: String(organization.org_code),
        };
        req.user = identity;
        // The legacy organization credential represents the organization owner.
        // Phase 7 will replace this with normal user accounts plus memberships.
        req.organization = {
          id: organization.id,
          email: organization.email,
          orgCode: String(organization.org_code),
          role: "owner",
        };
        return next();
      }

      const { data: user, error } = await supabase
        .from("users")
        .select("id, email, isEmailVerified, auth_version")
        .eq("id", decoded.id)
        .maybeSingle();

      if (error || !user) {
        return res.status(401).json({
          error: "User no longer exists or access was revoked. Please log in again.",
        });
      }

      if (!user.isEmailVerified) {
        return res.status(403).json({
          error: "Please verify your email to continue.",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      const tokenAuthVersion = Number.isInteger(decoded.authVersion)
        ? Number(decoded.authVersion)
        : 0;
      if ((user.auth_version ?? 0) !== tokenAuthVersion) {
        return res.status(401).json({
          error: "This session was revoked. Please log in again.",
        });
      }

      req.user = {
        id: user.id,
        email: user.email,
        rememberMe: decoded.rememberMe === true,
        authVersion: user.auth_version ?? 0,
        accountType: "user",
      };
      return next();
    } catch {
      return res.status(401).json({
        error: "Invalid or expired token. Please log in again.",
      });
    }
  };
}

/** Normal founder/investor/advisor endpoints. Organization tokens are rejected. */
export const authMiddleware = createAuthMiddleware("user");

/**
 * For public reads that personalise when a signed-in user is present (for
 * example "you support this business"). A missing, invalid, expired,
 * organization or unverified token is treated as anonymous — this middleware
 * never rejects a request, so it can sit in front of cacheable public routes.
 */
export async function optionalUserAuth(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) return next();
  try {
    const decoded = verifyAccessToken(token);
    if (decoded.accountType === "organization" || !Number.isInteger(decoded.id)) {
      return next();
    }
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, isEmailVerified, auth_version")
      .eq("id", decoded.id)
      .maybeSingle();
    const tokenAuthVersion = Number.isInteger(decoded.authVersion)
      ? Number(decoded.authVersion)
      : 0;
    if (
      !error &&
      user &&
      user.isEmailVerified &&
      (user.auth_version ?? 0) === tokenAuthVersion
    ) {
      req.user = {
        id: user.id,
        email: user.email,
        rememberMe: decoded.rememberMe === true,
        authVersion: user.auth_version ?? 0,
        accountType: "user",
      };
    }
  } catch {
    // Anonymous on any token problem.
  }
  return next();
}

/**
 * Staff-only moderation routes. Must run after authMiddleware. Re-reads
 * users.is_staff on every request so revoking the flag takes effect at once.
 * Non-staff callers get 404 so the moderation surface is not discoverable.
 */
export async function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.accountType !== "user") {
    return res.status(404).json({ error: "Not found." });
  }
  try {
    const { data, error } = await supabase
      .from("users")
      .select("is_staff")
      .eq("id", req.user.id)
      .maybeSingle();
    if (error) {
      console.error("Staff check failed:", error.message);
      return res.status(404).json({ error: "Not found." });
    }
    if ((data as { is_staff?: boolean } | null)?.is_staff !== true) {
      return res.status(404).json({ error: "Not found." });
    }
    return next();
  } catch (error) {
    console.error("Staff check threw:", error);
    return res.status(404).json({ error: "Not found." });
  }
}

/** Login-session endpoints such as /auth/me and /auth/refresh. */
export const accountAuthMiddleware = createAuthMiddleware("any");

/** Legacy organization dashboard endpoints. Normal user tokens are rejected. */
export const organizationAuthMiddleware = createAuthMiddleware("organization");

/**
 * Role gate for organization routes. The current legacy credential is assigned
 * the owner role; the same middleware can accept membership roles once the
 * organization_members model replaces shared organization credentials.
 */
export const requireOrgRole = (...allowedRoles: OrganizationRole[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.organization) {
      return res.status(401).json({ error: "Organization authentication required." });
    }
    if (!allowedRoles.includes(req.organization.role)) {
      return res.status(403).json({ error: "Insufficient organization permissions." });
    }
    return next();
  };
