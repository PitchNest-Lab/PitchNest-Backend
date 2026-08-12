import express from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  getPrice,
  getPlan,
  startCheckout,
  handleWebhook,
} from "../controllers/billingController.ts";

const router = express.Router();

/**
 * Checkout creates a row and calls out to Flutterwave, so it is both a write and
 * an outbound cost. Keyed per user rather than per IP: a shared campus NAT must
 * not lock a whole cohort out of upgrading.
 *
 * Deliberately NOT falling back to req.ip — express-rate-limit rejects a raw-IP
 * key generator because IPv6 clients can rotate addresses within their prefix
 * and slip the limit. The route sits behind authMiddleware, so req.user is
 * always set; "anon" is unreachable and exists only to keep the key a string.
 */
const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Too many checkout attempts. Please wait a few minutes." },
});

/**
 * PUBLIC — the price shown on the landing page and /pricing, which are both
 * reachable while logged out. Returns config values only, never user data.
 */
router.get("/price", getPrice);

router.get("/plan", authMiddleware, getPlan);
router.post("/checkout", authMiddleware, checkoutLimiter, startCheckout);

/**
 * WEBHOOK — deliberately NOT behind authMiddleware. Flutterwave has no user
 * session; it authenticates with the `verif-hash` header, which the controller
 * checks first thing.
 *
 * ⚠️ The raw-body parser is mounted in app.ts ABOVE the global express.json,
 * because the handler needs the unparsed bytes. Do not add a json parser here.
 *
 * The limiter is a cheap backstop, not the security boundary — the signature
 * check is. Keyed on IP and set well above Flutterwave's real delivery rate
 * (3 retries per event, 30 minutes apart), so it can only ever catch a flood.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many webhook deliveries." },
});

router.post("/webhook", webhookLimiter, handleWebhook);

export default router;
