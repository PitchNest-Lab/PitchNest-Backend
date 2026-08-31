import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  listSessions,
  getSession,
  deleteSession,
  generateSessionPDF,
  getSessionRecording,
  getPitchAttempts,
} from "../controllers/sessionController.ts";

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
// Replay support: a short-lived signed URL for the session's AUDIO recording,
// and the server-authoritative attempt state for the pitch this session belongs
// to. Both are owner-only and must stay ABOVE the bare "/:id" route so Express
// doesn't match them as a session id.
router.get("/:id/recording", authMiddleware, getSessionRecording);
router.get("/:id/attempts", authMiddleware, getPitchAttempts);
router.get("/:id", authMiddleware, getSession);
router.delete("/:id", authMiddleware, deleteSession);
// NOTE: POST /create was removed. Sessions are created server-side in
// sockets/restSocket.ts at end_session. The HTTP route accepted a
// client-supplied evaluation_report and bypassed both the WebSocket flow and
// the plan quota, so it was a paywall hole with no callers.

export default router;
