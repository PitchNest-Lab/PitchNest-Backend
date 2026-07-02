import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { OAuth2Client } from "google-auth-library";
import { Resend } from "resend";
import { sendVerificationEmail } from "../utils/sendVerificationEmail.ts";

const resend = new Resend(process.env.RESEND_API_KEY);

const BCRYPT_ROUNDS = 12;
const googleClient = new OAuth2Client(config.googleClientId);

// The only roles a user record may hold. Kept in one place so signup, the PATCH
// endpoint, and any future caller validate against the same source of truth.
const ALLOWED_ROLES = ["Founder", "Investor", "Advisor"] as const;
type Role = (typeof ALLOWED_ROLES)[number];
const isValidRole = (value: unknown): value is Role =>
  typeof value === "string" && (ALLOWED_ROLES as readonly string[]).includes(value);

// Sectors the AI-preferences panel offers. Kept server-side so `settings` can't
// be populated with arbitrary values from the client.
const ALLOWED_SECTORS = [
  "Venture Capital",
  "Angel Investor",
  "Strategic Corporate",
] as const;

/**
 * Shape a raw `users` row into the safe object we return to the client. Never
 * includes the password hash. Maps the DB's snake_case `avatar_url` to the
 * `avatarUrl` the frontend expects, and always returns a `settings` object.
 */
export function toPublicUser(u: any) {
  return {
    id: u?.id,
    name: u?.name,
    email: u?.email,
    role: u?.role,
    bio: u?.bio,
    avatarUrl: u?.avatar_url ?? null,
    settings: u?.settings ?? {},
  };
}

/**
 * Whitelist + coerce user-supplied settings so only known keys with valid types
 * are ever persisted. Unknown keys are dropped.
 */
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
  return out;
}

/**
 * Signs a JWT token for the given user.
 */
function signToken(user: { id: number; email: string }): string {
  return jwt.sign({ id: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: "7d",
  });
}

export const wipeDb = async (req: Request, res: Response) => {
  try {
    await supabase.from("users").delete().neq("id", 0);
    await supabase.from("sessions").delete().neq("id", 0);
    await supabase.from("decks").delete().neq("id", 0);
    await supabase.from("profiles").delete().neq("id", 0);
    res.status(200).send("<h1>Database wiped</h1>");
  } catch (e) {
    res.status(500).json({ error: "Error wiping database." });
  }
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

    if (existingUser && is_verified)
      return res.status(400).json({ error: "Email exists" });
    if (existingUser && !is_verified) {
      // Auto-resend verification email so user isn't stuck
      sendVerificationEmail(existingUser.id, cleanEmail).catch((err) => {
        console.error("Failed to resend verification email on signup retry:", err);
      });

      const token = signToken({ id: existingUser.id, email: existingUser.email });
      return res
        .status(200)
        .json({
          user: { id: existingUser.id, name: existingUser.name, email: existingUser.email },
          token,
          message: "Verification email resent",
        });
    }
    // Hash password before storing
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { data: newUser, error } = await supabase
      .from("users")
      .insert([{ name, email: cleanEmail, password: hashedPassword }])
      .select()
      .single();

    if (error || !newUser)
      return res.status(500).json({ error: "Signup failed" });

    const token = signToken({ id: newUser.id, email: newUser.email });

    // Don't await — let it run in the background
    sendVerificationEmail(newUser.id, email).catch((err) => {
      console.error("Failed to send verification email:", err);
    });

    res.status(201).json({
      user: { id: newUser.id, name: newUser.name, email: newUser.email },
      token,
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
};


export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
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

    // Compare hashed password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    if (!user.isEmailVerified) {
      return res.status(403).json({ message: "Email not verified" });
    }

    const token = signToken({ id: user.id, email: user.email });

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

/**
 * PATCH /api/auth/settings — persist the authenticated user's app preferences
 * (notification toggles, AI "toughness", default sector). Values are whitelisted
 * server-side via {@link sanitizeSettings} and merged with any existing settings
 * so a partial update never drops unrelated keys. Requires the `settings` column
 * added in migration 0003.
 */
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
 * stored to satisfy the column; users can set one later via "forgot password".
 */
export const googleAuth = async (req: Request, res: Response) => {
  try {
    if (!config.googleClientId) {
      return res
        .status(503)
        .json({ error: "Google sign-in is not configured on the server." });
    }

    const { credential } = req.body;
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
      const randomPassword = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        BCRYPT_ROUNDS,
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
          },
        ])
        .select()
        .single();

      if (error || !created) {
        console.error("Google signup insert failed:", error);
        return res.status(500).json({ error: "Could not create account." });
      }
      user = created;
    }

    const token = signToken({ id: user.id, email: user.email });
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
      .select("id, email")
      .eq("email", cleanEmail)
      .maybeSingle();

    // Always return 200 to prevent email enumeration
    if (!user) return res.status(200).json({ message: "user does not exist" });

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

    res.status(200).json({ message: "a reset link has been sent." });
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
      return res.status(400).json({ message: "Invalid token" });
    }

    // 2. Check expiry
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ message: "Token expired" });
    }

    // 3. Mark user as verified
    await supabase
      .from("users")
      .update({ isEmailVerified: true })
      .eq("id", record.user_id);

    const { data: user } = await supabase
      .from("users")
      .select("id, email ,name ,onboardingCompleted, role, bio")
      .eq("id", record.user_id)
      .single();

    // 4. Delete token (one-time use)
    await supabase
      .from("email_verification_tokens")
      .delete()
      .eq("token", token);

    const JwtToken = signToken({ id: user?.id, email: user?.email });

    res.json({
      user: toPublicUser(user),
      token:JwtToken,
      message: "Email verified successfully",
      redirectTo: user?.onboardingCompleted ? "/dashboard" : "/onboarding",
    });
  } catch (error) {
    console.error("Email verfication  error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
};

export const resendEmailVerification = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const { data: user } = await supabase
      .from("users")
      .select("id, isEmailVerified")
      .eq("email", email)
      .single();

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user?.isEmailVerified)
      return res.status(400).json({ message: "Already verified" });

    // Don't block the response on email delivery
    sendVerificationEmail(user.id, email).catch((err) => {
      console.error("Failed to resend verification email:", err);
    });

    res.json({ message: "Verification email resent" });
  } catch (error) {
    console.error("resend Email verification error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
};

/** Extract Supabase storage object path from a public URL, e.g. decks/foo.pdf */
function storagePathFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const marker = `/${config.storageBucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length).split("?")[0] || null;
}

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

  // Best-effort avatar cleanup. The select is defensive: if the avatar_url column
  // isn't present yet (migration 0003 not applied), this simply yields nothing.
  const { data: userRow } = await supabase
    .from("users")
    .select("avatar_url")
    .eq("id", userId)
    .maybeSingle();

  const storagePaths = new Set<string>();
  for (const deck of decks || []) {
    const path = storagePathFromUrl(deck.file_url);
    if (path) storagePaths.add(path);
  }
  for (const session of sessions || []) {
    const path = storagePathFromUrl(session.video_url);
    if (path) storagePaths.add(path);
  }
  const avatarPath = storagePathFromUrl(userRow?.avatar_url);
  if (avatarPath) storagePaths.add(avatarPath);

  if (storagePaths.size > 0) {
    const { error: storageError } = await supabase.storage
      .from(config.storageBucket)
      .remove([...storagePaths]);
    if (storageError) {
      console.warn("⚠️ Storage cleanup partial failure:", storageError.message);
    }
  }

  await supabase.from("password_resets").delete().eq("user_id", userId);
  await supabase.from("sessions").delete().eq("user_id", userId);
  await supabase.from("decks").delete().eq("user_id", userId);
  await supabase.from("profiles").delete().eq("user_id", userId);
  await supabase.from("users").delete().eq("id", userId);
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
