import type { Request, Response } from "express";
import {
  countFounderFollowers,
  isFollowingFounder,
  loadPublicFounder,
  setFounderFollow,
} from "../services/founderService.ts";

/**
 * Founder pages (public) and founder follows (signed in, behind the Discover
 * engagement flag). A founder who is not currently public answers 404 to
 * everyone, so a handle cannot be used to learn anything about a private user.
 *
 * Follower counts are shown to the founder only; the public page carries no
 * popularity number for a person.
 */

/** GET /api/public/founders/:handle (optional auth). */
export async function getPublicFounder(req: Request, res: Response) {
  try {
    const result = await loadPublicFounder(req.params.handle);
    if (!result) {
      res.set("Cache-Control", "public, max-age=15, s-maxage=30");
      return res.status(404).json({ error: "Founder not found." });
    }
    const viewerId = req.user?.id ?? null;
    const isSelf = viewerId === result.founderId;
    const [follows, followerCount] = await Promise.all([
      viewerId && !isSelf ? isFollowingFounder(result.founderId, viewerId) : Promise.resolve(false),
      isSelf ? countFounderFollowers(result.founderId) : Promise.resolve(null),
    ]);
    res.set("Cache-Control", viewerId ? "private, no-store" : "public, max-age=60, s-maxage=120");
    return res.json({
      data: {
        ...result.founder,
        viewer: {
          authenticated: Boolean(viewerId),
          isSelf,
          follows,
          followerCount,
        },
      },
    });
  } catch (error) {
    console.error("Founder page read failed:", error);
    return res.status(500).json({ error: "Failed to load this founder." });
  }
}

/** PUT|DELETE /api/discover/founders/:handle/follow */
export const setFounderFollowState = (active: boolean) => async (req: Request, res: Response) => {
  try {
    const result = await loadPublicFounder(req.params.handle);
    if (!result) return res.status(404).json({ error: "Founder not found." });
    if (result.founderId === req.user!.id) {
      return res.status(403).json({ error: "You can't follow yourself." });
    }
    await setFounderFollow(result.founderId, req.user!.id, active);
    return res.json({ data: { following: active } });
  } catch (error) {
    console.error("Founder follow update failed:", error);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
