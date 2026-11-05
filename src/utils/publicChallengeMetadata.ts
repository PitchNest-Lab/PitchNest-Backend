import { escapeHtml, leadSentences, replaceCanonical, replaceMeta } from "./publicBusinessMetadata.ts";

export interface ChallengeShare {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  /** The poster as a 1200 × 630 JPEG card (absolute URL), or null for the site image. */
  imageUrl: string | null;
}

/** The preview text: the tagline, then as many opening sentences as fit in about 200 characters. */
export function challengeShareDescription(challenge: Pick<ChallengeShare, "title" | "tagline" | "description">): string {
  const tagline = challenge.tagline.replace(/\s+/g, " ").trim();
  const lead = leadSentences(challenge.description, Math.max(80, 200 - (tagline ? tagline.length + 1 : 0)));
  return [tagline, lead].filter(Boolean).join(" ") || `${challenge.title}: a pitch competition hosted by PitchNest.`;
}

/**
 * The link preview for a shared challenge page, like the business one
 * (publicBusinessMetadata.ts): the frontend host (vercel.json) forwards
 * crawler user agents on /opportunities/challenges/:slug to the backend route
 * that returns this. It shows the challenge's title, its tagline and opening
 * sentences, and its poster. A draft or unknown slug gets a noindex "not
 * found" card that names nothing. Humans never receive it; if one does, the
 * link points to the page.
 */
export function renderChallengeShareDocument(
  challenge: ChallengeShare | null,
  origin: string,
  requestedSlug: string,
): string {
  const canonical = `${origin}/opportunities/challenges/${encodeURIComponent(requestedSlug)}`;
  const title = challenge ? `${challenge.title} — PitchNest` : "Challenge not found — PitchNest";
  const shareTitle = challenge ? challenge.title : title;
  const description = challenge
    ? challengeShareDescription(challenge)
    : "This PitchNest challenge is not publicly available.";
  // The card and the site image are both 1200 × 630.
  const image = challenge?.imageUrl || `${origin}/og-image.png`;
  const template = [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>PitchNest</title>",
    '<meta property="og:site_name" content="PitchNest" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${escapeHtml(challenge?.imageUrl ? `${challenge.title} poster` : "PitchNest")}" />`,
    "</head><body>",
    challenge
      ? `<p><a href="${escapeHtml(canonical)}">${escapeHtml(`View the ${challenge.title} on PitchNest`)}</a></p>`
      : `<p><a href="${escapeHtml(`${origin}/opportunities`)}">Explore opportunities on PitchNest</a></p>`,
    "</body></html>",
  ].join("\n");

  let html = template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = replaceMeta(html, "description", description);
  html = replaceMeta(html, "robots", challenge ? "index, follow" : "noindex, follow");
  html = replaceMeta(html, "og:type", "website", true);
  html = replaceMeta(html, "og:title", shareTitle, true);
  html = replaceMeta(html, "og:description", description, true);
  html = replaceMeta(html, "og:url", canonical, true);
  html = replaceMeta(html, "og:image", image, true);
  html = replaceMeta(html, "twitter:card", "summary_large_image");
  html = replaceMeta(html, "twitter:title", shareTitle);
  html = replaceMeta(html, "twitter:description", description);
  html = replaceMeta(html, "twitter:image", image);
  return replaceCanonical(html, canonical);
}
