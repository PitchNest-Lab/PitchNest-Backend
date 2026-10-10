import { Router } from "express";
import {
  overview,
  seats,
  activity,
  founderDrill,
  memberList,
  weeklyReport,
  monthlyReport,
  replays,
  orgDetails,
} from "../../controllers/organization/organizationController";
import { orgAuthMiddleware } from "../../middleware/orgAuthMiddleware.ts";

const router = Router();

// Every organization route requires an organization token (orgLogin) and is
// scoped server-side to that organization. Applied router-wide so a route added
// later cannot be left unauthenticated by omission.
router.use(orgAuthMiddleware);

router.post("/details", orgDetails);
router.post("/overview", overview);
router.post("/seats", seats);
router.post("/activity", activity);
router.post("/founder-drill", founderDrill);
router.post("/members", memberList);
router.post("/reports/weekly", weeklyReport);
router.post("/reports/monthly", monthlyReport);
router.get("/replays", replays);

export default router;
