import { Router } from "express";
import { uploadVideo } from "../controllers/uploadController.ts";
import { upload } from "../services/storageService.ts";

const router = Router();

router.post("/upload-video", upload.single("video"), uploadVideo);

export default router;
