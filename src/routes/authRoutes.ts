import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  signup,
  login,
  updateMe,
  wipeDb,
  forgotPassword,
  resetPassword,
  deleteAccount,
  deleteAccountByCredentials,
  verifyEmail,
  resendEmailVerification,
} from "../controllers/authController.ts";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

const router = Router();

// Rate limit: max 20 login/signup attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Database wipe — ONLY available in development mode
if (config.nodeEnv === "development") {
  router.get("/wipe", wipeDb);
}

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", authLimiter, resetPassword);
router.get("/verify-email", authLimiter, verifyEmail);
router.post("/resend-verification", authLimiter, resendEmailVerification);

router.get("/me", authMiddleware, async (req, res) => {
  // Fetch the live row so a refetch keeps role (and name/email) fresh. If the
  // lookup fails transiently, fall back to the JWT identity so a healthy token
  // is never treated as logged-out — same liveness semantics as before.
  try {
    const { data: user } = await supabase
      .from("users")
      .select("id, name, email, role")
      .eq("id", req.user!.id)
      .maybeSingle();

    if (user) {
      return res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      });
    }
  } catch (err) {
    console.warn("GET /me lookup failed, falling back to token identity:", err);
  }
  res.json({ id: req.user!.id, email: req.user!.email });
});

router.patch("/me", authMiddleware, updateMe);

router.delete("/account", authMiddleware, authLimiter, deleteAccount);
router.post("/delete-account", authLimiter, deleteAccountByCredentials);

export default router;
