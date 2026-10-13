import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { reportAiContent } from "../controllers/contentReportController.ts";

const router = Router();

// Generous for real use (a founder flagging several lines), tight enough to
// stop the table being flooded.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Report limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/ai-content", authMiddleware, reportLimiter, reportAiContent);

export default router;
