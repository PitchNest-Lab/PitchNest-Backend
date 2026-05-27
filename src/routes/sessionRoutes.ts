import { Router } from "express";
import { listSessions, getSession, deleteSession } from "../controllers/sessionController.ts";

const router = Router();

router.get("/", listSessions);
router.get("/:id", getSession);
router.delete("/:id", deleteSession);

export default router;
