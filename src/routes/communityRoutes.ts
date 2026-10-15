import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware, optionalUserAuth } from "../middleware/authMiddleware.ts";
import {
  createReply,
  createThread,
  getThread,
  listReplies,
  listThreads,
  removeOwnCommunityItem,
  reportCommunityItem,
  requireCommunity,
} from "../controllers/communityController.ts";
import { discoverReadLimiter } from "./publicRoutes.ts";

/**
 * Community discussions. Mounted at /api/community. Reads are public (with
 * optional auth so authors see their own remove buttons); writes need an
 * account and are rate-limited per user, not per IP, so a shared campus or
 * carrier NAT never blocks a whole group.
 */
const router = Router();

const userKey = (req: any) => String(req.user?.id ?? "anon");

const threadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "You've started several discussions recently. Please wait before starting another." },
});

const replyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "You're replying very quickly. Please wait a few minutes." },
});

const actionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "Too many requests. Please try again later." },
});

router.use(requireCommunity);

router.get("/threads", discoverReadLimiter, optionalUserAuth, listThreads);
router.get("/threads/:threadId", discoverReadLimiter, optionalUserAuth, getThread);
router.get("/threads/:threadId/replies", discoverReadLimiter, optionalUserAuth, listReplies);

router.post("/threads", authMiddleware, threadLimiter, createThread);
router.post("/threads/:threadId/replies", authMiddleware, replyLimiter, createReply);
router.delete("/threads/:id", authMiddleware, actionLimiter, removeOwnCommunityItem("thread"));
router.delete("/replies/:id", authMiddleware, actionLimiter, removeOwnCommunityItem("reply"));
router.post("/reports", authMiddleware, actionLimiter, reportCommunityItem);

export default router;
