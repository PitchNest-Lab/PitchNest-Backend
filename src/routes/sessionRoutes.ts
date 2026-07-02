import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { listSessions, getSession, deleteSession, createSession, generateSessionPDF } from "../controllers/sessionController.ts";

const router = Router();

router.get("/", authMiddleware, listSessions);
router.get("/:id/pdf", authMiddleware, generateSessionPDF);
router.get("/:id", authMiddleware, getSession);
router.delete("/:id", authMiddleware, deleteSession);
// NOTE: The live pitch flow creates sessions server-side over WebSocket
// (see sockets/restSocket.ts) once an evaluation completes, so the frontend
// does not currently call this REST endpoint. Kept for programmatic/manual
// session creation and future use.
router.post("/create", authMiddleware, createSession);


export default router;
