import { Router, type NextFunction, type Request, type Response } from "express";
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

/**
 * Bound expensive concurrent uploads process-wide. Per-user hourly limits do
 * not protect a small 384 MB instance from several accounts parsing 25 MB PDFs
 * at the same time. This gate runs before multer allocates/buffers the body and
 * releases on both normal completion and disconnected clients.
 */
function concurrencyLimit(max: number) {
  let active = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    if (active >= max) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: "Uploads are busy. Please retry in a few seconds." });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    return next();
  };
}

const recordingConcurrency = concurrencyLimit(4);
const deckConcurrency = concurrencyLimit(2);
const avatarConcurrency = concurrencyLimit(8);

router.post("/upload-video", authMiddleware, uploadLimiter, recordingConcurrency, videoUpload.single("video"), uploadVideo);
router.post("/upload-deck", authMiddleware, deckUploadLimiter, deckConcurrency, deckUpload.single("deck"), uploadDeck);
router.post("/upload-avatar", authMiddleware, uploadLimiter, avatarConcurrency, avatarUpload.single("avatar"), uploadAvatar);

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
