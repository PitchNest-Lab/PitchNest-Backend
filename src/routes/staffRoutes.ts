import { Router } from "express";
import { authMiddleware, requireStaff } from "../middleware/authMiddleware.ts";
import {
  listReports,
  resolveReport,
  restoreContent,
} from "../controllers/moderationController.ts";
import {
  createOpportunity,
  listStaffOpportunities,
  markOpportunityChecked,
  updateOpportunity,
} from "../controllers/opportunityController.ts";
import { getEventSummary } from "../services/eventService.ts";
import {
  confirmStaffChallengeItem,
  createStaffChallenge,
  createStaffDiscount,
  getStaffChallenge,
  getStaffChallengeParticipant,
  judgeStaffChallengeParticipant,
  listStaffChallengeAudit,
  listStaffChallengeParticipants,
  listStaffChallenges,
  listStaffDiscounts,
  previewStaffChallenge,
  publishStaffChallengeResults,
  removeStaffChallengeImage,
  reviewStaffChallengeParticipant,
  setStaffChallengeStatus,
  setStaffChallengeWinners,
  unpublishStaffChallengeResults,
  updateStaffChallenge,
  updateStaffDiscount,
  uploadStaffChallengeImage,
} from "../controllers/staffChallengeController.ts";
import { singleImage } from "./challengeRoutes.ts";

/**
 * Staff-only tools. Mounted at /api/staff. Staff are normal user accounts
 * with users.is_staff = TRUE (migration 0021); everyone else gets 404.
 */
const router = Router();

router.use(authMiddleware, requireStaff);

router.get("/moderation/reports", listReports);
router.post("/moderation/reports/:reportId/resolve", resolveReport);
router.post("/moderation/restore", restoreContent);

// Curated opportunities (migration 0024).
router.get("/opportunities", listStaffOpportunities);
router.post("/opportunities", createOpportunity);
router.patch("/opportunities/:id", updateOpportunity);
router.post("/opportunities/:id/checked", markOpportunityChecked);

// Product analytics: aggregate counts only (migration 0025).
router.get("/analytics/summary", getEventSummary);

// Hosted challenges, their entries, judging and winners (migration 0038).
router.get("/challenges", listStaffChallenges);
router.post("/challenges", createStaffChallenge);
router.get("/challenges/preview/:slug", previewStaffChallenge);
router.get("/challenges/:id", getStaffChallenge);
router.patch("/challenges/:id", updateStaffChallenge);
router.post("/challenges/:id/confirm", confirmStaffChallengeItem);
router.post("/challenges/:id/status", setStaffChallengeStatus);
router.put("/challenges/:id/image", singleImage, uploadStaffChallengeImage);
router.delete("/challenges/:id/image", removeStaffChallengeImage);
router.get("/challenges/:id/participants", listStaffChallengeParticipants);
router.get("/challenges/:id/participants/:pid", getStaffChallengeParticipant);
router.post("/challenges/:id/participants/:pid/review", reviewStaffChallengeParticipant);
router.post("/challenges/:id/participants/:pid/judging", judgeStaffChallengeParticipant);
router.put("/challenges/:id/winners", setStaffChallengeWinners);
router.post("/challenges/:id/results/publish", publishStaffChallengeResults);
router.post("/challenges/:id/results/unpublish", unpublishStaffChallengeResults);
router.get("/challenges/:id/audit", listStaffChallengeAudit);

// Discount codes for checkout (migration 0038).
router.get("/discounts", listStaffDiscounts);
router.post("/discounts", createStaffDiscount);
router.patch("/discounts/:id", updateStaffDiscount);

export default router;
