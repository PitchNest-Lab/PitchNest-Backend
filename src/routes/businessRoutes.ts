import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  requireBusinessMembership,
  requireBusinessRole,
} from "../middleware/businessAccessMiddleware.ts";
import type { NextFunction, Request, Response } from "express";
import {
  archiveBusiness,
  createBusiness,
  getBusiness,
  getLegacyBusinessDraft,
  getPublicationPreview,
  listBusinessMembers,
  listMyBusinesses,
  publishBusiness,
  removeBusinessMedia,
  unpublishBusiness,
  updateBusiness,
  updateMyPublicProfile,
  uploadBusinessMedia,
} from "../controllers/businessController.ts";
import { businessImageUpload } from "../services/storageService.ts";
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

// Image processing is the expensive part of the workspace, so cap it per user.
const mediaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "You've changed images several times recently. Please wait before uploading another." },
});

/** One image under the field "image", with readable errors for multer rejects. */
function singleImage(req: Request, res: Response, next: NextFunction) {
  businessImageUpload.single("image")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image is too large (max 6 MB)." });
    if (String(err.message || "").startsWith("UNSUPPORTED_FILE_TYPE")) {
      return res.status(415).json({ error: "Use a PNG, JPEG or WebP image." });
    }
    return next(err);
  });
}

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
// Each member decides for themselves whether to appear on the public profile.
router.put("/:id/members/me/public-profile", requireBusinessMembership, allMemberRoles, updateMyPublicProfile);
// Logo and cover drafts: editors and up. They go public only on publish.
router.put("/:id/media/:kind", requireBusinessMembership, editingRoles, mediaLimiter, singleImage, uploadBusinessMedia);
router.delete("/:id/media/:kind", requireBusinessMembership, editingRoles, removeBusinessMedia);
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
