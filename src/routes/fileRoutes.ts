import { Router } from "express";
import { getLocalFile } from "../controllers/fileController.ts";

/**
 * Token-gated delivery for local-fallback files (S7) — replaces the removed
 * unauthenticated `express.static('/uploads')` mount. The token in the query
 * string is the capability proof (iframes can't send Authorization headers);
 * ownership is additionally re-checked against the decks table at serve time.
 */
const fileRoutes = Router();

fileRoutes.get("/:name", getLocalFile);

export default fileRoutes;
