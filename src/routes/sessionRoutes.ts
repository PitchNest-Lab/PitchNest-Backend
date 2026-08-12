import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { listSessions, getSession, deleteSession, generateSessionPDF } from "../controllers/sessionController.ts";

const router = Router();

// Rate limit PDF generation — it renders a 6-page document. 20 per hour per user.
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
// NOTE: POST /create was removed. Sessions are created server-side in
// sockets/restSocket.ts at end_session. The HTTP route accepted a
// client-supplied evaluation_report and bypassed both the WebSocket flow and
// the plan quota, so it was a paywall hole with no callers.

export default router;
