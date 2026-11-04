import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { businessImageUpload } from "../services/storageService.ts";
import {
  getMyChallengeEntry,
  joinChallenge,
  removeChallengeEvidence,
  submitChallengeEntry,
  updateChallengeEntry,
  uploadChallengeEvidence,
} from "../controllers/challengeController.ts";

/**
 * A founder's own challenge entry (migration 0038). Mounted at
 * /api/challenges behind authMiddleware: every route acts on the signed-in
 * founder's row only. The public challenge page is in routes/publicRoutes.ts.
 */

/** One image under the field "image", with readable errors for multer rejects. */
export function singleImage(req: Request, res: Response, next: NextFunction) {
  businessImageUpload.single("image")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image is too large (max 6 MB)." });
    if (String(err.message || "").startsWith("UNSUPPORTED_FILE_TYPE")) {
      return res.status(415).json({ error: "Use a PNG, JPEG or WebP image." });
    }
    return next(err);
  });
}

const perUser = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user?.id ?? "anon"),
    message: { error: message },
  });

// Reading an entry recomputes the verified score, so it is capped too.
const entryReadLimiter = perUser(15 * 60 * 1000, 120, "Too many requests. Please wait a few minutes.");
const entryWriteLimiter = perUser(60 * 60 * 1000, 60, "You've changed your entry many times recently. Please wait a little.");
const evidenceLimiter = perUser(60 * 60 * 1000, 10, "You've uploaded several screenshots recently. Please wait before uploading another.");

const router = Router();

router.use(authMiddleware);

router.get("/:slug/entry", entryReadLimiter, getMyChallengeEntry);
router.post("/:slug/join", entryWriteLimiter, joinChallenge);
router.patch("/:slug/entry", entryWriteLimiter, updateChallengeEntry);
router.post("/:slug/entry/submit", entryWriteLimiter, submitChallengeEntry);
router.put("/:slug/entry/evidence", evidenceLimiter, singleImage, uploadChallengeEvidence);
router.delete("/:slug/entry/evidence", entryWriteLimiter, removeChallengeEvidence);

export default router;
