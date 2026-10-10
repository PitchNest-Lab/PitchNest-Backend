import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase.ts";
import {
  bearerToken,
  sameEmail,
  verifyUserToken,
} from "../services/tokenService.ts";

/**
 * Express middleware that validates FOUNDER tokens on protected routes.
 * Extracts the token from the Authorization header (Bearer <token>),
 * verifies it, checks if the user still exists, and attaches the decoded user payload to req.user.
 *
 * Organization tokens are rejected here (see tokenService). Legacy untyped
 * tokens are accepted only when their email matches the resolved users row,
 * which is what stops a pre-fix organization token — same untyped shape,
 * carrying Organizations.id — from authenticating as the founder who shares
 * that numeric id.
 */

// Extend Express Request type to include user payload
declare global {
  namespace Express {
    interface Request {
      user?: { id: number; email: string; rememberMe?: boolean };
    }
  }
}

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const token = bearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: "Authentication required. Please log in." });
  }

  let decoded;
  try {
    decoded = verifyUserToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }

  try {
    // Verify user still exists in the database, and pull their verification
    // state in the same round trip.
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, isEmailVerified")
      .eq("id", decoded.id)
      .maybeSingle();

    if (error || !user || !sameEmail(user.email, decoded.email)) {
      return res.status(401).json({ error: "User no longer exists or access revoked. Please log in again." });
    }

    // Email must be verified before any authenticated route works. Uses the
    // SAME falsy check as the login gate (authController.login), so a token can
    // only reach a protected route if its account is verified — and any account
    // that can log in can also use its token here. Unverified accounts never get
    // a token now (signup no longer issues one), so this is the backstop that
    // also rejects any stale pre-fix token still sitting in a browser.
    if (!user.isEmailVerified) {
      return res.status(403).json({
        error: "Please verify your email to continue.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    req.user = { id: decoded.id, email: decoded.email, rememberMe: decoded.rememberMe };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};
