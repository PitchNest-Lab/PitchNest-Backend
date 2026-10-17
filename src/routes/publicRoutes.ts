import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getPublicPitch } from "../controllers/sessionController.ts";
import {
  getPublicBusiness,
  getPublicBusinessShareHtml,
  listPublicBusinesses,
} from "../controllers/publicBusinessController.ts";
import {
  getBusinessEngagement,
  getPublicFeatures,
  listBusinessComments,
  requireDiscoverEngagement,
} from "../controllers/discoverEngagementController.ts";
import { optionalUserAuth } from "../middleware/authMiddleware.ts";
import { listPublicBusinessUpdates } from "../controllers/businessActivityController.ts";
import { listPublicOpportunities } from "../controllers/opportunityController.ts";
import { getPublicFounder } from "../controllers/founderController.ts";
import { recordClientEvent } from "../services/eventService.ts";
import {
  getPublicPitch as getPublicBusinessPitch,
  listPublicPitches,
  requirePitchArena,
} from "../controllers/pitchController.ts";

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
 * Every route here must project its response field by field the way
 * getPublicPitch and the Discover serializers do — never spread a database
 * row or a JSONB blob and delete the parts that look sensitive, because the
 * next field added to that blob then ships to the public by default.
 */
const router = Router();

// Keyed on IP via the library's default generator. Share ids are unguessable
// v4 UUIDs, so this is not the security boundary — it is there so that a public
// endpoint cannot be hammered for free. 120/hour is far above what a human
// opening a shared link will ever need and far below what a scraper wants.
export const publicReadLimiter = rateLimit({
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

/**
 * Discover reads. Browsing touches several endpoints per profile (profile,
 * engagement, comments), and many users in the pilot region share carrier or
 * campus NAT addresses, so these get a roomier per-IP budget than the share
 * link above. Still IP-keyed: there is no account to key on.
 */
export const discoverReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

router.get("/features", getPublicFeatures);

// Page-view analytics from the browser. Only allowlisted view events and
// properties are accepted (services/eventService.ts); nothing else is stored.
const eventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});
router.post("/events", eventLimiter, optionalUserAuth, recordClientEvent);
// Staff-curated opportunities; read-only for everyone else.
router.get("/opportunities", discoverReadLimiter, listPublicOpportunities);
router.get("/businesses", discoverReadLimiter, listPublicBusinesses);
router.get("/businesses/:slug", discoverReadLimiter, getPublicBusiness);
// Link-preview HTML for social crawlers, because the static SPA shell cannot
// carry per-business Open Graph tags. Only reached once the frontend host
// forwards crawler requests for /businesses/:slug here — not yet set up on
// the frontend host.
router.get("/businesses/:slug/share-html", discoverReadLimiter, getPublicBusinessShareHtml);
router.get(
  "/businesses/:slug/engagement",
  discoverReadLimiter,
  requireDiscoverEngagement,
  optionalUserAuth,
  getBusinessEngagement,
);
// Founder pages (migration 0029): only founders who chose to appear on a
// published business; everyone else is a 404.
router.get("/founders/:handle", discoverReadLimiter, optionalUserAuth, getPublicFounder);
// Pitch Arena (migration 0026): published pitches of published businesses only.
router.get("/pitches", discoverReadLimiter, requirePitchArena, listPublicPitches);
router.get("/businesses/:slug/pitch", discoverReadLimiter, requirePitchArena, getPublicBusinessPitch);
router.get(
  "/businesses/:slug/updates",
  discoverReadLimiter,
  requireDiscoverEngagement,
  listPublicBusinessUpdates,
);
router.get(
  "/businesses/:slug/comments",
  discoverReadLimiter,
  requireDiscoverEngagement,
  optionalUserAuth,
  listBusinessComments,
);

export default router;
