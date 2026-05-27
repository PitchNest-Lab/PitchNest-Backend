import multer from "multer";
import path from "path";
import fs from "fs";
import { config } from "../config/env.ts";

// Set uploads directory based on environment (local vs GAE/GCF /tmp)
export const uploadDir = config.isGoogleCloud 
  ? '/tmp/uploads' 
  : path.join(process.cwd(), 'uploads');

// Ensure directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configured multer instance with 500MB size limit (perfect for long webm uploads)
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});
