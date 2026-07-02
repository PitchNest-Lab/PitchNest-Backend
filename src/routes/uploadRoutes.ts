import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { uploadVideo, uploadAvatar } from "../controllers/uploadController.ts";
import { uploadDeck } from "../controllers/deckController.ts";
import { upload } from "../services/storageService.ts";

const router = Router();

router.post("/upload-video", authMiddleware, upload.single("video"), uploadVideo);
router.post("/upload-deck", authMiddleware, upload.single("deck"), uploadDeck);
router.post("/upload-avatar", authMiddleware, upload.single("avatar"), uploadAvatar);

export default router;
