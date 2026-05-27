import { Router } from "express";
import { signup, login, wipeDb } from "../controllers/authController.ts";

const router = Router();

router.get("/wipe", wipeDb);
router.post("/signup", signup);
router.post("/login", login);

export default router;
