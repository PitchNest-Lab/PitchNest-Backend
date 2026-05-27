import { Router } from "express";
import rateLimit from "express-rate-limit";
import { signup, login, wipeDb } from "../controllers/authController.ts";
import { config } from "../config/env.ts";

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

export default router;
