import crypto from "crypto";
import { transporter } from "./mailer";
import { supabase } from "../config/supabase"; // your server-side supabase client

export async function sendVerificationEmail(userId: string, email: string) {
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
  const verifyUrl = `${process.env.CLIENT_URL}/verify?token=${token}`;

  await transporter.sendMail({
    from: `"PitchNest" <${process.env.MAIL_USER}>`,
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
}