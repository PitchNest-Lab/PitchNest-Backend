import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  signup,
  login,
  orgLogin,
  googleAuth,
  updateMe,
  updateSettings,
  toPublicUser,
  toPublicOrganization,
  forgotPassword,
  resetPassword,
  deleteAccount,
  deleteAccountByCredentials,
  verifyEmail,
  verifyEmailOtp,
  resendEmailVerification,
  refreshToken,
  logout,
} from "../controllers/authController.ts";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  accountAuthMiddleware,
  authMiddleware,
} from "../middleware/authMiddleware.ts";

const router = Router();

// Rate limit: max 20 login/signup attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const sessionMaintenanceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  // Keyed by account; the IP fallback goes through ipKeyGenerator so IPv6
  // clients are grouped by subnet and cannot dodge the limit by rotating
  // addresses within their own range.
  keyGenerator: (req) =>
    String(req.user?.accountType ?? "account") + ":" + String(req.user?.id ?? ipKeyGenerator(req.ip ?? "")),
  message: { error: "Too many session requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// SECURITY: The database wipe endpoint has been removed. If you need to
// clear data in development, use the Supabase SQL editor directly.

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/organization-login", authLimiter, orgLogin);
router.post("/google", authLimiter, googleAuth);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", authLimiter, resetPassword);
router.get("/verify-email", authLimiter, verifyEmail);
router.post("/verify-email-otp", authLimiter, verifyEmailOtp);
router.post("/resend-verification", authLimiter, resendEmailVerification);

router.get("/me", accountAuthMiddleware, async (req, res) => {
  // Fetch the live row so a refetch keeps role, plan and profile data fresh.
  // Fail closed: a token snapshot is not a substitute for the authoritative
  // account row and could show stale entitlements or deleted profile data.
  try {
    if (req.user!.accountType === "organization") {
      const { data: organization, error } = await supabase
        .from("Organizations")
        .select("*")
        .eq("id", req.user!.id)
        .maybeSingle();

      if (error) {
        console.error("GET /me organization lookup failed:", error.message);
        return res.status(503).json({ error: "Unable to load organization account." });
      }

      if (organization) {
        return res.json(toPublicOrganization(organization));
      }

      return res.status(401).json({ error: "Organization account no longer exists." });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user!.id)
      .maybeSingle();

    if (error) {
      console.error("GET /me user lookup failed:", error.message);
      return res.status(503).json({ error: "Unable to load account." });
    }

    if (user) {
      return res.json({
        ...toPublicUser(user),
        isEmailVerified: user.isEmailVerified,
      });
    }
    return res.status(401).json({ error: "Account no longer exists." });
  } catch (err) {
    console.error("GET /me lookup threw:", err);
    return res.status(503).json({ error: "Unable to load account." });
  }
});

// Deliberately not behind authLimiter — it fires on a timer for every active
// user, and the shared 20-per-15-min cap would starve real logins.
router.post("/refresh", accountAuthMiddleware, sessionMaintenanceLimiter, refreshToken);
router.post("/logout", accountAuthMiddleware, sessionMaintenanceLimiter, logout);

router.patch("/me", authMiddleware, updateMe);
router.patch("/settings", authMiddleware, updateSettings);

router.delete("/account", authMiddleware, authLimiter, deleteAccount);
router.post("/delete-account", authLimiter, deleteAccountByCredentials);

export default router;
