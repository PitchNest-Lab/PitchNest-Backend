import crypto from "crypto";
import { Resend } from "resend";
import { supabase } from "../config/supabase"; // your server-side supabase client
import { config } from "../config/env.ts";
import { hashAuthToken } from "./authTokens.ts";
import { withTimeout } from "./withTimeout.ts";

const resend =
  config.resendApiKey && config.resendApiKey !== "re_xxxxxxxxx"
    ? new Resend(config.resendApiKey)
    : null;

export async function sendVerificationEmail(userId: string | number, email: string) {
  // Two factors, both cryptographically random:
  //  • token — a long, high-entropy value for the emailed LINK. Because it is
  //    unguessable, the link's global lookup (verifyEmail) is safe.
  //  • code  — a 6-digit value for MANUAL entry, only ever checked SCOPED to
  //    this account (verifyEmailOtp) behind a per-record attempt lockout.
  // Math.random() must NOT be used here: it is not cryptographically secure, so
  // a predictable code would collapse the brute-force space.
  const token = crypto.randomBytes(32).toString("hex");
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  const tokenDigest = hashAuthToken("email-link", token);
  const codeDigest = hashAuthToken("email-code", code);

  // 2. Delete any old tokens for this user
  await supabase
    .from("email_verification_tokens")
    .delete()
    .eq("user_id", userId);

  // 3. Save new token to Supabase
  const { error } = await supabase
    .from("email_verification_tokens")
    .insert({
      user_id: userId,
      token: tokenDigest,
      code: codeDigest,
      expires_at: expiresAt,
      attempts: 0,
    });

  if (error) throw new Error("Failed to save token");

  // 4. Send email
  // Compose the link from the configured frontend origin (trailing slashes are
  // already stripped in config, so this cannot produce a broken double-slash).
  const verifyUrl = `${config.clientUrl}/verify?token=${token}`;

  // Log OTP in development so local testing never gets blocked by email deliverability / DNS
  if (config.nodeEnv !== "production") {
    console.log(`\n======================================================`);
    // Never print the address or high-entropy link token. The browser already
    // retains the address on the verification screen; only the local test code
    // is needed to unblock development.
    console.log(`🔑 [LOCAL DEV OTP] Verification Code: ${code}`);
    console.log(`======================================================\n`);
  }

  if (!resend) {
    throw new Error(
      "Mail is not configured (RESEND_API_KEY is missing or still set to re_xxxxxxxxx). " +
        "Replace the placeholder in the backend environment so verification emails can send.",
    );
  }

  try {
    const { error } = await withTimeout(
      resend.emails.send({
        from: config.emailFrom,
        replyTo: config.emailReplyTo,
        to: email,
        subject: "Verify your PitchNest account",
        html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border:1px solid #e5e7eb;border-radius:16px;background:#fff">
          <h2 style="color:#111827;font-size:24px;margin-bottom:8px">Verify your email</h2>
          <p style="color:#4b5563;font-size:16px;line-height:24px;margin-bottom:24px">
            Enter this 6-digit verification code on the verification screen:
          </p>
          <div style="font-size:36px;font-weight:800;letter-spacing:6px;color:#0284c7;margin:24px 0;padding:16px;background:#f0f9ff;border-radius:12px;text-align:center;width:fit-content;margin-left:auto;margin-right:auto">
            ${code}
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
      }, {
        idempotencyKey: `verification/${userId}/${tokenDigest.slice(0, 32)}`,
      }),
      15_000,
      "Verification email request",
    );

    if (error) {
      throw new Error(error.message);
    }
  } catch (err: any) {
    console.error("❌ Verification email send failed:", err?.message || err);
    throw new Error(`Failed to send verification email: ${err?.message || err}`);
  }
}
