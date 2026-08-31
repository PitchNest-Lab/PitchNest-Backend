import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";

/**
 * Express middleware that validates JWT tokens on protected routes.
 * Extracts the token from the Authorization header (Bearer <token>),
 * verifies it, checks if the user still exists, and attaches the decoded user payload to req.user.
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
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required. Please log in." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as { id: number; email: string; rememberMe?: boolean };
    
    // Verify user still exists in the database, and pull their verification
    // state in the same round trip.
    const { data: user, error } = await supabase
      .from("users")
      .select("id, isEmailVerified")
      .eq("id", decoded.id)
      .maybeSingle();

    if (error || !user) {
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

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};
