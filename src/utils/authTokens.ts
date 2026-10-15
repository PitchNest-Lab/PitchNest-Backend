import crypto from "node:crypto";
import { config } from "../config/env.ts";

export type AuthTokenPurpose = "email-link" | "email-code" | "password-reset";

/**
 * Store only a keyed digest of email/reset credentials. A database read leak
 * must not turn pending verification rows into working account credentials;
 * the raw value exists only in the email sent to the owner.
 */
export function hashAuthToken(purpose: AuthTokenPurpose, value: string): string {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(`pitchnest:${purpose}:v1\0${value}`, "utf8")
    .digest("hex");
}

export function isLongAuthToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function isEmailCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

export function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
