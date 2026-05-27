import { Router } from "express";
import { uploadDeck, listDecks, deleteDeck } from "../controllers/deckController.ts";
import { upload } from "../services/storageService.ts";

const router = Router();

router.post("/upload-deck", upload.single("deck"), uploadDeck);
router.get("/", listDecks);
router.delete("/:id", deleteDeck);

export default router;
