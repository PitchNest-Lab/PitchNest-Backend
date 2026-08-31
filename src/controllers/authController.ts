import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { OAuth2Client } from "google-auth-library";
import { Resend } from "resend";
import { sendVerificationEmail } from "../utils/sendVerificationEmail.ts";
import { storagePathFromUrl } from "../utils/storagePath.ts";

const resend = new Resend(process.env.RESEND_API_KEY);

const BCRYPT_ROUNDS = 12;
const googleClient = new OAuth2Client(config.googleClientId);

// The only roles a user record may hold. Kept in one place so signup, the PATCH
// endpoint, and any future caller validate against the same source of truth.
const ALLOWED_ROLES = ["Founder", "Investor", "Advisor"] as const;
type Role = (typeof ALLOWED_ROLES)[number];
const isValidRole = (value: unknown): value is Role =>
  typeof value === "string" && (ALLOWED_ROLES as readonly string[]).includes(value);

const ALLOWED_SECTORS = [
  "Venture Capital",
  "Angel Investor",
  "Strategic Corporate",
] as const;

// ── Sign-in method lock ──────────────────────────────────────────────────────
// An account belongs to the method that created it (users.auth_provider:
// 'form' | 'google'). Rows created before the column exists hold NULL — the
// first successful sign-in after this change records and locks their method.
const GOOGLE_ONLY_ERROR =
  "This email is registered with Google Sign-In. Please continue with Google instead.";
const FORM_ONLY_ERROR =
  "This email was registered with a password. Please log in with your email and password instead.";

/** Best-effort: lock a legacy (NULL-provider) row to the method just used. */
function lockAuthProvider(userId: number, provider: "form" | "google") {
  supabase
    .from("users")
    .update({ auth_provider: provider })
    .eq("id", userId)
    .is("auth_provider", null)
    .then(({ error }) => {
      if (error)
        console.warn("auth_provider lock failed (non-fatal):", error.message);
    });
}

import { isTrialActive, FREE_TRIAL_DAYS } from "../services/entitlementService.ts";

export function toPublicUser(u: any) {
  const expiry = u?.plan_expires_at ? new Date(u.plan_expires_at) : null;
  const isPaidActive = (u?.plan === "pro" || u?.plan === "prep" || u?.plan === "founder") && (!expiry || expiry.getTime() > Date.now());
  const trial = isTrialActive(u?.trial_expires_at, u?.trial_status, u?.trial_started_at);

  // During trial or paid plan, the user has full access
  const effectivePlan = isPaidActive ? (u.plan as string) : (trial.active ? "pro" : "free");

  return {
    id: u?.id,
    name: u?.name,
    email: u?.email,
    role: u?.role,
    bio: u?.bio,
    avatarUrl: u?.avatar_url ?? null,
    settings: u?.settings ?? {},
    plan: effectivePlan,
    planExpiresAt: isPaidActive && expiry ? expiry.toISOString() : null,
    isTrial: trial.active,
    trialDaysRemaining: trial.daysRemaining,
    trialExpiresAt: u?.trial_expires_at ? new Date(u.trial_expires_at).toISOString() : new Date(Date.now() + FREE_TRIAL_DAYS * 86400000).toISOString(),
  };
}

export function sanitizeSettings(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  const s = input as Record<string, any>;

  if (s.notifications && typeof s.notifications === "object") {
    out.notifications = {
      pitchAlerts: !!s.notifications.pitchAlerts,
      weeklyReport: !!s.notifications.weeklyReport,
      investorInquiries: !!s.notifications.investorInquiries,
    };
  }
  if (s.aiToughness !== undefined) {
    const v = Number(s.aiToughness);
    if (!Number.isNaN(v)) out.aiToughness = Math.min(100, Math.max(0, Math.round(v)));
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
      .filter((t: unknown) => typeof t === "string" && (t as string).length <= 64)
      .slice(0, 50);
  }
  return out;
}

/**
 * Signs a JWT token for the given user. Sessions expire after 24 hours of
 * inactivity (the frontend slides the window via /auth/refresh while the user
 * is active); "Keep me logged in" extends the lifetime to 30 days.
 */
function signToken(
  user: { id: number; email: string },
  rememberMe = false,
): string {
  return jwt.sign(
    { id: user.id, email: user.email, rememberMe },
    config.jwtSecret,
    { expiresIn: rememberMe ? "30d" : "24h" },
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
      { id: user.id, email: user.email },
      user.rememberMe === true,
    ),
  });
};

export const signup = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Name, email, and password are required." });
    }

    if (name.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "Name must be at least 2 characters." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid email address." });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    const is_verified = existingUser?.isEmailVerified;

    // Uniform, non-enumerating response for every existing-account case
    // (already-verified OR exists-but-unverified). CRITICAL: we NEVER return a
    // session token here. The previous code handed back a valid JWT for an
    // existing *unverified* account without checking the password — anyone who
    // knew a target's email could obtain a working login for that account. The
    // response body is identical in both branches so it also does not reveal
    // whether the email is registered/verified (user enumeration).
    if (existingUser) {
      if (!is_verified) {
        // Auto-resend so a genuinely-stuck owner can still verify. Best-effort.
        sendVerificationEmail(existingUser.id, cleanEmail).catch((err) => {
          console.error("Failed to resend verification email on signup retry:", err);
        });
      }
      return res.status(200).json({
        requiresVerification: true,
        email: cleanEmail,
        message: "Check your email to verify your account.",
      });
    }
    // Hash password before storing
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = new Date();
    const trialEnd = new Date(now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

    let { data: newUser, error } = await supabase
      .from("users")
      .insert([
        {
          name,
          email: cleanEmail,
          password: hashedPassword,
          auth_provider: "form",
          trial_started_at: now.toISOString(),
          trial_expires_at: trialEnd.toISOString(),
          trial_status: "active",
        },
      ])
      .select()
      .single();

    // Rollout safety: if new columns haven't been added in Supabase yet, retry without them
    if (error && /column|schema/i.test(error.message || "")) {
      ({ data: newUser, error } = await supabase
        .from("users")
        .insert([{ name, email: cleanEmail, password: hashedPassword }])
        .select()
        .single());
    }

    if (error || !newUser)
      return res.status(500).json({ error: "Signup failed" });

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
    res.status(200).json({
      requiresVerification: true,
      email: cleanEmail,
      message: "Check your email to verify your account.",
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
};

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password) {
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

    if (error || !user) {
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
      return res.status(401).json({ error: GOOGLE_ONLY_ERROR });
    }

    // Compare hashed password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      // Increment failed attempts; lock after MAX_FAILED_LOGINS.
      const attempts = (user.failed_login_attempts || 0) + 1;
      const lockUpdate: Record<string, unknown> = {
        failed_login_attempts: attempts,
      };
      if (attempts >= MAX_FAILED_LOGINS) {
        lockUpdate.locked_until = new Date(
          Date.now() + LOCKOUT_DURATION_MS,
        ).toISOString();
      }
      // Best-effort update — don't block the response on this.
      supabase
        .from("users")
        .update(lockUpdate)
        .eq("id", user.id)
        .then(({ error: lockErr }) => {
          if (lockErr)
            console.warn("lockout update failed (non-fatal):", lockErr.message);
        });

      if (attempts >= MAX_FAILED_LOGINS) {
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
      supabase
        .from("users")
        .update({ failed_login_attempts: 0, locked_until: null })
        .eq("id", user.id)
        .then(({ error: resetErr }) => {
          if (resetErr)
            console.warn(
              "lockout reset failed (non-fatal):",
              resetErr.message,
            );
        });
    }

    // First successful password login on a legacy row locks it to 'form'.
    if (!user.auth_provider) lockAuthProvider(user.id, "form");

    const token = signToken(
      { id: user.id, email: user.email },
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

    const { data: existing } = await supabase
      .from("users")
      .select("settings")
      .eq("id", userId)
      .maybeSingle();

    const merged = { ...(existing?.settings || {}), ...clean };

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

    const { credential, rememberMe } = req.body;
    if (!credential || typeof credential !== "string") {
      return res.status(400).json({ error: "Missing Google credential." });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: config.googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: "Invalid Google credential." });
    }

    if (!payload?.email || payload.email_verified === false) {
      return res
        .status(401)
        .json({ error: "Google account email is unavailable or unverified." });
    }

    const email = payload.email.toLowerCase().trim();
    const name =
      payload.name || payload.given_name || email.split("@")[0] || "Founder";

    let { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .maybeSingle();

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
      const trialEnd = new Date(now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

      let { data: created, error } = await supabase
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

      // Rollout safety: retry without auth_provider if the column is missing.
      if (error && /column|schema/i.test(error.message || "")) {
        ({ data: created, error } = await supabase
          .from("users")
          .insert([
            {
              name,
              email,
              password: randomPassword,
              isEmailVerified: true,
              role: "Founder",
            },
          ])
          .select()
          .single());
      }

      if (error || !created) {
        console.error("Google signup insert failed:", error);
        return res.status(500).json({ error: "Could not create account." });
      }
      user = created;
    } else if (user.auth_provider === "form") {
      // Method lock: this email was registered with a password.
      return res.status(401).json({ error: FORM_ONLY_ERROR });
    } else if (!user.auth_provider) {
      // First Google sign-in on a legacy row locks it to 'google'.
      lockAuthProvider(user.id, "google");
    }

    const token = signToken(
      { id: user.id, email: user.email },
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
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });
    const cleanEmail = email.toLowerCase().trim();

    const { data: user } = await supabase
      .from("users")
      .select("id, email, auth_provider")
      .eq("email", cleanEmail)
      .maybeSingle();

    // Always return 200 with the SAME message to prevent email enumeration.
    if (!user)
      return res
        .status(200)
        .json({ message: "If an account with that email exists, a reset link has been sent." });

    // Google accounts have no usable password — a reset would set one that
    // still can't log in (method lock). Point the user at Google instead.
    if (user.auth_provider === "google") {
      return res.status(400).json({ error: GOOGLE_ONLY_ERROR });
    }

    // Generate a reset token and store it
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await supabase.from("password_resets").insert([
      {
        user_id: user.id,
        token: resetToken,
        expires_at: expiresAt,
        used: false,
      },
    ]);
    const baseUrl = (config.allowedOrigin || "http://localhost:5174").replace(
      /\/+$/,
      "",
    );
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

    if (!process.env.RESEND_API_KEY) {
      console.error(
        "❌ Password reset email not sent: RESEND_API_KEY missing.",
      );
      return res.status(500).json({ error: "Failed to send email." });
    }

    try {
      const { data, error } = await resend.emails.send({
        from: config.emailFrom,
        replyTo: config.emailReplyTo,
        to: email,
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
      });

      if (error) {
        throw new Error(error.message);
      }
    } catch (mailErr: any) {
      console.error(
        "❌ Password reset email send failed:",
        mailErr?.message || mailErr,
      );
      return res.status(500).json({ error: "Failed to send email." });
    }

    res.status(200).json({ message: "If an account with that email exists, a reset link has been sent." });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token } = req.query;

    if (!token) return res.status(400).json({ message: "Token required" });

    // 1. Find token in Supabase
    const { data: record, error } = await supabase
      .from("email_verification_tokens")
      .select("*")
      .eq("token", token)
      .single();

    if (error || !record) {
      // Token may have already been consumed (double-click). Check if the
      // user is already verified and return success so the UI isn't broken.
      return res.status(400).json({ message: "This link has already been used or is invalid. Please log in or request a new verification email." });
    }

    // 2. Check expiry
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ message: "Token expired" });
    }

    // 3. Check if already verified (idempotent for repeated clicks)
    const { data: existingUser } = await supabase
      .from("users")
      .select("id, email, name, onboardingCompleted, role, bio, isEmailVerified")
      .eq("id", record.user_id)
      .single();

    if (existingUser?.isEmailVerified) {
      // Already verified — clean up the token and return success.
      await supabase
        .from("email_verification_tokens")
        .delete()
        .eq("token", token);

      const JwtToken = signToken({ id: existingUser.id, email: existingUser.email });
      return res.json({
        user: toPublicUser(existingUser),
        token: JwtToken,
        message: "Email already verified",
        redirectTo: existingUser.onboardingCompleted ? "/dashboard" : "/onboarding",
      });
    }

    // 4. Mark user as verified
    await supabase
      .from("users")
      .update({ isEmailVerified: true })
      .eq("id", record.user_id);

    // 5. Delete token (one-time use)
    await supabase
      .from("email_verification_tokens")
      .delete()
      .eq("token", token);

    const JwtToken = signToken({ id: existingUser!.id, email: existingUser!.email });

    res.json({
      user: toPublicUser(existingUser),
      token: JwtToken,
      message: "Email verified successfully",
      redirectTo: existingUser!.onboardingCompleted ? "/dashboard" : "/onboarding",
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

    const { data: user } = await supabase
      .from("users")
      .select("id, email, name, onboardingCompleted, isEmailVerified")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (!user) return res.status(400).json({ message: GENERIC });

    // Already verified — there is nothing to verify, and NO valid code exists
    // (the token row is deleted on verification). CRITICAL: do NOT mint a
    // session token here. This endpoint trusts only the `email` in the body, so
    // issuing a JWT without a matching code would be account takeover — any
    // known verified email would yield a free session. Point the user at login.
    if (user.isEmailVerified) {
      await supabase.from("email_verification_tokens").delete().eq("user_id", user.id);
      return res.status(200).json({
        alreadyVerified: true,
        message: "Email already verified. Please log in.",
      });
    }

    const { data: record } = await supabase
      .from("email_verification_tokens")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    // No row, or a legacy row with no `code` column populated (pre-migration
    // link-only token) — cannot verify by code; the user must use the link.
    if (!record || !record.code) return res.status(400).json({ message: GENERIC });

    if (new Date(record.expires_at) < new Date()) {
      await supabase.from("email_verification_tokens").delete().eq("user_id", user.id);
      return res.status(400).json({ message: "Code expired. Please request a new one." });
    }

    if ((record.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
      // Burn the code so a locked-out attacker cannot keep guessing this window.
      await supabase.from("email_verification_tokens").delete().eq("user_id", user.id);
      return res.status(429).json({ message: "Too many incorrect attempts. Please request a new code." });
    }

    // Constant-time compare so timing can't leak the code digit by digit.
    const stored = Buffer.from(String(record.code));
    const given = Buffer.from(cleanCode);
    const match = stored.length === given.length && crypto.timingSafeEqual(stored, given);

    if (!match) {
      await supabase
        .from("email_verification_tokens")
        .update({ attempts: (record.attempts ?? 0) + 1 })
        .eq("user_id", user.id);
      return res.status(400).json({ message: GENERIC });
    }

    await supabase.from("users").update({ isEmailVerified: true }).eq("id", user.id);
    await supabase.from("email_verification_tokens").delete().eq("user_id", user.id);

    const token = signToken({ id: user.id, email: user.email });
    return res.json({
      user: toPublicUser(user),
      token,
      message: "Email verified successfully",
      redirectTo: user.onboardingCompleted ? "/dashboard" : "/onboarding",
    });
  } catch (error) {
    console.error("verifyEmailOtp error:", error);
    return res.status(500).json({ message: "Failed to verify code." });
  }
};

export const resendEmailVerification = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    // Normalize exactly as signup does (it stores email.toLowerCase().trim()).
    // Without this the lookup misses whenever the address carries any capital
    // letter — and the /verify screen forwards it AS TYPED — so this endpoint
    // returned "Verification email resent" while sending nothing at all.
    // maybeSingle() because zero rows is an expected outcome here, not an error.
    const cleanEmail = String(email || "").toLowerCase().trim();
    const { data: user } = await supabase
      .from("users")
      .select("id, isEmailVerified")
      .eq("email", cleanEmail)
      .maybeSingle();

    // Always return success — don't reveal whether the email exists or is
    // already verified. This prevents user enumeration via this endpoint.
    if (!user || user?.isEmailVerified) {
      return res.json({ message: "If an unverified account exists for that email, a verification link has been sent." });
    }

    // Don't block the response on email delivery
    sendVerificationEmail(user.id, cleanEmail).catch((err) => {
      console.error("Failed to resend verification email:", err);
    });

    res.json({ message: "Verification email resent" });
  } catch (error) {
    console.error("resend Email verification error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
};

/**
 * Permanently delete a user and associated data (App Store 5.1.1(v) / Google Play).
 */
async function purgeUserAccount(userId: number): Promise<void> {
  const { data: decks } = await supabase
    .from("decks")
    .select("file_url")
    .eq("user_id", userId);
  const { data: sessions } = await supabase
    .from("sessions")
    .select("video_url")
    .eq("user_id", userId);

  const { data: userRow } = await supabase
    .from("users")
    .select("avatar_url")
    .eq("id", userId)
    .maybeSingle();

  const mediaPaths = new Set<string>();
  for (const deck of decks || []) {
    const path = storagePathFromUrl(deck.file_url); // main media bucket
    if (path) mediaPaths.add(path);
  }
  for (const session of sessions || []) {
    const path = storagePathFromUrl(session.video_url); // main media bucket
    if (path) mediaPaths.add(path);
  }

  // Avatars live in a SEPARATE public bucket — extract with that bucket's marker
  // and remove from THAT bucket, never from the private media bucket.
  const avatarPath = storagePathFromUrl(userRow?.avatar_url, config.avatarBucket);
  const avatarPaths = avatarPath ? [avatarPath] : [];

  if (mediaPaths.size > 0) {
    const { error: storageError } = await supabase.storage
      .from(config.storageBucket)
      .remove([...mediaPaths]);
    if (storageError) {
      console.warn("⚠️ Media storage cleanup partial failure:", storageError.message);
    }
  }
  if (avatarPaths.length > 0) {
    const { error: avatarError } = await supabase.storage
      .from(config.avatarBucket)
      .remove(avatarPaths);
    if (avatarError) {
      console.warn("⚠️ Avatar storage cleanup partial failure:", avatarError.message);
    }
  }

  // Deck audits hang off decks but carry their OWN user_id and the full AI
  // report, so deleting decks alone can strand them. Collect the ids first —
  // after the decks row is gone there is no way to find them by deck_id.
  const { data: deckRows } = await supabase
    .from("decks")
    .select("id")
    .eq("user_id", userId);
  const deckIds = (deckRows || []).map((d: any) => d.id).filter(Boolean);

  // session_pdfs is keyed on session_id only — no user_id column — so it is
  // unreachable once the sessions rows are deleted. Same ordering problem.
  const { data: sessionRows } = await supabase
    .from("sessions")
    .select("id")
    .eq("user_id", userId);
  const sessionIds = (sessionRows || []).map((s: any) => s.id).filter(Boolean);

  /**
   * Every delete, in dependency order. Children first so a mid-sequence failure
   * can never orphan a row whose only route back to the user has already gone.
   *
   * Failures are COLLECTED, not swallowed. The previous version ignored every
   * error and still returned 200, so a user could be told their data was erased
   * while it was all still there — the worst possible outcome for a GDPR
   * erasure request.
   */
  const failures: string[] = [];
  const purge = async (
    table: string,
    apply: (q: any) => any,
  ): Promise<void> => {
    const { error } = await apply(supabase.from(table).delete());
    if (error) {
      console.error(`❌ Account deletion: failed to purge ${table} for user ${userId}:`, error.message);
      failures.push(table);
    }
  };

  if (deckIds.length) {
    await purge("deck_audits", (q: any) => q.in("deck_id", deckIds));
  }
  // Belt and braces: audits recorded against the user but not against a deck we
  // still know about (e.g. a deck row deleted earlier by hand).
  await purge("deck_audits", (q: any) => q.eq("user_id", userId));

  if (sessionIds.length) {
    await purge("session_pdfs", (q: any) => q.in("session_id", sessionIds));
  }

  await purge("email_verification_tokens", (q: any) => q.eq("user_id", userId));
  await purge("password_resets", (q: any) => q.eq("user_id", userId));
  await purge("sessions", (q: any) => q.eq("user_id", userId));
  await purge("decks", (q: any) => q.eq("user_id", userId));
  await purge("profiles", (q: any) => q.eq("user_id", userId));

  // session_starts and payments carry ON DELETE CASCADE (migrations 0008/0009),
  // so they go with the users row. Everything above does not.
  await purge("users", (q: any) => q.eq("id", userId));

  if (failures.length) {
    // Surfaced to the caller so the UI cannot claim a clean deletion. The user
    // row may still exist, which means they can retry.
    throw new Error(`ACCOUNT_DELETE_PARTIAL:${failures.join(",")}`);
  }
}

async function verifyUserPassword(
  userId: number,
  password: string,
): Promise<boolean> {
  const { data: user } = await supabase
    .from("users")
    .select("password")
    .eq("id", userId)
    .maybeSingle();
  if (!user?.password) return false;
  return bcrypt.compare(password, user.password);
}

/** DELETE /api/auth/account — authenticated in-app deletion */
export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { password } = req.body;
    if (!password) {
      return res
        .status(400)
        .json({ error: "Password is required to delete your account." });
    }

    const valid = await verifyUserPassword(userId, password);
    if (!valid) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    await purgeUserAccount(userId);
    res.status(200).json({ message: "Account deleted successfully." });
  } catch (error) {
    console.error("Delete account error:", error);
    res
      .status(500)
      .json({ error: "Failed to delete account. Please contact support." });
  }
};

/** POST /api/auth/delete-account — public web page (Google Play delete URL) */
export const deleteAccountByCredentials = async (
  req: Request,
  res: Response,
) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    const cleanEmail = email.toLowerCase().trim();

    const { data: user } = await supabase
      .from("users")
      .select("id, password")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    await purgeUserAccount(user.id);
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
    if (!token || !password)
      return res
        .status(400)
        .json({ error: "Token and new password are required." });
    if (password.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });

    const { data: resetRecord } = await supabase
      .from("password_resets")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .maybeSingle();

    if (!resetRecord)
      return res.status(400).json({ error: "Invalid or expired reset token." });
    if (new Date(resetRecord.expires_at) < new Date())
      return res.status(400).json({ error: "Reset token has expired." });

    const hashedPassword = await bcrypt.hash(password, 12);

    await supabase
      .from("users")
      .update({ password: hashedPassword })
      .eq("id", resetRecord.user_id);
    await supabase
      .from("password_resets")
      .update({ used: true })
      .eq("id", resetRecord.id);

    res.status(200).json({ message: "Password updated successfully." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password." });
  }
};
