import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { OAuth2Client } from "google-auth-library";
import { Resend } from "resend";
import { sendVerificationEmail } from "../utils/sendVerificationEmail.ts";
import { safeAvatarUrl, storagePathFromUrl } from "../utils/storagePath.ts";
import { uploadDir } from "../services/storageService.ts";
import fs from "fs";
import path from "path";
import {
  hashAuthToken,
  isEmailCode,
  isLongAuthToken,
  safeEqualText,
} from "../utils/authTokens.ts";
import { withTimeout } from "../utils/withTimeout.ts";
import { revokeUserSockets } from "../sockets/restSocket.ts";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  ACCESS_TOKEN_KIND,
} from "../utils/accessToken.ts";

const resend =
  config.resendApiKey && config.resendApiKey !== "re_xxxxxxxxx"
    ? new Resend(config.resendApiKey)
    : null;

const BCRYPT_ROUNDS = 12;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$.{53}$/;
const DUMMY_PASSWORD_HASH = "$2b$12$kFlQPn/NVygvSVn3YgGLfOEaKPwEO0Ls5BRjKBpQIZqO7aCSazdia";
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 72;
const REFERRAL_CODE_PATTERN = /^\d{1,18}$/;
const googleClient = new OAuth2Client(config.googleClientId);

async function enrollInOrganization(
  userId: number,
  referralCode?: string | null,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("enroll_user_in_organization", {
    p_user_id: userId,
    p_org_code: referralCode || null,
  });
  if (error) {
    console.error("Organization enrollment failed:", error.message);
    return null;
  }
  return typeof data === "string" && data ? data : null;
}

async function verifyGoogleCredential(credential: unknown): Promise<any | null> {
  if (
    !config.googleClientId ||
    typeof credential !== "string" ||
    !credential ||
    credential.length > 16_384
  ) {
    return null;
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified === false) return null;
    return payload;
  } catch {
    return null;
  }
}

// The only roles a user record may hold. Kept in one place so signup, the PATCH
// endpoint, and any future caller validate against the same source of truth.
const ALLOWED_ROLES = ["Founder", "Investor", "Advisor"] as const;
type Role = (typeof ALLOWED_ROLES)[number];
const isValidRole = (value: unknown): value is Role =>
  typeof value === "string" &&
  (ALLOWED_ROLES as readonly string[]).includes(value);

const ALLOWED_SECTORS = [
  "Venture Capital",
  "Angel Investor",
  "Strategic Corporate",
] as const;

// ── Sign-in method lock ──────────────────────────────────────────────────────
// An account belongs to the method that created it (users.auth_provider:
// 'form' | 'google'). Migration 0030 backfills all older password accounts to
// `form` and makes the column non-null, so no OAuth request can claim a legacy
// password account merely by presenting the same email address.

import {
  isTrialActive,
  FREE_TRIAL_DAYS,
} from "../services/entitlementService.ts";
import { isSupportedSttLocale } from "../utils/transcriptionLocales.ts";
import { stopRenewalsForDeletion } from "../services/subscriptionService.ts";

export function toPublicUser(u: any) {
  const expiry = u?.plan_expires_at ? new Date(u.plan_expires_at) : null;
  const isPaidActive =
    ["pro", "prep", "founder", "enterprise"].includes(u?.plan) &&
    (!expiry || expiry > new Date());
  const trial = isTrialActive(
    u?.trial_expires_at,
    u?.trial_status,
    u?.trial_started_at,
  );

  // During trial or paid plan, the user has full access
  const effectivePlan = isPaidActive
    ? (u.plan as string)
    : trial.active
      ? "pro"
      : "free";

  return {
    id: u?.id,
    name: u?.name,
    email: u?.email,
    role: u?.role,
    bio: u?.bio ?? "",
    avatarUrl: safeAvatarUrl(u?.avatar_url),
    onboardingCompleted: u?.onboardingCompleted === true,
    orgCode: u?.orgCode ?? null,
    accountType: "user" as const,
    authProvider: u?.auth_provider === "google" ? "google" : "form",
    plan: effectivePlan,
    planExpiresAt: isPaidActive && expiry ? expiry.toISOString() : null,
    isTrial: trial.active,
    trialDaysRemaining: trial.daysRemaining,
    trialExpiresAt: u?.trial_expires_at
      ? new Date(u.trial_expires_at).toISOString()
      : null,
    // The app-preferences bag (notification toggles, AI toughness, sector, the
    // chosen recognition locale). This was previously omitted from the payload
    // entirely, so every client silently reverted to hardcoded defaults on a
    // fresh login and a setting only LOOKED persistent for as long as that one
    // browser's localStorage survived. Always the owner's own bag: sanitizeSettings
    // is the sole writer, so the shape is bounded and nothing raw lands here.
    settings: u?.settings && typeof u.settings === "object" ? u.settings : {},
  };
}

/** Public login/session contract for the temporary organization credential. */
export function toPublicOrganization(org: any) {
  const expiry = org?.validity ? new Date(org.validity) : null;
  const isPaidActive =
    ["pro", "prep", "founder", "enterprise"].includes(org?.plan) &&
    (!expiry || expiry > new Date());
  const trial = isTrialActive(
    org?.trial_expires_at,
    org?.trial_status,
    org?.trial_started_at,
  );

  return {
    id: org?.id,
    name: org?.org_name ?? "Organization",
    email: org?.email,
    orgCode: org?.org_code != null ? String(org.org_code) : null,
    accountType: "organization" as const,
    plan: isPaidActive ? org.plan : trial.active ? "pro" : "free",
    planExpiresAt: isPaidActive && expiry ? expiry.toISOString() : null,
    isTrial: trial.active,
    trialDaysRemaining: trial.daysRemaining,
    trialExpiresAt: org?.trial_expires_at
      ? new Date(org.trial_expires_at).toISOString()
      : null,
  };
}

export function sanitizeSettings(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  const s = input as Record<string, any>;

  if (s.notifications && typeof s.notifications === "object") {
    out.notifications = {
      ...(typeof s.notifications.pitchAlerts === "boolean"
        ? { pitchAlerts: s.notifications.pitchAlerts }
        : {}),
      ...(typeof s.notifications.weeklyReport === "boolean"
        ? { weeklyReport: s.notifications.weeklyReport }
        : {}),
      ...(typeof s.notifications.investorInquiries === "boolean"
        ? { investorInquiries: s.notifications.investorInquiries }
        : {}),
      ...(typeof s.notifications.trialLifecycle === "boolean"
        ? { trialLifecycle: s.notifications.trialLifecycle }
        : {}),
      // Ecosystem in-app notifications (migration 0022 triggers read these).
      // Kept only when the client sends a boolean: a missing key means "on",
      // so an older client saving the other switches never silently opts out.
      ...(typeof s.notifications.businessActivity === "boolean"
        ? { businessActivity: s.notifications.businessActivity }
        : {}),
      ...(typeof s.notifications.followedUpdates === "boolean"
        ? { followedUpdates: s.notifications.followedUpdates }
        : {}),
      ...(typeof s.notifications.communityReplies === "boolean"
        ? { communityReplies: s.notifications.communityReplies }
        : {}),
      // Founder follows (migration 0029).
      ...(typeof s.notifications.followedFounders === "boolean"
        ? { followedFounders: s.notifications.followedFounders }
        : {}),
    };
  }
  if (s.aiToughness !== undefined) {
    const v = Number(s.aiToughness);
    if (!Number.isNaN(v))
      out.aiToughness = Math.min(100, Math.max(0, Math.round(v)));
  }
  if (
    typeof s.activeSector === "string" &&
    (ALLOWED_SECTORS as readonly string[]).includes(s.activeSector)
  ) {
    out.activeSector = s.activeSector;
  }
  // Page tours the user has completed/skipped — stored on the account so a
  // tour seen on one device never reappears on another. Short slug strings
  // only, capped so the column can't grow unbounded.
  if (Array.isArray(s.toursSeen)) {
    out.toursSeen = s.toursSeen
      .filter(
        (t: unknown) => typeof t === "string" && (t as string).length <= 64,
      )
      .slice(0, 50);
  }
  // Recognition language for live sessions. Allowlist-only: the value is handed
  // straight to the Azure Speech SDK when the recognizer is built, so an
  // arbitrary string here would be an invalid recognition config at the start of
  // every session. An unsupported value is DROPPED rather than coerced, so the
  // stored preference can only ever be something we can actually honour.
  if (isSupportedSttLocale(s.sttLocale)) {
    out.sttLocale = s.sttLocale;
  } else if (s.sttLocale === "auto") {
    // Back to automatic: the session infers the locale (inferSttLocale). Saved
    // as null because settings are merged, so omitting the key would keep the
    // old choice.
    out.sttLocale = null;
  }
  return out;
}

/**
 * Signs a JWT token for the given user. Sessions expire after 24 hours of
 * inactivity (the frontend slides the window via /auth/refresh while the user
 * is active); "Keep me logged in" extends the lifetime to 30 days.
 */
function signToken(
  user: {
    id: number;
    email: string;
    accountType?: "user" | "organization";
    orgCode?: string;
    authVersion?: number;
  },
  rememberMe = false,
): string {
  return jwt.sign(
    {
      kind: ACCESS_TOKEN_KIND,
      id: user.id,
      rememberMe,
      accountType: user.accountType ?? "user",
      authVersion: user.authVersion ?? 0,
      ...(user.orgCode ? { orgCode: user.orgCode } : {}),
    },
    config.jwtSecret,
    {
      algorithm: "HS256",
      audience: ACCESS_TOKEN_AUDIENCE,
      issuer: ACCESS_TOKEN_ISSUER,
      expiresIn: rememberMe ? "30d" : "24h",
    },
  );
}

/**
 * Re-issues a fresh token for an authenticated user so active sessions slide
 * instead of hard-expiring. Keeps the rememberMe lifetime of the original.
 */
export const refreshToken = (req: Request, res: Response) => {
  const user = req.user!;
  res.status(200).json({
    token: signToken(
      {
        id: user.id,
        email: user.email,
        accountType: user.accountType,
        orgCode: user.orgCode,
        authVersion: user.authVersion,
      },
      user.rememberMe === true,
    ),
  });
};

/** Invalidates every bearer token and live pitch connection for this user. */
export const logout = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const isOrganization = req.user!.accountType === "organization";
    const { error } = await supabase.rpc(
      isOrganization ? "revoke_organization_sessions" : "revoke_user_sessions",
      isOrganization ? { p_org_id: userId } : { p_user_id: userId },
    );
    if (error) throw error;
    if (!isOrganization) revokeUserSockets(userId, "Logged out");
    return res.status(204).send();
  } catch (error) {
    console.error("Logout failed:", error);
    return res.status(500).json({ error: "Could not log out securely. Please retry." });
  }
};

export const signup = async (req: Request, res: Response) => {
  try {
    const genericSignup = {
      requiresVerification: true,
      message: "If this address can be registered, check your email for the verification link.",
    };
    const { name, email, password, role, referralCode } = req.body;
    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !email.trim()
    ) {
      return res
        .status(400)
        .json({ error: "Name, email, and password are required." });
    }

    if (name.trim().length < 2 || name.trim().length > 120) {
      return res
        .status(400)
        .json({ error: "Name must be 2-120 characters." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.length > 254 || !emailRegex.test(email)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid email address." });
    }

    if (
      typeof password !== "string" ||
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      return res
        .status(400)
        .json({ error: `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.` });
    }
    if (role !== undefined && !isValidRole(role)) {
      return res.status(400).json({ error: "Please select a valid role." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanReferralCode =
      typeof referralCode === "string" ? referralCode.trim() : "";
    if (cleanReferralCode && !REFERRAL_CODE_PATTERN.test(cleanReferralCode)) {
      return res.status(400).json({ error: "That organization invitation is invalid." });
    }

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();
    if (existingUserError) {
      console.error("Signup user lookup failed:", existingUserError.message);
      return res.status(503).json({ error: "Signup is temporarily unavailable." });
    }

    const is_verified = existingUser?.isEmailVerified;

    if (existingUser) {
      if (!is_verified) {
        // Auto-resend so a genuinely-stuck owner can still verify. Best-effort.
        sendVerificationEmail(existingUser.id, cleanEmail).catch((err) => {
          console.error(
            "Failed to resend verification email on signup retry:",
            err,
          );
        });
        return res.status(200).json(genericSignup);
      }

      // If the account is already verified, provide honest and actionable feedback:
      // do not redirect them to /verify waiting for a phantom email that was never sent.
      return res.status(200).json(genericSignup);
    }
    // Hash password before storing
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = new Date();
    const trialEnd = new Date(
      now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000,
    );

    const newUserPayload = {
      name: name.trim(),
      email: cleanEmail,
      password: hashedPassword,
      role: role || "Founder",
      auth_provider: "form",
      trial_started_at: now.toISOString(),
      trial_expires_at: trialEnd.toISOString(),
      trial_status: "active",
      enrolled_at: null,
      ...(cleanReferralCode ? { pending_org_code: cleanReferralCode } : {}),
    };

    const { data: newUser, error } = await supabase
      .from("users")
      .insert([newUserPayload])
      .select()
      .single();

    if (error || !newUser) {
      console.error("Signup user insert failed:", error || "No user returned");
      const message =
        config.nodeEnv === "production"
          ? "Signup failed"
          : `Signup failed: ${error?.message || "database returned no user"}`;
      return res.status(500).json({ error: message });
    }

    // Send verification email; do NOT issue a session token. The account cannot
    // be used until its email is verified (authMiddleware + the WS both enforce
    // this), so returning a token here would be a usable session for an
    // unverified account — the takeover vector we are closing. The client routes
    // to the /verify screen on `requiresVerification`.
    sendVerificationEmail(newUser.id, cleanEmail).catch((err) => {
      console.error("Failed to send verification email:", err);
    });

    // 200 (not 201) to match the existing-account branch above: a different
    // status would let an attacker distinguish a new email from a registered
    // one, defeating the identical-body anti-enumeration measure.
    res.status(200).json(genericSignup);
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
};

const MAX_FAILED_LOGINS = 5;

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password ||
      email.length > 254 ||
      password.length > PASSWORD_MAX_LENGTH
    ) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (error) {
      console.error("Login user lookup failed:", error.message);
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(503).json({ error: "Login is temporarily unavailable." });
    }
    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // ── Per-account lockout ─────────────────────────────────────────────────
    // Check if account is currently locked (graceful if columns don't exist yet).
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minsLeft = Math.ceil(
        (new Date(user.locked_until).getTime() - Date.now()) / 60000,
      );
      return res.status(429).json({
        error: `Account temporarily locked. Try again in ${minsLeft} minute${minsLeft === 1 ? "" : "s"}.`,
      });
    }

    // Method lock: Google-created accounts can't sign in with a password.
    if (user.auth_provider === "google") {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Compare hashed password
    const isValidPassword =
      typeof user.password === "string" && BCRYPT_HASH_PATTERN.test(user.password)
        ? await bcrypt.compare(password, user.password)
        : await bcrypt.compare(password, DUMMY_PASSWORD_HASH).then(() => false);
    if (!isValidPassword) {
      const { data: failedState, error: failedError } = await supabase.rpc(
        "record_failed_login",
        { p_user_id: user.id },
      );
      if (failedError) {
        console.error("Failed-login counter could not be updated:", failedError.message);
        return res.status(503).json({ error: "Login is temporarily unavailable." });
      }
      const state = Array.isArray(failedState) ? failedState[0] : failedState;
      if ((state?.failed_attempts ?? 0) >= MAX_FAILED_LOGINS || state?.lock_expires_at) {
        return res.status(429).json({
          error: "Too many failed attempts. Account locked for 15 minutes.",
        });
      }
      return res.status(401).json({ error: "Invalid credentials." });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({ message: "Email not verified" });
    }

    // ── Successful login — reset lockout counters ───────────────────────────
    if (user.failed_login_attempts > 0 || user.locked_until) {
      const { error: resetErr } = await supabase
        .from("users")
        .update({ failed_login_attempts: 0, locked_until: null })
        .eq("id", user.id);
      if (resetErr) {
        console.error("Lockout reset failed:", resetErr.message);
        return res.status(503).json({ error: "Login is temporarily unavailable." });
      }
    }

    const token = signToken(
      { id: user.id, email: user.email, authVersion: user.auth_version ?? 0 },
      rememberMe === true,
    );

    res.status(200).json({
      user: toPublicUser(user),
      token,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

export const orgLogin = async (req: Request, res: Response) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password ||
      email.length > 254 ||
      password.length > PASSWORD_MAX_LENGTH
    ) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: user, error } = await supabase
      .from("Organizations")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();
    if (error || !user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(429).json({ error: "Too many failed attempts. Try again later." });
    }

    if (
      typeof user.password !== "string" ||
      !BCRYPT_HASH_PATTERN.test(user.password)
    ) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      const { data: failedState, error: failedError } = await supabase.rpc(
        "record_failed_org_login",
        { p_org_id: user.id },
      );
      if (failedError) {
        console.error("Organization lockout update failed:", failedError.message);
        return res.status(503).json({ error: "Login is temporarily unavailable." });
      }
      const state = Array.isArray(failedState) ? failedState[0] : failedState;
      if ((state?.failed_attempts ?? 0) >= MAX_FAILED_LOGINS || state?.lock_expires_at) {
        return res.status(429).json({ error: "Too many failed attempts. Try again later." });
      }
      return res.status(401).json({ error: "Invalid credentials." });
    }

    if (user.failed_login_attempts > 0 || user.locked_until) {
      const { error: resetErr } = await supabase
        .from("Organizations")
        .update({ failed_login_attempts: 0, locked_until: null })
        .eq("id", user.id);
      if (resetErr) {
        console.error("Organization lockout reset failed:", resetErr.message);
        return res.status(503).json({ error: "Login is temporarily unavailable." });
      }
    }

    if (user.org_code == null) {
      console.error(`Organization ${user.id} has no org_code and cannot sign in.`);
      return res.status(503).json({ error: "Organization account is not configured." });
    }

    const token = signToken(
      {
        id: user.id,
        email: user.email,
        accountType: "organization",
        orgCode: String(user.org_code),
        authVersion: user.auth_version ?? 0,
      },
      rememberMe === true,
    );

    res.status(200).json({
      user: toPublicOrganization(user),
      token,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

const MAX_BIO_LENGTH = 600;

/**
 * PATCH /api/auth/me — update the authenticated user's editable profile fields:
 * `name`, `bio`, and `role` (Founder | Investor | Advisor). All fields optional;
 * only the ones present in the body are updated. Email is intentionally NOT
 * editable here (it is the login identity and would require re-verification).
 * Returns the updated user.
 */
export const updateMe = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, bio, role } = req.body;

    const updates: Record<string, unknown> = {};

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 2) {
        return res
          .status(400)
          .json({ error: "Name must be at least 2 characters." });
      }
      updates.name = name.trim();
    }

    if (bio !== undefined) {
      if (typeof bio !== "string") {
        return res.status(400).json({ error: "Bio must be text." });
      }
      updates.bio = bio.slice(0, MAX_BIO_LENGTH);
    }

    if (role !== undefined) {
      if (!isValidRole(role)) {
        return res.status(400).json({
          error: "Invalid role. Must be one of: Founder, Investor, Advisor.",
        });
      }
      updates.role = role;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update." });
    }

    const { data: updated, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", userId)
      .select("*")
      .single();

    if (error || !updated) {
      return res.status(500).json({ error: "Failed to update profile." });
    }

    res.status(200).json({ user: toPublicUser(updated) });
  } catch (error) {
    console.error("updateMe error:", error);
    res.status(500).json({ error: "Failed to update profile." });
  }
};

// PATCH /api/auth/settings — persist whitelisted user preferences (needs migration 0003).
export const updateSettings = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const clean = sanitizeSettings(req.body?.settings);

    if (Object.keys(clean).length === 0) {
      return res.status(400).json({ error: "No valid settings to update." });
    }

    const { data: existing, error: readError } = await supabase
      .from("users")
      .select("settings")
      .eq("id", userId)
      .maybeSingle();

    if (readError || !existing) {
      console.error("Settings lookup failed:", readError?.message || "user not found");
      return res.status(readError ? 503 : 404).json({ error: "Failed to load settings." });
    }

    const merged = { ...(existing?.settings || {}), ...clean };
    if (clean.notifications && typeof clean.notifications === "object") {
      merged.notifications = {
        ...(existing.settings?.notifications || {}),
        ...(clean.notifications as Record<string, boolean>),
      };
    }

    // toursSeen is a set that only grows: union with what's already stored so
    // two devices can't clobber each other's completions.
    if (Array.isArray(clean.toursSeen)) {
      const prior = Array.isArray(existing?.settings?.toursSeen)
        ? existing!.settings.toursSeen
        : [];
      merged.toursSeen = Array.from(
        new Set([...prior, ...(clean.toursSeen as string[])]),
      ).slice(0, 50);
    }

    const { data: updated, error } = await supabase
      .from("users")
      .update({ settings: merged })
      .eq("id", userId)
      .select("settings")
      .single();

    if (error || !updated) {
      return res.status(500).json({ error: "Failed to save settings." });
    }

    res.status(200).json({ settings: updated.settings });
  } catch (error) {
    console.error("updateSettings error:", error);
    res.status(500).json({ error: "Failed to save settings." });
  }
};

/**
 * POST /api/auth/google — sign in / sign up with a Google ID token (credential)
 * obtained client-side via Google Identity Services. Verifies the token against
 * our OAuth client id, then finds-or-creates the matching user (linked by email)
 * and issues our own JWT. Google accounts have no password — a random hash is
 * stored to satisfy the column. Accounts are locked to the sign-in method that
 * created them (users.auth_provider): a form account is rejected here, and a
 * Google account is rejected by the password login/reset endpoints.
 */
export const googleAuth = async (req: Request, res: Response) => {
  try {
    if (!config.googleClientId) {
      return res
        .status(503)
        .json({ error: "Google sign-in is not configured on the server." });
    }

    const { credential, rememberMe, referralCode } = req.body;
    if (!credential || typeof credential !== "string" || credential.length > 16_384) {
      return res.status(400).json({ error: "Missing Google credential." });
    }
    const cleanReferralCode = typeof referralCode === "string" ? referralCode.trim() : "";
    if (cleanReferralCode && !REFERRAL_CODE_PATTERN.test(cleanReferralCode)) {
      return res.status(400).json({ error: "That organization invitation is invalid." });
    }

    const payload = await verifyGoogleCredential(credential);
    if (!payload) {
      return res.status(401).json({ error: "Invalid Google credential." });
    }

    if (!payload?.email || payload.email_verified === false) {
      return res
        .status(401)
        .json({ error: "Google account email is unavailable or unverified." });
    }

    const email = payload.email.toLowerCase().trim();
    const name = String(
      payload.name || payload.given_name || email.split("@")[0] || "Founder",
    ).trim().slice(0, 120) || "Founder";

    let { data: user, error: userLookupError } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .maybeSingle();
    if (userLookupError) {
      console.error("Google user lookup failed:", userLookupError.message);
      return res.status(503).json({ error: "Google sign-in is temporarily unavailable." });
    }

    if (!user) {
      // Random unusable password — Google is the auth method for this account.
      // Use minimal rounds (4) since this hash is never verified at login;
      // it only satisfies the NOT NULL column. BCRYPT_ROUNDS (12) added 2-5s
      // of CPU time on serverless for zero security benefit.
      const randomPassword = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        4,
      );
      const now = new Date();
      const trialEnd = new Date(
        now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000,
      );

      const { data: created, error } = await supabase
        .from("users")
        .insert([
          {
            name,
            email,
            password: randomPassword,
            isEmailVerified: true,
            role: "Founder",
            auth_provider: "google",
            trial_started_at: now.toISOString(),
            trial_expires_at: trialEnd.toISOString(),
            trial_status: "active",
          },
        ])
        .select()
        .single();

      if (error || !created) {
        console.error("Google signup insert failed:", error);
        return res.status(500).json({ error: "Could not create account." });
      }
      user = created;
    } else if (user.auth_provider === "form") {
      // Method lock: this email was registered with a password.
      return res.status(401).json({ error: "Google sign-in could not be completed." });
    }

    if (cleanReferralCode) {
      const enrolledCode = await enrollInOrganization(user.id, cleanReferralCode);
      if (enrolledCode) user = { ...user, orgCode: enrolledCode, enrolled_at: new Date().toISOString() };
    }

    const token = signToken(
      { id: user.id, email: user.email, authVersion: user.auth_version ?? 0 },
      rememberMe === true,
    );
    res.status(200).json({
      user: toPublicUser(user),
      token,
      // New (or not-yet-onboarded) Google users go through onboarding, exactly
      // like email users do after verifying. Returning users skip to dashboard.
      redirectTo: user.onboardingCompleted ? "/dashboard" : "/onboarding",
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ error: "Google sign-in failed." });
  }
};

// REQUIRED: Run this SQL in Supabase before using this endpoint:
// CREATE TABLE password_resets (
//   id SERIAL PRIMARY KEY,
//   user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
//   token TEXT NOT NULL UNIQUE,
//   expires_at TIMESTAMPTZ NOT NULL,
//   used BOOLEAN DEFAULT FALSE,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );

export const forgotPassword = async (req: Request, res: Response) => {
  const generic = {
    message: "If an account with that email exists, a reset link has been sent.",
  };
  try {
    const { email } = req.body;
    if (typeof email !== "string" || !email.trim() || email.length > 254) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: user, error: userLookupError } = await supabase
      .from("users")
      .select("id, email, auth_provider")
      .eq("email", cleanEmail)
      .maybeSingle();
    if (userLookupError) {
      console.error("Password reset account lookup failed:", userLookupError.message);
      return res.status(200).json(generic);
    }

    // Always return 200 with the SAME message to prevent email enumeration.
    if (!user) return res.status(200).json(generic);

    // Google accounts have no usable password — a reset would set one that
    // still can't log in (method lock). Point the user at Google instead.
    if (user.auth_provider === "google") {
      return res.status(200).json(generic);
    }

    // Generate a reset token and store it
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetDigest = hashAuthToken("password-reset", resetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    const { error: clearError } = await supabase
      .from("password_resets")
      .delete()
      .eq("user_id", user.id);
    if (clearError) throw clearError;

    const { error: resetInsertError } = await supabase.from("password_resets").insert([
      {
        user_id: user.id,
        token: resetDigest,
        expires_at: expiresAt,
        used: false,
      },
    ]);
    if (resetInsertError) throw resetInsertError;
    const baseUrl = config.clientUrl;
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

    if (!resend) {
      console.error(
        "❌ Password reset email not sent: RESEND_API_KEY is missing or still set to re_xxxxxxxxx.",
      );
      await supabase.from("password_resets").delete().eq("token", resetDigest);
      return res.status(200).json(generic);
    }

    // The response does not wait on the mail provider. This keeps account
    // existence from being observable through a several-second timing gap.
    res.status(200).json(generic);
    void withTimeout(resend.emails.send({
        from: config.emailFrom,
        replyTo: config.emailReplyTo,
        to: user.email,
        subject: "Reset your PitchNest password",
        html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
        <h2 style="color:#1a1a2e">Reset your password</h2>
        <p style="color:#6b7280">
          We received a request to reset your PitchNest password. Click the
          button below to choose a new one.
        </p>
        <a href="${resetLink}"
           style="display:inline-block;margin:24px 0;padding:14px 28px;
                  background:#3b82f6;color:#fff;border-radius:12px;
                  text-decoration:none;font-weight:700">
          Reset Password →
        </a>
        <p style="color:#9ca3af;font-size:12px">
          Link expires in 1 hour. If you didn't request this, you can safely
          ignore this email.
        </p>
      </div>
    `,
      }, {
        idempotencyKey: `password-reset/${user.id}/${resetDigest.slice(0, 32)}`,
      }), 15_000, "Password reset email request")
      .then(async ({ error }) => {
        if (!error) return;
        console.error("❌ Password reset email send failed:", error.message);
        await supabase.from("password_resets").delete().eq("token", resetDigest);
      })
      .catch(async (mailErr: any) => {
        console.error("❌ Password reset email send failed:", mailErr?.message || mailErr);
        await supabase.from("password_resets").delete().eq("token", resetDigest);
      });
    return;
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(200).json(generic);
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token } = req.query;

    if (!isLongAuthToken(token)) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }
    const tokenDigest = hashAuthToken("email-link", token);

    // 1. Find token in Supabase
    const { data: record, error } = await supabase
      .from("email_verification_tokens")
      .select("*")
      .eq("token", tokenDigest)
      .maybeSingle();

    if (error) {
      console.error("Email verification lookup failed:", error.message);
      return res.status(503).json({ message: "Verification is temporarily unavailable." });
    }
    if (!record) {
      // Token may have already been consumed (double-click). Check if the
      // user is already verified and return success so the UI isn't broken.
      return res.status(400).json({
        message:
          "This link has already been used or is invalid. Please log in or request a new verification email.",
      });
    }

    // 2. Check expiry
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ message: "Token expired" });
    }

    // 3. Check if already verified (idempotent for repeated clicks)
    const { data: existingUser, error: userReadError } = await supabase
      .from("users")
      .select(
        "id, email, name, onboardingCompleted, role, bio, isEmailVerified, auth_version, orgCode, pending_org_code",
      )
      .eq("id", record.user_id)
      .single();
    if (userReadError || !existingUser) throw userReadError || new Error("Verification user not found");

    if (existingUser?.isEmailVerified) {
      // Already verified — clean up the token and return success.
      await supabase
        .from("email_verification_tokens")
        .delete()
        .eq("id", record.id);
      return res.json({
        alreadyVerified: true,
        message: "Email already verified",
      });
    }

    // 4. Mark user as verified
    const { data: consumed, error: consumeError } = await supabase.rpc(
      "consume_email_verification",
      { p_token_id: record.id, p_user_id: record.user_id },
    );
    if (consumeError) throw consumeError;
    if (consumed !== true) {
      return res.status(400).json({ message: "Invalid or expired link." });
    }

    const enrolledCode = await enrollInOrganization(record.user_id);
    const verifiedUser = {
      ...existingUser!,
      isEmailVerified: true,
      ...(enrolledCode ? { orgCode: enrolledCode } : {}),
    };

    const JwtToken = signToken({
      id: verifiedUser.id,
      email: verifiedUser.email,
      authVersion: verifiedUser.auth_version ?? 0,
    });

    res.json({
      user: toPublicUser(verifiedUser),
      token: JwtToken,
      message: "Email verified successfully",
      redirectTo: verifiedUser.onboardingCompleted
        ? "/dashboard"
        : "/onboarding",
    });
  } catch (error) {
    console.error("Email verification error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
};

/**
 * POST /api/auth/verify-email-otp — verify a manually-entered 6-digit code.
 *
 * Unlike the emailed LINK (verifyEmail, which carries a long high-entropy
 * token), the 6-digit code is low entropy, so this path is hardened against
 * brute force:
 *   • SCOPED to one account — the code is only ever compared against the token
 *     row for the user identified by `email` (never a global lookup), so a guess
 *     can only ever attack that one account, not "any pending account".
 *   • ATTEMPT-LOCKED — a per-record counter invalidates the code after 5 wrong
 *     tries; the attacker must then trigger a resend (per-IP rate limited).
 *   • CONSTANT-TIME compare, one-time use (deleted on success), TTL-checked.
 * Responses are uniform ("Invalid or expired code.") so this cannot be used to
 * enumerate which emails are registered/verified.
 */
const MAX_OTP_ATTEMPTS = 5;

export const verifyEmailOtp = async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ message: "Email and code are required." });
    }
    const cleanEmail = String(email).toLowerCase().trim();
    const cleanCode = String(code).trim();
    const GENERIC = "Invalid or expired code.";
    if (!isEmailCode(cleanCode) || cleanEmail.length > 254) {
      return res.status(400).json({ message: GENERIC });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, name, onboardingCompleted, isEmailVerified, auth_version, orgCode, pending_org_code")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (userError) throw userError;
    if (!user) return res.status(400).json({ message: GENERIC });

    // Already verified — there is nothing to verify, and NO valid code exists
    // (the token row is deleted on verification). CRITICAL: do NOT mint a
    // session token here. This endpoint trusts only the `email` in the body, so
    // issuing a JWT without a matching code would be account takeover — any
    // known verified email would yield a free session. Point the user at login.
    if (user.isEmailVerified) {
      await supabase
        .from("email_verification_tokens")
        .delete()
        .eq("user_id", user.id);
      return res.status(200).json({
        alreadyVerified: true,
        message: "Email already verified. Please log in.",
      });
    }

    const { data: record, error: recordError } = await supabase
      .from("email_verification_tokens")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (recordError) throw recordError;

    // No row, or a legacy row with no `code` column populated (pre-migration
    // link-only token) — cannot verify by code; the user must use the link.
    if (!record || !record.code)
      return res.status(400).json({ message: GENERIC });

    if (new Date(record.expires_at) < new Date()) {
      await supabase
        .from("email_verification_tokens")
        .delete()
        .eq("user_id", user.id);
      return res
        .status(400)
        .json({ message: "Code expired. Please request a new one." });
    }

    if ((record.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
      // Burn the code so a locked-out attacker cannot keep guessing this window.
      await supabase
        .from("email_verification_tokens")
        .delete()
        .eq("user_id", user.id);
      return res.status(429).json({
        message: "Too many incorrect attempts. Please request a new code.",
      });
    }

    // Constant-time compare so timing can't leak the code digit by digit.
    const stored = String(record.code);
    const codeDigest = hashAuthToken("email-code", cleanCode);
    const match = safeEqualText(stored, codeDigest);

    if (!match) {
      const attempts = record.attempts ?? 0;
      const { data: bumped, error: bumpError } = await supabase
        .from("email_verification_tokens")
        .update({ attempts: attempts + 1 })
        .eq("id", record.id)
        .eq("attempts", attempts)
        .select("id")
        .maybeSingle();
      if (bumpError) throw bumpError;
      if (!bumped) {
        return res.status(429).json({ message: "Too many concurrent attempts. Please retry." });
      }
      return res.status(400).json({ message: GENERIC });
    }

    const { data: consumed, error: consumeError } = await supabase.rpc(
      "consume_email_verification",
      { p_token_id: record.id, p_user_id: user.id },
    );
    if (consumeError) throw consumeError;
    if (consumed !== true) {
      return res.status(400).json({ message: GENERIC });
    }

    const enrolledCode = await enrollInOrganization(user.id);
    const verifiedUser = {
      ...user,
      isEmailVerified: true,
      ...(enrolledCode ? { orgCode: enrolledCode } : {}),
    };

    const token = signToken({
      id: verifiedUser.id,
      email: verifiedUser.email,
      authVersion: verifiedUser.auth_version ?? 0,
    });
    return res.json({
      user: toPublicUser(verifiedUser),
      token,
      message: "Email verified successfully",
      redirectTo: verifiedUser.onboardingCompleted ? "/dashboard" : "/onboarding",
    });
  } catch (error) {
    console.error("verifyEmailOtp error:", error);
    return res.status(500).json({ message: "Failed to verify code." });
  }
};

export const resendEmailVerification = async (req: Request, res: Response) => {
  const generic = {
    message: "If an unverified account exists for that email, a verification link has been sent.",
  };
  try {
    const { email } = req.body;
    // Normalize exactly as signup does (it stores email.toLowerCase().trim()).
    // Without this the lookup misses whenever the address carries any capital
    // letter — and the /verify screen forwards it AS TYPED — so this endpoint
    // returned "Verification email resent" while sending nothing at all.
    // maybeSingle() because zero rows is an expected outcome here, not an error.
    const cleanEmail = String(email || "")
      .toLowerCase()
      .trim();
    const { data: user } = await supabase
      .from("users")
      .select("id, isEmailVerified")
      .eq("email", cleanEmail)
      .maybeSingle();

    // If no user exists, generic success to prevent enumeration
    if (!user) return res.json(generic);

    // If the account is already verified, give explicit feedback so the user knows to log in
    if (user.isEmailVerified) {
      return res.json(generic);
    }

    // Don't block the response on email delivery
    sendVerificationEmail(user.id, cleanEmail).catch((err) => {
      console.error("Failed to resend verification email:", err);
    });

    res.json(generic);
  } catch (error) {
    console.error("resend Email verification error:", error);
    res.json(generic);
  }
};

/**
 * Permanently delete a user and associated data.
 */
async function purgeUserAccount(userId: number): Promise<void> {
  // Stop renewals first. Once the user row is gone nothing could cancel them,
  // and Flutterwave would keep charging a card for an account that no longer
  // exists, so a failed cancel stops the deletion here, before anything is removed.
  await stopRenewalsForDeletion(userId);

  const loadOwnedRows = async (table: "decks" | "sessions", columns: string) => {
    const rows: any[] = [];
    for (let from = 0; from < 10_000; from += 500) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .eq("user_id", userId)
        .order("id", { ascending: true })
        .range(from, from + 499);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < 500) return rows;
    }
    throw new Error(`ACCOUNT_DELETE_TOO_MANY_${table.toUpperCase()}`);
  };

  let decks: any[];
  let sessions: any[];
  try {
    [decks, sessions] = await Promise.all([
      loadOwnedRows("decks", "id, file_url"),
      loadOwnedRows("sessions", "id, video_url"),
    ]);
  } catch (error) {
    console.error("Account deletion media discovery failed:", error);
    throw new Error("ACCOUNT_DELETE_DISCOVERY_FAILED");
  }

  const { data: userRow, error: userReadError } = await supabase
    .from("users")
    .select("avatar_url")
    .eq("id", userId)
    .maybeSingle();

  if (userReadError || !userRow) {
    throw new Error("ACCOUNT_DELETE_DISCOVERY_FAILED");
  }

  // A shared business survives a member's departure. A business with no other
  // active member is personal workspace data and must be removed with the
  // account, including both its private drafts and published image copies.
  const [membershipResult, createdBusinessResult] = await Promise.all([
    supabase
      .from("business_members")
      .select("business_id")
      .eq("user_id", userId)
      .neq("status", "removed"),
    supabase.from("businesses").select("id").eq("created_by", userId),
  ]);
  if (membershipResult.error || createdBusinessResult.error) {
    throw new Error("ACCOUNT_DELETE_BUSINESS_DISCOVERY_FAILED");
  }
  const relatedBusinessIds = [...new Set([
    ...(membershipResult.data ?? []).map((row: any) => String(row.business_id)),
    ...(createdBusinessResult.data ?? []).map((row: any) => String(row.id)),
  ].filter(Boolean))];
  if (relatedBusinessIds.length > 500) {
    throw new Error("ACCOUNT_DELETE_TOO_MANY_BUSINESSES");
  }
  let sharedBusinessIds = new Set<string>();
  if (relatedBusinessIds.length) {
    const { data: otherMembers, error: memberError } = await supabase
      .from("business_members")
      .select("business_id")
      .in("business_id", relatedBusinessIds)
      .neq("user_id", userId)
      .eq("status", "active");
    if (memberError) throw new Error("ACCOUNT_DELETE_BUSINESS_DISCOVERY_FAILED");
    sharedBusinessIds = new Set((otherMembers ?? []).map((row: any) => String(row.business_id)));
  }
  const soleBusinessIds = relatedBusinessIds.filter((id) => !sharedBusinessIds.has(id));

  const mediaPaths = new Set<string>();
  const publicMediaPaths = new Set<string>();
  const localPaths = new Set<string>();
  for (const deck of decks || []) {
    if (typeof deck.file_url === "string" && deck.file_url.startsWith("/uploads/")) {
      const name = deck.file_url.slice("/uploads/".length);
      if (name && name === path.basename(name)) localPaths.add(path.join(uploadDir, name));
      continue;
    }
    const objectPath = storagePathFromUrl(deck.file_url);
    if (objectPath?.startsWith("decks/") && !objectPath.includes("..")) {
      mediaPaths.add(objectPath);
    }
  }
  for (const session of sessions || []) {
    if (typeof session.video_url === "string" && session.video_url.startsWith("/uploads/")) {
      const name = session.video_url.slice("/uploads/".length);
      if (
        name.startsWith(`rec_${userId}_`) &&
        name === path.basename(name)
      ) localPaths.add(path.join(uploadDir, name));
      continue;
    }
    const objectPath = storagePathFromUrl(session.video_url);
    if (objectPath?.startsWith("pitches/") && !objectPath.includes("..")) {
      mediaPaths.add(objectPath);
    }
  }

  // Recordings are uploaded before the final session row is updated. A tab
  // closing in that small window leaves a legitimate but unreferenced object;
  // enumerate the user's scoped prefix so erasure catches those too.
  for (let offset = 0; offset < 10_000; offset += 100) {
    const { data: objects, error: listError } = await supabase.storage
      .from(config.storageBucket)
      .list(`pitches/${userId}`, { limit: 100, offset });
    if (listError) throw new Error(`ACCOUNT_DELETE_RECORDING_DISCOVERY_FAILED:${listError.message}`);
    for (const object of objects ?? []) {
      if (object.name) mediaPaths.add(`pitches/${userId}/${object.name}`);
    }
    if ((objects ?? []).length < 100) break;
    if (offset === 9_900) throw new Error("ACCOUNT_DELETE_TOO_MANY_RECORDINGS");
  }

  // New deck keys are scoped exactly like recordings. This also catches an
  // upload whose object was created but whose owning row was never committed.
  for (let offset = 0; offset < 10_000; offset += 100) {
    const { data: objects, error: listError } = await supabase.storage
      .from(config.storageBucket)
      .list(`decks/${userId}`, { limit: 100, offset });
    if (listError) throw new Error(`ACCOUNT_DELETE_DECK_DISCOVERY_FAILED:${listError.message}`);
    for (const object of objects ?? []) {
      if (object.name) mediaPaths.add(`decks/${userId}/${object.name}`);
    }
    if ((objects ?? []).length < 100) break;
    if (offset === 9_900) throw new Error("ACCOUNT_DELETE_TOO_MANY_DECK_OBJECTS");
  }

  const collectStoragePrefix = async (
    bucket: string,
    prefix: string,
    target: Set<string>,
  ) => {
    for (let offset = 0; offset < 1_000; offset += 100) {
      const { data: objects, error } = await supabase.storage
        .from(bucket)
        .list(prefix, { limit: 100, offset });
      if (error) throw new Error(`ACCOUNT_DELETE_BUSINESS_MEDIA_DISCOVERY_FAILED:${error.message}`);
      for (const object of objects ?? []) {
        if (object.name) target.add(`${prefix}/${object.name}`);
      }
      if ((objects ?? []).length < 100) return;
    }
    throw new Error("ACCOUNT_DELETE_TOO_MANY_BUSINESS_MEDIA_OBJECTS");
  };
  for (const businessId of soleBusinessIds) {
    const prefix = `business-media/${businessId}`;
    await Promise.all([
      collectStoragePrefix(config.storageBucket, prefix, mediaPaths),
      collectStoragePrefix(config.publicMediaBucket, prefix, publicMediaPaths),
    ]);
  }

  try {
    for (const name of await fs.promises.readdir(uploadDir)) {
      if (name.startsWith(`rec_${userId}_`) && name === path.basename(name)) {
        localPaths.add(path.join(uploadDir, name));
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  // Avatars live in a SEPARATE public bucket — extract with that bucket's marker
  // and remove from THAT bucket, never from the private media bucket.
  const avatarPath = storagePathFromUrl(
    userRow?.avatar_url,
    config.avatarBucket,
  );
  const avatarPaths = [...new Set([avatarPath, `avatars/${userId}/profile`].filter(Boolean) as string[])];

  if (mediaPaths.size > 0) {
    const paths = [...mediaPaths];
    for (let index = 0; index < paths.length; index += 100) {
      const { error: storageError } = await supabase.storage
        .from(config.storageBucket)
        .remove(paths.slice(index, index + 100));
      if (storageError) {
        throw new Error(`ACCOUNT_DELETE_MEDIA_FAILED:${storageError.message}`);
      }
    }
  }
  if (avatarPaths.length > 0) {
    const { error: avatarError } = await supabase.storage
      .from(config.avatarBucket)
      .remove(avatarPaths);
    if (avatarError) {
      throw new Error(`ACCOUNT_DELETE_AVATAR_FAILED:${avatarError.message}`);
    }
  }
  if (publicMediaPaths.size > 0) {
    const paths = [...publicMediaPaths];
    for (let index = 0; index < paths.length; index += 100) {
      const { error: publicMediaError } = await supabase.storage
        .from(config.publicMediaBucket)
        .remove(paths.slice(index, index + 100));
      if (publicMediaError) {
        throw new Error(`ACCOUNT_DELETE_PUBLIC_BUSINESS_MEDIA_FAILED:${publicMediaError.message}`);
      }
    }
  }

  for (const localPath of localPaths) {
    try {
      await fs.promises.rm(localPath, { force: true });
    } catch (error) {
      throw new Error(`ACCOUNT_DELETE_LOCAL_MEDIA_FAILED:${String(error)}`);
    }
  }

  // One DELETE statement gives the relational half transaction semantics: all
  // FK cascades, the orphan-business trigger, and the user row commit together
  // or PostgreSQL rolls the statement back. This avoids reporting success after
  // a sequence of partially completed child-table deletes.
  const { error: deleteError } = await supabase.from("users").delete().eq("id", userId);
  if (deleteError) throw new Error(`ACCOUNT_DELETE_DATABASE_FAILED:${deleteError.message}`);

  const { data: remainingUser, error: verifyDeleteError } = await supabase
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (verifyDeleteError || remainingUser) {
    throw new Error("ACCOUNT_DELETE_DATABASE_FAILED:users");
  }
}

async function verifyAccountDeletion(
  userId: number,
  password: unknown,
  googleCredential: unknown,
): Promise<boolean> {
  const { data: user, error } = await supabase
    .from("users")
    .select("email, password, auth_provider")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) return false;
  if (user.auth_provider === "google") {
    const payload = await verifyGoogleCredential(googleCredential);
    return payload?.email?.toLowerCase().trim() === user.email.toLowerCase().trim();
  }
  if (
    typeof password !== "string" ||
    !password ||
    password.length > PASSWORD_MAX_LENGTH ||
    !user.password
  ) return false;
  return bcrypt.compare(password, user.password);
}

/** DELETE /api/auth/account — authenticated in-app deletion */
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { password, googleCredential } = req.body;
    if (!password && !googleCredential) {
      return res
        .status(400)
        .json({ error: "Re-authentication is required to delete your account." });
    }

    const valid = await verifyAccountDeletion(userId, password, googleCredential);
    if (!valid) {
      return res.status(401).json({ error: "Account confirmation failed." });
    }

    await purgeUserAccount(userId);
    revokeUserSockets(userId, "Account deleted");
    res.status(200).json({ message: "Account deleted successfully." });
  } catch (error) {
    console.error("Delete account error:", error);
    res
      .status(500)
      .json({ error: "Failed to delete account. Please contact support." });
  }
};

/** POST /api/auth/delete-account — credential-confirmed request from the public deletion page. */
export const deleteAccountByCredentials = async (
  req: Request,
  res: Response,
) => {
  try {
    const { email, password, googleCredential } = req.body;
    if (typeof email !== "string" || !email.trim() || (!password && !googleCredential)) {
      return res
        .status(400)
        .json({ error: "Email and account confirmation are required." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const valid = await verifyAccountDeletion(user.id, password, googleCredential);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    await purgeUserAccount(user.id);
    revokeUserSockets(user.id, "Account deleted");
    res.status(200).json({ message: "Account deleted successfully." });
  } catch (error) {
    console.error("Delete account (public) error:", error);
    res
      .status(500)
      .json({ error: "Failed to delete account. Please contact support." });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!isLongAuthToken(token) || typeof password !== "string")
      return res
        .status(400)
        .json({ error: "Token and new password are required." });
    if (
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH ||
      Buffer.byteLength(password, "utf8") > 72
    )
      return res
        .status(400)
        .json({ error: `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.` });

    const { data: resetRecord, error: resetReadError } = await supabase
      .from("password_resets")
      .select("*")
      .eq("token", hashAuthToken("password-reset", token))
      .eq("used", false)
      .maybeSingle();

    if (resetReadError) throw resetReadError;

    if (!resetRecord)
      return res.status(400).json({ error: "Invalid or expired reset token." });
    if (new Date(resetRecord.expires_at) < new Date())
      return res.status(400).json({ error: "Reset token has expired." });

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { data: nextAuthVersion, error: consumeError } = await supabase.rpc(
      "consume_password_reset",
      {
        p_reset_id: resetRecord.id,
        p_user_id: resetRecord.user_id,
        p_password_hash: hashedPassword,
      },
    );
    if (consumeError) throw consumeError;
    if (!Number.isInteger(nextAuthVersion)) {
      return res.status(400).json({ error: "Invalid or expired reset token." });
    }
    revokeUserSockets(resetRecord.user_id, "Password changed");

    res.status(200).json({ message: "Password updated successfully." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password." });
  }
};
