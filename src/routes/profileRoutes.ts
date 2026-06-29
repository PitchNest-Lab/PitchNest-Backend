import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { saveProfile, getProfile , skipOnbording } from "../controllers/profileController.ts";

const router = Router();

router.post("/", authMiddleware, saveProfile);
router.get("/", authMiddleware, getProfile);
router.put("/skip-onboarding",authMiddleware, skipOnbording )

export default router;
