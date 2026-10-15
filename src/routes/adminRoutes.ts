import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware, requireStaff } from "../middleware/authMiddleware.ts";
import { listAllTranscripts } from "../controllers/adminController.ts";

// Keep this sensitive surface minimal. Access requires a verified user whose
// staff flag is re-read from the database on every request, so it is revocable.
const router = Router();

const transcriptReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many transcript requests. Please try again later." },
});

router.get(
  "/transcripts",
  authMiddleware,
  requireStaff,
  transcriptReadLimiter,
  listAllTranscripts,
);

export default router;
