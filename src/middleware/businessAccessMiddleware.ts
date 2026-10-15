import type { NextFunction, Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

export const BUSINESS_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export interface BusinessMembership {
  businessId: string;
  userId: number;
  role: BusinessRole;
  publicDisplayConsent: boolean;
}

declare global {
  namespace Express {
    interface Request {
      businessMembership?: BusinessMembership;
    }
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Re-check active membership from the database on every business request. */
export async function requireBusinessMembership(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const businessId = String(req.params.id || "").trim();
  if (!UUID_PATTERN.test(businessId)) {
    return res.status(400).json({ error: "Invalid business id." });
  }

  const userId = req.user!.id;
  try {
    const { data: membership, error } = await supabase
      .from("business_members")
      .select("business_id, user_id, role, public_display_consent")
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (error) {
      console.error("Business membership lookup failed:", error);
      return res.status(500).json({ error: "Unable to verify business access." });
    }

    if (!membership || !BUSINESS_ROLES.includes(membership.role as BusinessRole)) {
      // Use 404 so private business existence is not disclosed to non-members.
      return res.status(404).json({ error: "Business not found." });
    }

    req.businessMembership = {
      businessId,
      userId,
      role: membership.role as BusinessRole,
      publicDisplayConsent: membership.public_display_consent === true,
    };
    return next();
  } catch (error) {
    console.error("Business membership lookup threw:", error);
    return res.status(500).json({ error: "Unable to verify business access." });
  }
}

export const requireBusinessRole = (...allowedRoles: BusinessRole[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.businessMembership) {
      return res.status(401).json({ error: "Business membership required." });
    }
    if (!allowedRoles.includes(req.businessMembership.role)) {
      return res.status(403).json({ error: "Insufficient business permissions." });
    }
    return next();
  };
