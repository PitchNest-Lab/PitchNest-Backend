import { Router } from "express";
import { adminMiddleware } from "../middleware/adminMiddleware.ts";
import { listAllTranscripts } from "../controllers/adminController.ts";

// Internal admin routes (Item C). Gated by the shared ADMIN_API_KEY via
// adminMiddleware — NOT the normal user auth. Disabled (404) when the key is
// unset. Keep this surface minimal: read-only transcript review only.
const router = Router();

router.get("/transcripts", adminMiddleware, listAllTranscripts);

export default router;
