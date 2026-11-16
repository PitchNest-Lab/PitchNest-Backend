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
  listReports,
  downloadReport,
} from "../../controllers/organization/organizationController";
import {
  organizationAuthMiddleware,
  requireOrgRole,
} from "../../middleware/authMiddleware.ts";
import {
  createOrganizationInvite,
  inviteOrganizationTeamMember,
  listOrganizationInvites,
  listOrganizationTeam,
  revokeOrganizationInvite,
  revokeOrganizationTeamMember,
} from "../../controllers/organization/organizationAdministrationController.ts";
import {
  createOrganizationForm,
  deleteOrganizationForm,
  listOrganizationFormSubmissions,
  listOrganizationForms,
  organizationSubmissionFileUrl,
  reviewOrganizationSubmission,
  updateOrganizationForm,
} from "../../controllers/organization/organizationProgramController.ts";

const router = Router();

router.use(organizationAuthMiddleware, requireOrgRole("owner", "admin", "facilitator"));

router.post("/details", orgDetails);
router.post("/overview", overview);
router.post("/seats", seats);
router.post("/activity", activity);
router.post("/founder-drill", founderDrill);
router.post("/members", memberList);
router.post("/reports/weekly", weeklyReport);
router.post("/reports/monthly", monthlyReport);
router.get("/reports", listReports);
router.get("/reports/:reportId/download", downloadReport);
router.get("/replays", replays);
router.get("/program-forms", listOrganizationForms);
router.post("/program-forms", createOrganizationForm);
router.patch("/program-forms/:formId", updateOrganizationForm);
router.delete("/program-forms/:formId", deleteOrganizationForm);
router.get("/program-forms/:formId/submissions", listOrganizationFormSubmissions);
router.patch("/program-submissions/:submissionId/review", reviewOrganizationSubmission);
router.get("/program-submissions/:submissionId/files/:fileId", organizationSubmissionFileUrl);
router.get("/team", requireOrgRole("owner", "admin"), listOrganizationTeam);
router.post("/team/invites", requireOrgRole("owner", "admin"), inviteOrganizationTeamMember);
router.delete("/team/:memberId", requireOrgRole("owner", "admin"), revokeOrganizationTeamMember);
router.get("/invites", listOrganizationInvites);
router.post("/invites", createOrganizationInvite);
router.delete("/invites/:inviteId", revokeOrganizationInvite);

export default router;
