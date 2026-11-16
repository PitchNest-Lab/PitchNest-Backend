import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { organizationSubmissionUpload } from "../services/storageService.ts";
import {
  createFounderSubmissionDraft,
  founderSubmissionFileUrl,
  listFounderProgramForms,
  listFounderPrograms,
  listFounderSubmissions,
  submitFounderSubmission,
  uploadFounderSubmissionFile,
} from "../controllers/organization/founderProgramController.ts";

const router = Router();
router.use(authMiddleware);

const submissionUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user?.id ?? "anon"),
  message: { error: "Submission upload limit reached. Try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

function uploadConcurrency(max: number) {
  let active = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    if (active >= max) return res.status(503).json({ error: "Uploads are busy. Please retry in a few seconds." });
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    return next();
  };
}
const submissionUploadConcurrency = uploadConcurrency(4);

router.get("/", listFounderPrograms);
router.get("/:organizationId/forms", listFounderProgramForms);
router.post("/:organizationId/forms/:formId/submissions", createFounderSubmissionDraft);
router.post("/:organizationId/submissions/:submissionId/files", submissionUploadLimiter, submissionUploadConcurrency, organizationSubmissionUpload.single("file"), uploadFounderSubmissionFile);
router.post("/:organizationId/submissions/:submissionId/submit", submitFounderSubmission);
router.get("/:organizationId/submissions", listFounderSubmissions);
router.get("/:organizationId/submissions/:submissionId/files/:fileId", founderSubmissionFileUrl);

router.use((error: any, _req: Request, res: Response, next: NextFunction) => {
  if (error?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Files must be 10 MB or smaller." });
  if (typeof error?.message === "string" && error.message.startsWith("UNSUPPORTED_FILE_TYPE")) {
    return res.status(415).json({ error: "Use a PDF, Word document, PNG, JPEG, or text file." });
  }
  return next(error);
});

export default router;
