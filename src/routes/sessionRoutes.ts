import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { listSessions, getSession, deleteSession , createSession} from "../controllers/sessionController.ts";

const router = Router();

router.get("/", authMiddleware, listSessions);
router.get("/:id", authMiddleware, getSession);
router.delete("/:id", authMiddleware, deleteSession);
router.post("/create", authMiddleware, createSession);


export default router;
