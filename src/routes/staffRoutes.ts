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

export default router;
