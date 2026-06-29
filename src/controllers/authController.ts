import { Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { Resend } from "resend";
import { sendVerificationEmail } from "../utils/sendVerificationEmail.ts";

const BCRYPT_ROUNDS = 12;
const resend = new Resend(`${process.env.RESEND_API_KEY}`);

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
    if (existingUser && !is_verified)
      return res
        .status(409)
        .json({ message: "Email already registered but not verified" });
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

    // The account already exists at this point — a mail failure must not turn a
    // successful signup into a 500. Log the real reason and let the user fall
    // through to the "resend verification" screen instead.
    let emailSent = true;
    try {
      await sendVerificationEmail(newUser.id, email);
    } catch (mailErr) {
      emailSent = false;
      console.error("⚠️ Signup succeeded but verification email failed:", mailErr);
    }

    res.status(201).json({
      user: { id: newUser.id, name: newUser.name, email: newUser.email },
      token,
      emailSent,
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
      user: { id: user.id, name: user.name, email: user.email },
      token,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
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
    const resetLink = `${config.allowedOrigin}/reset-password?token=${resetToken}`;
    console.log(email);
    const { data, error } = await resend.emails.send({
      from: "pitchnestapp@gmail.com",
      to: email,
      subject: "Reset Your Password",
      html: `
    <h2>Password Reset Request</h2>
    <p>We received a request to reset your password.</p>
    <p>
      <a href="${resetLink}">
        Reset Password
      </a>
    </p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `,
    });
    if (error) {
      console.error("Resend error:", error); // ← this will tell you exactly what's wrong
      return res.status(500).json({ error: "Failed to send email." });
    }
    // For now, log it so you can test manually:
    console.log(
      `Password reset link: ${config.allowedOrigin}/reset-password?token=${resetToken}`,
    );

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
      .select("id, email ,name ,onboardingCompleted")
      .eq("id", record.user_id)
      .single();

    // 4. Delete token (one-time use)
    await supabase
      .from("email_verification_tokens")
      .delete()
      .eq("token", token);

    const JwtToken = signToken({ id: user?.id, email: user?.email });

    res.json({
      user: { id: user?.id, name: user?.name, email: user?.email },
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

    await sendVerificationEmail(user.id, email);
    res.json({ message: "Verification email resent" });
  } catch (error) {
    console.error("resend Email veridication  error:", error);
    res.status(500).json({ error: "Failed to process request." });
  }
};

/** Extract Supabase storage object path from a public URL, e.g. decks/foo.pdf */
function storagePathFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const marker = "/pitchnest-media/";
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

  const storagePaths = new Set<string>();
  for (const deck of decks || []) {
    const path = storagePathFromUrl(deck.file_url);
    if (path) storagePaths.add(path);
  }
  for (const session of sessions || []) {
    const path = storagePathFromUrl(session.video_url);
    if (path) storagePaths.add(path);
  }

  if (storagePaths.size > 0) {
    const { error: storageError } = await supabase.storage
      .from("pitchnest-media")
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
