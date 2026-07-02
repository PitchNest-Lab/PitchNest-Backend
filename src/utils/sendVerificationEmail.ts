import crypto from "crypto";
import { Resend } from "resend";
import { supabase } from "../config/supabase"; // your server-side supabase client
import { config } from "../config/env.ts";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendVerificationEmail(userId: string | number, email: string) {
  // 1. Generate 6-digit OTP code
  const token = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  // 2. Delete any old tokens for this user
  await supabase
    .from("email_verification_tokens")
    .delete()
    .eq("user_id", userId);

  // 3. Save new token to Supabase
  const { error } = await supabase
    .from("email_verification_tokens")
    .insert({ user_id: userId, token, expires_at: expiresAt });

  if (error) throw new Error("Failed to save token");

  // 4. Send email
  // Normalize the base URL so a trailing slash in CLIENT_URL doesn't produce a
  // broken double-slash link (e.g. https://app//verify).
  const baseUrl = (process.env.CLIENT_URL || "http://localhost:5174").replace(/\/+$/, "");
  const verifyUrl = `${baseUrl}/verify?token=${token}`;

  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "Mail is not configured (RESEND_API_KEY missing). " +
        "Set this in the backend environment so verification emails can send.",
    );
  }

  try {
    const { data, error } = await resend.emails.send({
      from: config.emailFrom,
      to: email,
      subject: "Verify your PitchNest account",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:16px;background:#fff">
          <h2 style="color:#111827;font-size:24px;margin-bottom:8px">Verify your email</h2>
          <p style="color:#4b5563;font-size:16px;line-height:24px;margin-bottom:24px">
            Enter this 6-digit verification code on the verification screen:
          </p>
          <div style="font-size:36px;font-weight:800;letter-spacing:6px;color:#0284c7;margin:24px 0;padding:16px;background:#f0f9ff;border-radius:12px;text-align:center;width:fit-content;margin-left:auto;margin-right:auto">
            ${token}
          </div>
          <p style="color:#4b5563;font-size:16px;line-height:24px;margin-bottom:24px;text-align:center">
            — OR —
          </p>
          <div style="text-align:center;margin-bottom:24px">
            <a href="${verifyUrl}"
               style="display:inline-block;padding:14px 28px;
                      background:#0284c7;color:#fff;border-radius:12px;
                      text-decoration:none;font-weight:700;font-size:16px">
              Verify my email →
            </a>
          </div>
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />
          <p style="color:#9ca3af;font-size:12px;line-height:18px;text-align:center">
            Link and code expire in 24 hours. If you didn't sign up, ignore this.
          </p>
        </div>
      `,
    });

    if (error) {
      throw new Error(error.message);
    }
  } catch (err: any) {
    console.error("❌ Verification email send failed:", err?.message || err);
    throw new Error(`Failed to send verification email: ${err?.message || err}`);
  }
}