import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  signup,
  login,
  wipeDb,
  forgotPassword,
  resetPassword,
  deleteAccount,
  deleteAccountByCredentials,
  verifyEmail,
  resendEmailVerification,
} from "../controllers/authController.ts";
import { config } from "../config/env.ts";
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

router.get("/me", authMiddleware, (req, res) => {
  res.json({ id: req.user!.id, email: req.user!.email });
});

router.delete("/account", authMiddleware, authLimiter, deleteAccount);
router.post("/delete-account", authLimiter, deleteAccountByCredentials);

export default router;
