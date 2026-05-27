import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { saveProfile, getProfile } from "../controllers/profileController.ts";

const router = Router();

router.post("/", authMiddleware, saveProfile);
router.get("/", authMiddleware, getProfile);

export default router;
