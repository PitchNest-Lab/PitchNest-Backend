import crypto from "crypto";
import { Resend } from "resend";
import { supabase } from "../config/supabase"; // your server-side supabase client

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendVerificationEmail(userId: string | number, email: string) {
  // 1. Generate token
  const token = crypto.randomBytes(32).toString("hex");
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
      from: "PitchNest <hello@pitchnest.app>", // Update with your verified domain
      to: email,
      subject: "Verify your PitchNest account",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="color:#1a1a2e">Verify your email</h2>
          <p style="color:#6b7280">
            Click the button below to verify your PitchNest account.
          </p>
          <a href="${verifyUrl}"
             style="display:inline-block;margin:24px 0;padding:14px 28px;
                    background:#3b82f6;color:#fff;border-radius:12px;
                    text-decoration:none;font-weight:700">
            Verify my email →
          </a>
          <p style="color:#9ca3af;font-size:12px">
            Link expires in 24 hours. If you didn't sign up, ignore this.
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