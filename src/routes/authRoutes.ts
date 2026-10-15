import { Router } from "express";
import rateLimit from "express-rate-limit";
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
  // Fetch the live row so a refetch keeps role (and name/email) fresh. If the
  // lookup fails transiently, fall back to the JWT identity so a healthy token
  // is never treated as logged-out — same liveness semantics as before.
  try {
    if (req.user!.accountType === "organization") {
      const { data: organization } = await supabase
        .from("Organizations")
        .select("*")
        .eq("id", req.user!.id)
        .maybeSingle();

      if (organization) {
        return res.json(toPublicOrganization(organization));
      }

      return res.status(503).json({ error: "Unable to load organization account." });
    }

    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user!.id)
      .maybeSingle();

    if (user) {
      return res.json({
        ...toPublicUser(user),
        isEmailVerified: user.isEmailVerified,
      });
    }
  } catch (err) {
    console.warn("GET /me lookup failed, falling back to token identity:", err);
  }
  res.json({
    id: req.user!.id,
    email: req.user!.email,
    accountType: req.user!.accountType,
    orgCode: req.user!.orgCode,
    isEmailVerified: false,
  });
});

// Deliberately not behind authLimiter — it fires on a timer for every active
// user, and the shared 20-per-15-min cap would starve real logins.
router.post("/refresh", accountAuthMiddleware, refreshToken);
router.post("/logout", accountAuthMiddleware, logout);

router.patch("/me", authMiddleware, updateMe);
router.patch("/settings", authMiddleware, updateSettings);

router.delete("/account", authMiddleware, authLimiter, deleteAccount);
router.post("/delete-account", authLimiter, deleteAccountByCredentials);

export default router;
