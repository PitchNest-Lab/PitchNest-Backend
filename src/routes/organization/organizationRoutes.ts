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

const router = Router();

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