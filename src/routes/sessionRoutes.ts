import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { listSessions, getSession, deleteSession, createSession, generateSessionPDF } from "../controllers/sessionController.ts";

const router = Router();

// Rate limit session creation and PDF generation — these hit AI / database
// heavily. 10 creates per hour, 20 PDF downloads per hour per user.
const sessionCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Session creation limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "PDF download limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/", authMiddleware, listSessions);
router.get("/:id/pdf", authMiddleware, pdfLimiter, generateSessionPDF);
router.get("/:id", authMiddleware, getSession);
router.delete("/:id", authMiddleware, deleteSession);
// Sessions are normally created server-side via WebSocket (sockets/restSocket.ts).
router.post("/create", authMiddleware, sessionCreateLimiter, createSession);


export default router;
