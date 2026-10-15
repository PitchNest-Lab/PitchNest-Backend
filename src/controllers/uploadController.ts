import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { uploadDir, sanitizeUploadName } from "../services/storageService.ts";
import { MediaError, reencodeImage } from "../services/businessMediaService.ts";
import {
  recordingLocalName,
  recordingObjectPath,
  storagePathFromUrl,
} from "../utils/storagePath.ts";
import path from "path";
import fs from "fs";

function avatarTypeFromMagic(buffer: Buffer): { contentType: string; extension: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return { contentType: "image/png", extension: "png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return { contentType: "image/webp", extension: "webp" };
  const gif = buffer.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { contentType: "image/gif", extension: "gif" };
  }
  return null;
}

function recordingTypeFromMagic(head: Buffer): string | null {
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "audio/webm";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (
    head.length >= 12 &&
    head.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "audio/mp4";
  }
  if (
    (head.length >= 3 && head.subarray(0, 3).toString("ascii") === "ID3") ||
    (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }
  return null;
}

async function readFileHead(filePath: string, bytes = 16): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function removeTempFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
}

/**
 * Stores a completed session's AUDIO recording.
 *
 * The route is still called /api/upload-video and still answers with `videoUrl`.
 * Both names are historical: the recorder has always captured audio only
 * (getUserMedia is called with video: false), and the founder's camera is never
 * recorded or uploaded. Renaming the route or the response key would break the
 * live web client and the mobile client for no functional gain, so the contract
 * is left exactly as it was — see sessions.video_url for the same reasoning.
 */
export const uploadVideo = async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });
    tempPath = req.file.path;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const contentType = recordingTypeFromMagic(await readFileHead(tempPath));
    if (!contentType) {
      return res.status(415).json({ error: "The uploaded file is not a supported recording." });
    }

    // Keys are scoped to the uploader so the WebSocket can verify that a
    // set_video_url value really is this user's recording (isOwnRecordingReference).
    const originalName = sanitizeUploadName(req.file.originalname || `pitch.webm`);
    const filePath = recordingObjectPath(userId, originalName);

    const { error } = await supabase.storage
      .from(config.storageBucket)
      .upload(filePath, fs.createReadStream(tempPath), {
        contentType,
        duplex: 'half'
      });

    if (error) {
      // Local fallback if Supabase Storage has an issue
      const localName = recordingLocalName(userId, originalName);
      const destination = path.join(uploadDir, localName);
      await fs.promises.copyFile(tempPath, destination);
      return res.status(200).json({ videoUrl: `/uploads/${localName}` });
    }

    // Item A: the bucket is private, so return the BARE object path — never a
    // public URL. Playback goes through GET /api/sessions/:id/recording, which
    // signs this path on demand for the owner only; the deletion path derives
    // the same path to clean up on account purge.
    res.status(200).json({ videoUrl: filePath });
  } catch (error) {
    console.error("Recording upload failed:", error);
    res.status(500).json({ error: "Upload failed" });
  } finally {
    await removeTempFile(tempPath);
  }
};

export const uploadAvatar = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    const detected = avatarTypeFromMagic(req.file.buffer);
    if (!detected) return res.status(415).json({ error: "File must be a supported image." });

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    // Re-encode before storing: avatars are public (and shown on public business
    // profiles for consenting members), and phone photos carry GPS metadata.
    let image: Buffer;
    try {
      image = await reencodeImage(req.file.buffer, {
        width: 512,
        height: 512,
        fit: "cover",
        minWidth: 32,
        minHeight: 32,
        allowGif: true,
      });
    } catch (error) {
      if (error instanceof MediaError) return res.status(error.status).json({ error: error.message });
      throw error;
    }

    const { data: previousUser } = await supabase
      .from("users")
      .select("avatar_url")
      .eq("id", userId)
      .maybeSingle();
    const previousPath = storagePathFromUrl(previousUser?.avatar_url, config.avatarBucket);
    // A stable key prevents profile-photo changes from creating public orphan
    // objects. Every avatar is stored as WebP; no suffix is needed.
    const filePath = `avatars/${userId}/profile`;

    // Item A: avatars live in a SEPARATE public bucket so the main media bucket
    // (decks + pitch videos) can be fully private. Avatars stay public and load
    // unsigned via getPublicUrl.
    const { error } = await supabase.storage
      .from(config.avatarBucket)
      .upload(filePath, image, {
        contentType: "image/webp",
        upsert: true,
        duplex: "half",
      });

    if (error) {
      console.error("❌ Avatar storage upload failed:", error);
      return res.status(500).json({ error: "Failed to upload image." });
    }

    const { data: { publicUrl } } = supabase.storage
      .from(config.avatarBucket)
      .getPublicUrl(filePath);

    const { error: dbError } = await supabase
      .from("users")
      .update({ avatar_url: publicUrl })
      .eq("id", userId);

    if (dbError) {
      console.error("❌ Avatar DB update failed:", dbError);
      if (previousPath !== filePath) {
        await supabase.storage.from(config.avatarBucket).remove([filePath]);
      }
      return res.status(500).json({
        error:
          "Image uploaded but could not be saved. Ensure the avatar_url column exists (migration 0003).",
      });
    }

    if (previousPath && previousPath !== filePath) {
      const { error: cleanupError } = await supabase.storage
        .from(config.avatarBucket)
        .remove([previousPath]);
      if (cleanupError) {
        console.warn("Previous avatar cleanup failed:", cleanupError.message);
      }
    }

    res.status(200).json({ avatarUrl: publicUrl });
  } catch (error) {
    console.error("❌ uploadAvatar error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
};
