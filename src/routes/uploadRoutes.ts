import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { uploadVideo, uploadAvatar } from "../controllers/uploadController.ts";
import { uploadDeck } from "../controllers/deckController.ts";
import { upload } from "../services/storageService.ts";

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

router.post("/upload-video", authMiddleware, uploadLimiter, upload.single("video"), uploadVideo);
router.post("/upload-deck", authMiddleware, deckUploadLimiter, upload.single("deck"), uploadDeck);
router.post("/upload-avatar", authMiddleware, uploadLimiter, upload.single("avatar"), uploadAvatar);

export default router;
