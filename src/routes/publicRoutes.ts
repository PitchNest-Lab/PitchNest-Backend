import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getPublicPitch } from "../controllers/sessionController.ts";

/**
 * The unauthenticated half of the API.
 *
 * This file exists so that "what can a stranger reach?" has a one-file answer.
 * Every other router in backend/src/routes is mounted behind authMiddleware on
 * every route (or, for the billing webhook, behind a shared-secret check); a
 * route added here is reachable by anyone on the internet with the URL, so it
 * gets its own file and its own rate limit rather than being one more line
 * tucked inside a router that is otherwise all authenticated.
 *
 * Currently one route. If it grows, whatever lands next must project its
 * response field by field the way getPublicPitch does — never spread a database
 * row or a JSONB blob and delete the parts that look sensitive, because the
 * next field added to that blob then ships to the public by default.
 */
const router = Router();

// Keyed on IP via the library's default generator. Share ids are unguessable
// v4 UUIDs, so this is not the security boundary — it is there so that a public
// endpoint cannot be hammered for free. 120/hour is far above what a human
// opening a shared link will ever need and far below what a scraper wants.
const publicReadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

/**
 * GET /api/public/pitch/:shareId — the read behind the frontend's
 * /share/<shareId> page. 404s for unknown ids, revoked ids and unscored
 * sessions alike; see getPublicPitch for the projection and the reasoning.
 */
router.get("/pitch/:shareId", publicReadLimiter, getPublicPitch);

export default router;
