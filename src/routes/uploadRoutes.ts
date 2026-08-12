import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { uploadVideo, uploadAvatar } from "../controllers/uploadController.ts";
import { uploadDeck } from "../controllers/deckController.ts";
import { deckUpload, avatarUpload, videoUpload } from "../services/storageService.ts";

const router = Router();

// Rate limit uploads to prevent storage / billing abuse.
// Video: 10/hour, Deck: 20/hour, Avatar: 10/hour — all per user.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Upload limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

const deckUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Deck upload limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/upload-video", authMiddleware, uploadLimiter, videoUpload.single("video"), uploadVideo);
router.post("/upload-deck", authMiddleware, deckUploadLimiter, deckUpload.single("deck"), uploadDeck);
router.post("/upload-avatar", authMiddleware, uploadLimiter, avatarUpload.single("avatar"), uploadAvatar);

/**
 * Turns multer's rejections into a clean 4xx.
 *
 * Without this, a too-large or wrong-type file surfaces as a generic 500 and the
 * user is told nothing useful. Scoped to this router so it cannot swallow errors
 * from unrelated routes.
 */
router.use((err: any, _req: any, res: any, next: any) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "That file is too large." });
  }
  if (typeof err?.message === "string" && err.message.startsWith("UNSUPPORTED_FILE_TYPE")) {
    const kind = err.message.split(":")[1] ?? "file";
    return res.status(415).json({ error: `That file type is not supported for ${kind} uploads.` });
  }
  return next(err);
});

export default router;
