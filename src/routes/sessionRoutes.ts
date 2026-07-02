import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { listSessions, getSession, deleteSession, createSession, generateSessionPDF } from "../controllers/sessionController.ts";

const router = Router();

router.get("/", authMiddleware, listSessions);
router.get("/:id/pdf", authMiddleware, generateSessionPDF);
router.get("/:id", authMiddleware, getSession);
router.delete("/:id", authMiddleware, deleteSession);
// Sessions are normally created server-side via WebSocket (sockets/restSocket.ts).
router.post("/create", authMiddleware, createSession);


export default router;
