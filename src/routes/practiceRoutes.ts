import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  createPracticeDraft,
  getPracticeDraft,
} from "../controllers/practiceDraftController.ts";

/**
 * Private practice bridge. Mounted at /api/practice. Keyed per user: drafts
 * are cheap, but an unbounded insert endpoint is still a table-filling vector.
 */
const router = Router();

const draftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Too many practice starts. Please wait a few minutes." },
});

router.use(authMiddleware);

router.post("/drafts", draftLimiter, createPracticeDraft);
router.get("/drafts/:id", getPracticeDraft);

export default router;
