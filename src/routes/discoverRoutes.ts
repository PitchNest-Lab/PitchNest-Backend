import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  createBusinessComment,
  createContentReport,
  removeBusinessComment,
  requireDiscoverEngagement,
  setBusinessEngagement,
} from "../controllers/discoverEngagementController.ts";
import { setFounderFollowState } from "../controllers/founderController.ts";

/**
 * Authenticated Discover engagement. Mounted at /api/discover.
 *
 * Every limiter is keyed per user, not per IP: a shared campus or mobile-carrier
 * NAT must not let one person's activity block a whole cohort. The routes sit
 * behind authMiddleware, so req.user is always set ("anon" is unreachable).
 */
const router = Router();

const userKey = (req: any) => String(req.user?.id ?? "anon");

const engagementLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "You're doing that a lot. Please wait a little and try again." },
});

const commentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "You're commenting very quickly. Please wait a few minutes." },
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "Too many reports in a short time. Please try again later." },
});

router.use(requireDiscoverEngagement, authMiddleware);

router.put("/businesses/:slug/support", engagementLimiter, setBusinessEngagement("support", true));
router.delete("/businesses/:slug/support", engagementLimiter, setBusinessEngagement("support", false));
router.put("/businesses/:slug/follow", engagementLimiter, setBusinessEngagement("follow", true));
router.delete("/businesses/:slug/follow", engagementLimiter, setBusinessEngagement("follow", false));

router.put("/founders/:handle/follow", engagementLimiter, setFounderFollowState(true));
router.delete("/founders/:handle/follow", engagementLimiter, setFounderFollowState(false));

router.post("/businesses/:slug/comments", commentLimiter, createBusinessComment);
router.delete("/comments/:commentId", engagementLimiter, removeBusinessComment);

router.post("/reports", reportLimiter, createContentReport);

export default router;
