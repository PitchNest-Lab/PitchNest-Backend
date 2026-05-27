import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { uploadVideo } from "../controllers/uploadController.ts";
import { upload } from "../services/storageService.ts";

const router = Router();

router.post("/upload-video", authMiddleware, upload.single("video"), uploadVideo);

export default router;
