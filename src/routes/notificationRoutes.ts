import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  listNotifications,
  markNotificationsRead,
} from "../controllers/notificationController.ts";

/** In-app notifications for the signed-in user. Mounted at /api/notifications. */
const router = Router();

// The bell polls; keep a generous per-user ceiling so a stuck tab can't hammer.
const notificationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Too many notification requests. Please slow down." },
});

router.use(authMiddleware, notificationLimiter);

router.get("/", listNotifications);
router.post("/read", markNotificationsRead);

export default router;
