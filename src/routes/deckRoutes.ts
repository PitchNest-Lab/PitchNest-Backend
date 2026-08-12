import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  uploadDeck,
  listDecks,
  deleteDeck,
  runDeckAudit,
  listDeckAudits,
  downloadDeckAuditPDF,
  getDeckSignedUrl,
} from "../controllers/deckController.ts";
import { upload } from "../services/storageService.ts";

const router = Router();

// Deck Check audits hit the AI model — cap at 5 per user per hour. Runs AFTER
// authMiddleware so req.user is always set (per-user, not per-IP).
const auditLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Audit limit reached — you can run more Deck Checks in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The canonical deck upload lives at POST /api/upload-deck (uploadRoutes.ts),
 * where it is rate-limited to 20/hr. This route previously registered the SAME
 * handler with NO limiter, so anyone could bypass that cap simply by using the
 * other path. Removed rather than duplicated — one upload endpoint, one limit.
 */
router.get("/", authMiddleware, listDecks);

// Deck Check — static registered before "/:id"-shaped routes for clarity.
router.get("/audits/:auditId/pdf", authMiddleware, downloadDeckAuditPDF);
router.get("/:id/signed-url", authMiddleware, getDeckSignedUrl);
router.post("/:id/audit", authMiddleware, auditLimiter, runDeckAudit);
router.get("/:id/audits", authMiddleware, listDeckAudits);

router.delete("/:id", authMiddleware, deleteDeck);

export default router;
