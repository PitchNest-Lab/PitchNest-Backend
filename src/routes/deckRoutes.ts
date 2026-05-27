import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import { uploadDeck, listDecks, deleteDeck } from "../controllers/deckController.ts";
import { upload } from "../services/storageService.ts";

const router = Router();

router.post("/upload-deck", authMiddleware, upload.single("deck"), uploadDeck);
router.get("/", authMiddleware, listDecks);
router.delete("/:id", authMiddleware, deleteDeck);

export default router;
