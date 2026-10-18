import type { PublicBusinessProfile } from "../controllers/publicBusinessController.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function replaceMeta(html: string, key: string, value: string, property = false): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta\\s+[^>]*(?:name|property)=["']${escapedKey}["'][^>]*>`,
    "i",
  );
  const attribute = property ? "property" : "name";
  const tag = `<meta ${attribute}="${escapeHtml(key)}" content="${escapeHtml(value)}" />`;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace("</head>", `  ${tag}\n</head>`);
}

function replaceCanonical(html: string, url: string): string {
  const tag = `<link rel="canonical" href="${escapeHtml(url)}" />`;
  const pattern = /<link\s+[^>]*rel=["']canonical["'][^>]*>/i;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace("</head>", `  ${tag}\n</head>`);
}

/**
 * A tiny standalone document for social crawlers (WhatsApp, LinkedIn, X,
 * Slack, Facebook…). The frontend's static shell cannot carry per-business
 * tags, so the frontend host is meant to forward crawler user agents to the
 * backend route that returns this (not yet set up on the frontend host). Humans never
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
  const description = business
    ? (business.tagline || business.description || `Explore ${business.name} on PitchNest.`).slice(0, 220)
    : "This PitchNest business profile is not publicly available.";
  const robots = business ? "index, follow" : "noindex, follow";
  // The business's own approved cover (best for wide previews), then its logo.
  const image = business?.coverUrl || business?.logoUrl || `${origin}/og-image.png`;

  let html = template.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = replaceMeta(html, "description", description);
  html = replaceMeta(html, "robots", robots);
  html = replaceMeta(html, "og:type", "website", true);
  html = replaceMeta(html, "og:title", title, true);
  html = replaceMeta(html, "og:description", description, true);
  html = replaceMeta(html, "og:url", canonical, true);
  html = replaceMeta(html, "og:image", image, true);
  html = replaceMeta(html, "twitter:card", business?.coverUrl || !business?.logoUrl ? "summary_large_image" : "summary");
  html = replaceMeta(html, "twitter:title", title);
  html = replaceMeta(html, "twitter:description", description);
  html = replaceMeta(html, "twitter:image", image);
  return replaceCanonical(html, canonical);
}
