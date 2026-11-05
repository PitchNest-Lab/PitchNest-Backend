import type { PublicBusinessProfile } from "../controllers/publicBusinessController.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function replaceMeta(html: string, key: string, value: string, property = false): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\s+[^>]*(?:name|property)=["']${escapedKey}["'][^>]*>`,
    "i",
  );
  const attribute = property ? "property" : "name";
  const tag = `<meta ${attribute}="${escapeHtml(key)}" content="${escapeHtml(value)}" />`;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace("</head>", `  ${tag}\n</head>`);
}

export function replaceCanonical(html: string, url: string): string {
  const tag = `<link rel="canonical" href="${escapeHtml(url)}" />`;
  const pattern = /<link\s+[^>]*rel=["']canonical["'][^>]*>/i;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace("</head>", `  ${tag}\n</head>`);
}

/**
 * The opening sentences of a founder's description, as many whole sentences
 * as fit in `maxLength`. A first sentence longer than that is cut at a word.
 * A full stop followed by a lowercase word ("e.g. shops") is not a sentence end.
 */
export function leadSentences(text: string, maxLength = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  let lead = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+(?=["'“(]?[A-Z0-9])/)) {
    const next = lead ? `${lead} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    lead = next;
  }
  if (lead || !clean) return lead;
  const cut = clean.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxLength / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * A tiny standalone document for social crawlers (WhatsApp, LinkedIn, X,
 * Slack, Facebook…). The frontend's static shell cannot carry per-business
 * tags, so the frontend host (vercel.json) forwards crawler user agents on
 * /businesses/:slug to the backend route that returns this. Humans never
 * receive it; if one does, the link points to the canonical page.
 */
export function renderPublicBusinessShareDocument(
  business: PublicBusinessProfile | null,
  origin: string,
  requestedSlug: string,
): string {
  const canonical = `${origin}/businesses/${encodeURIComponent(requestedSlug)}`;
  const label = business ? `View ${business.name} on PitchNest` : "Explore businesses on PitchNest";
  const href = business ? canonical : `${origin}/discover`;
  const template = [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>PitchNest</title>",
    "</head><body>",
    `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`,
    "</body></html>",
  ].join("\n");
  return injectPublicBusinessMetadata(template, business, origin, requestedSlug);
}

/**
 * Adds crawler-visible metadata before the React application boots. Passing a
 * null business produces a noindex shell, so unpublished slugs never retain the
 * generic site's indexable metadata.
 */
export function injectPublicBusinessMetadata(
  template: string,
  business: PublicBusinessProfile | null,
  origin: string,
  requestedSlug: string,
): string {
  const canonical = `${origin}/businesses/${encodeURIComponent(requestedSlug)}`;
  const title = business ? `${business.name} — PitchNest` : "Business not found — PitchNest";
  // The link-preview heading. Example profiles are illustrations, never launches.
  const shareTitle = !business
    ? title
    : business.isExample
      ? `Example business: ${business.name} — PitchNest Discover`
      : `${business.name} has launched on PitchNest Discover`;
  const description = business
    ? leadSentences(business.description) ||
      (business.tagline || `Explore ${business.name} on PitchNest.`).slice(0, 220)
    : "This PitchNest business profile is not publicly available.";
  // Example profiles are illustrations, not businesses to send searchers to.
  const robots = business && !business.isExample ? "index, follow" : "noindex, follow";
  // The business's own approved logo, then its cover, then the site image.
  const image = business?.logoUrl || business?.coverUrl || `${origin}/og-image.png`;

  let html = template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = replaceMeta(html, "description", description);
  html = replaceMeta(html, "robots", robots);
  html = replaceMeta(html, "og:type", "website", true);
  html = replaceMeta(html, "og:title", shareTitle, true);
  html = replaceMeta(html, "og:description", description, true);
  html = replaceMeta(html, "og:url", canonical, true);
  html = replaceMeta(html, "og:image", image, true);
  // A logo is square: the small card. A cover or the site image is wide.
  html = replaceMeta(html, "twitter:card", business?.logoUrl ? "summary" : "summary_large_image");
  html = replaceMeta(html, "twitter:title", shareTitle);
  html = replaceMeta(html, "twitter:description", description);
  html = replaceMeta(html, "twitter:image", image);
  return replaceCanonical(html, canonical);
}
