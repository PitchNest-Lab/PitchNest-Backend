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
      user?: { id: number; email: string };
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
    const decoded = jwt.verify(token, config.jwtSecret) as { id: number; email: string };
    
    // Verify user still exists in the database
    const { data: user, error } = await supabase
      .from("users")
      .select("id")
      .eq("id", decoded.id)
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: "User no longer exists or access revoked. Please log in again." });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};
