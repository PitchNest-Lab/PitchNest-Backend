import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  requireBusinessMembership,
  requireBusinessRole,
} from "../middleware/businessAccessMiddleware.ts";
import {
  archiveBusiness,
  createBusiness,
  getBusiness,
  getLegacyBusinessDraft,
  getPublicationPreview,
  listBusinessMembers,
  listMyBusinesses,
  publishBusiness,
  unpublishBusiness,
  updateBusiness,
} from "../controllers/businessController.ts";
import { listBusinessPracticeSessions } from "../controllers/practiceDraftController.ts";
import {
  createBusinessUpdate,
  listMemberComments,
  listMemberUpdates,
  removeBusinessUpdate,
} from "../controllers/businessActivityController.ts";
import { requireDiscoverEngagement } from "../controllers/discoverEngagementController.ts";
import {
  getMemberPitch,
  publishPitch,
  requirePitchArena,
  savePitchDraft,
  withdrawPitch,
} from "../controllers/pitchController.ts";
import rateLimit from "express-rate-limit";

// Posting updates notifies followers, so cap it per user.
const updateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "You've posted several updates recently. Please wait before posting another." },
});

const router = Router();

router.use(authMiddleware);

router.post("/", createBusiness);
router.get("/mine", listMyBusinesses);
router.get("/legacy-profile-draft", getLegacyBusinessDraft);

const allMemberRoles = requireBusinessRole("owner", "admin", "editor", "viewer");
const editingRoles = requireBusinessRole("owner", "admin", "editor");
const publishingRoles = requireBusinessRole("owner", "admin");

router.get("/:id", requireBusinessMembership, allMemberRoles, getBusiness);
router.patch("/:id", requireBusinessMembership, editingRoles, updateBusiness);
router.delete("/:id", requireBusinessMembership, requireBusinessRole("owner"), archiveBusiness);
router.get("/:id/members", requireBusinessMembership, allMemberRoles, listBusinessMembers);
// Updates and milestones: members read; owners, admins and editors post/remove.
router.get("/:id/updates", requireBusinessMembership, allMemberRoles, listMemberUpdates);
router.post(
  "/:id/updates",
  requireDiscoverEngagement,
  requireBusinessMembership,
  editingRoles,
  updateLimiter,
  createBusinessUpdate,
);
router.delete("/:id/updates/:updateId", requireBusinessMembership, editingRoles, removeBusinessUpdate);
// Public pitch (migration 0026): editors draft, owners/admins publish.
// Withdrawing is always allowed, even with the feature flag off, so a founder
// can take their pitch down at any time.
router.get("/:id/pitch", requireBusinessMembership, allMemberRoles, getMemberPitch);
router.put("/:id/pitch/draft", requirePitchArena, requireBusinessMembership, editingRoles, savePitchDraft);
router.post("/:id/pitch/publish", requirePitchArena, requireBusinessMembership, publishingRoles, publishPitch);
router.post("/:id/pitch/withdraw", requireBusinessMembership, publishingRoles, withdrawPitch);
// The team's inbox of community questions on this business.
router.get("/:id/comments", requireBusinessMembership, allMemberRoles, listMemberComments);
// The caller's OWN private sessions for this business; never other members'.
router.get(
  "/:id/practice-sessions",
  requireBusinessMembership,
  allMemberRoles,
  listBusinessPracticeSessions,
);
router.get(
  "/:id/publication-preview",
  requireBusinessMembership,
  publishingRoles,
  getPublicationPreview,
);
router.post("/:id/publish", requireBusinessMembership, publishingRoles, publishBusiness);
router.post("/:id/unpublish", requireBusinessMembership, publishingRoles, unpublishBusiness);

export default router;
