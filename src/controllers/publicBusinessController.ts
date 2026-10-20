import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { BUSINESS_TYPES } from "./businessController.ts";
import { loadDirectoryEngagement } from "./discoverEngagementController.ts";
import { renderPublicBusinessShareDocument } from "../utils/publicBusinessMetadata.ts";
import { logEvent } from "../services/eventService.ts";
import { loadPublicTeam, publicMediaUrl, type PublicTeamMember } from "../services/businessMediaService.ts";
import { config } from "../config/env.ts";

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 24;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type DirectoryCursor = {
  /** Present when the list is ordered by support count (migration 0033). */
  supportCount?: number;
  publishedAt: string;
  publicationId: string;
};

/** How a directory page is ordered; returned with every page. */
export type DirectoryOrder = "most_supported" | "newest";

export interface PublicBusinessSummary {
  slug: string;
  name: string;
  tagline: string;
  businessType: string;
  industry: string;
  stage: string;
  region: string;
  /** Approved images, served from public storage; null when there is none. */
  logoUrl: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
}

export interface PublicBusinessProfile extends PublicBusinessSummary {
  description: string;
  problem: string;
  solution: string;
  targetCustomer: string;
  websiteUrl: string;
  /** Members who personally chose to appear. Filled by readPublicBusinessProfile. */
  team: PublicTeamMember[];
}

function safeString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeWebsite(value: unknown): string {
  const website = safeString(value, 500);
  if (!website) return "";
  try {
    const parsed = new URL(website);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

function snapshotObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** A strict allowlist: fields absent here can never reach an anonymous caller. */
export function toPublicBusinessSummary(
  snapshotValue: unknown,
  publishedAt: unknown,
): PublicBusinessSummary {
  const snapshot = snapshotObject(snapshotValue);
  return {
    slug: safeString(snapshot.slug, 80),
    name: safeString(snapshot.name, 120),
    tagline: safeString(snapshot.tagline, 180),
    businessType: safeString(snapshot.businessType, 40),
    industry: safeString(snapshot.industry, 100),
    stage: safeString(snapshot.stage, 80),
    region: safeString(snapshot.region, 120),
    // Built from the approved file names only; the business id stays server-side.
    logoUrl: publicMediaUrl("logo", snapshot.id, snapshot.logoFile),
    coverUrl: publicMediaUrl("cover", snapshot.id, snapshot.coverFile),
    publishedAt: typeof publishedAt === "string" ? publishedAt : null,
  };
}

export function toPublicBusinessProfile(
  snapshotValue: unknown,
  publishedAt: unknown,
): PublicBusinessProfile {
  const snapshot = snapshotObject(snapshotValue);
  return {
    ...toPublicBusinessSummary(snapshot, publishedAt),
    description: safeString(snapshot.description, 3000),
    problem: safeString(snapshot.problem, 1500),
    solution: safeString(snapshot.solution, 1500),
    targetCustomer: safeString(snapshot.targetCustomer, 800),
    websiteUrl: safeWebsite(snapshot.websiteUrl),
    team: [],
  };
}

export function encodeDirectoryCursor(cursor: DirectoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeDirectoryCursor(value: string): DirectoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const date = new Date(parsed?.publishedAt);
    if (
      Number.isNaN(date.getTime()) ||
      typeof parsed?.publicationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.publicationId)
    ) {
      return null;
    }
    const cursor: DirectoryCursor = { publishedAt: date.toISOString(), publicationId: parsed.publicationId };
    if (parsed.supportCount !== undefined) {
      if (!Number.isSafeInteger(parsed.supportCount) || parsed.supportCount < 0) return null;
      cursor.supportCount = parsed.supportCount;
    }
    return cursor;
  } catch {
    return null;
  }
}

/** PostgREST answers PGRST202 for a function the database does not have. */
function isMissingFunction(error: any): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

let warnedNoSupportOrder = false;

function queryText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export async function listPublicBusinesses(req: Request, res: Response) {
  const q = queryText(req.query.q, 100);
  const industry = queryText(req.query.industry, 100);
  const businessType = queryText(req.query.type, 40).toLowerCase();
  const stage = queryText(req.query.stage, 80);
  const region = queryText(req.query.region, 120);
  if (businessType && !BUSINESS_TYPES.includes(businessType as any)) {
    return res.status(400).json({ error: "Invalid business type filter." });
  }

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const rawCursor = queryText(req.query.cursor, 1000);
  const cursor = rawCursor ? decodeDirectoryCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return res.status(400).json({ error: "Invalid pagination cursor." });
  }

  try {
    const args = {
      p_query: q || null,
      p_industry: industry || null,
      p_business_type: businessType || null,
      p_stage: stage || null,
      p_region: region || null,
      p_cursor_published_at: cursor?.publishedAt ?? null,
      p_cursor_publication_id: cursor?.publicationId ?? null,
      p_limit: limit + 1,
    };
    // Most supported first while Discover engagement is on. A cursor keeps the
    // order of the page it came from, and a database without migration 0033
    // lists newest first.
    let order: DirectoryOrder = (cursor ? cursor.supportCount !== undefined : config.discoverEngagementEnabled)
      ? "most_supported"
      : "newest";
    let result = order === "most_supported"
      ? await supabase.rpc("discover_public_businesses_by_support", {
          ...args,
          p_cursor_support_count: cursor?.supportCount ?? null,
        })
      : null;
    if (result?.error && isMissingFunction(result.error)) {
      if (!warnedNoSupportOrder) {
        warnedNoSupportOrder = true;
        console.warn("Discover lists newest first: the database has no discover_public_businesses_by_support (migration 0033).");
      }
      result = null;
    }
    if (!result) {
      order = "newest";
      result = await supabase.rpc("discover_public_businesses", args);
    }
    const { data, error } = result;
    if (error) {
      console.error("Public business directory query failed:", error);
      return res.status(500).json({ error: "Failed to load businesses." });
    }

    const rows = Array.isArray(data) ? data : [];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const entries = page
      .map((row: any) => ({
        // The snapshot id is used only server-side to look up counts.
        businessId: typeof row?.public_snapshot?.id === "string" ? row.public_snapshot.id : "",
        summary: toPublicBusinessSummary(row.public_snapshot, row.published_at),
      }))
      .filter(({ summary }) => summary.slug && summary.name);
    const engagement = await loadDirectoryEngagement(entries.map(({ businessId }) => businessId));
    const businesses = entries.map(({ businessId, summary }) => {
      const counts = engagement.get(businessId);
      return counts ? { ...summary, engagement: counts } : summary;
    });
    const finalRow = hasMore ? page[page.length - 1] : null;
    const nextCursor = finalRow
      ? encodeDirectoryCursor({
          ...(order === "most_supported" ? { supportCount: Number(finalRow.support_count) } : {}),
          publishedAt: new Date(finalRow.published_at).toISOString(),
          publicationId: finalRow.publication_id,
        })
      : null;

    // Only that a search happened, which filters were used, and how many
    // results came back. The search text itself is never recorded.
    const usedFilters = Object.entries({ q, industry, type: businessType, stage, region })
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);
    if (usedFilters.length && !cursor) {
      logEvent("business_search_performed", {
        properties: { hasQuery: Boolean(q), filters: usedFilters, resultCount: businesses.length },
      });
    }
    res.set("Cache-Control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300");
    return res.json({
      data: businesses,
      pagination: { nextCursor, hasMore },
      order,
    });
  } catch (error) {
    console.error("Public business directory threw:", error);
    return res.status(500).json({ error: "Failed to load businesses." });
  }
}

export async function getPublicBusiness(req: Request, res: Response) {
  const slug = queryText(req.params.slug, 80).toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    return res.status(404).json({ error: "Business not found." });
  }

  try {
    const business = await readPublicBusinessProfile(slug);
    if (!business) {
      res.set("Cache-Control", "public, max-age=15, s-maxage=30");
      return res.status(404).json({ error: "Business not found." });
    }
    res.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.json({ data: business });
  } catch (error) {
    console.error("Public business profile threw:", error);
    return res.status(500).json({ error: "Failed to load business." });
  }
}

export async function getPublicBusinessShareHtml(req: Request, res: Response) {
  const slug = queryText(req.params.slug, 80).toLowerCase();
  let business: PublicBusinessProfile | null = null;
  try {
    business = SLUG_PATTERN.test(slug) ? await readPublicBusinessProfile(slug) : null;
  } catch (error) {
    console.error("Share preview lookup failed:", error);
  }
  const html = renderPublicBusinessShareDocument(
    business,
    publicSiteOrigin(),
    SLUG_PATTERN.test(slug) ? slug : "unavailable",
  );
  res.set("Cache-Control", business ? "public, max-age=300, s-maxage=600" : "public, max-age=60");
  return res.status(business ? 200 : 404).type("html").send(html);
}

export async function readPublicBusinessProfile(
  slug: string,
): Promise<PublicBusinessProfile | null> {
  if (!SLUG_PATTERN.test(slug)) return null;
  const { data, error } = await supabase.rpc("get_public_business_by_slug", {
    p_slug: slug,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  const business = toPublicBusinessProfile(row.public_snapshot, row.published_at);
  if (!business.slug || !business.name) return null;
  // Read live, so a member who withdraws consent disappears on the next request.
  business.team = await loadPublicTeam(row.public_snapshot?.id);
  return business;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function publicSiteOrigin(): string {
  try {
    const url = new URL(config.publicSiteUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {}
  // Production refuses to boot with an invalid PUBLIC_SITE_URL (config/env.ts),
  // so this only answers in a misconfigured development setup.
  return "http://localhost:5174";
}

export async function getPublicBusinessSitemap(_req: Request, res: Response) {
  try {
    const { data, error } = await supabase.rpc("list_public_business_sitemap");
    if (error) {
      console.error("Public business sitemap query failed:", error);
      return res.status(500).type("text/plain").send("Sitemap unavailable");
    }
    const origin = publicSiteOrigin();
    const urls = [
      `<url><loc>${xmlEscape(`${origin}/discover`)}</loc></url>`,
      ...(Array.isArray(data) ? data : []).flatMap((row: any) => {
        const slug = safeString(row?.slug, 80);
        if (!SLUG_PATTERN.test(slug)) return [];
        const date = new Date(row?.updated_at);
        const lastmod = Number.isNaN(date.getTime()) ? "" : `<lastmod>${date.toISOString()}</lastmod>`;
        return [`<url><loc>${xmlEscape(`${origin}/businesses/${slug}`)}</loc>${lastmod}</url>`];
      }),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;
    res.set("Cache-Control", "public, max-age=300, s-maxage=3600");
    return res.status(200).type("application/xml").send(xml);
  } catch (error) {
    console.error("Public business sitemap threw:", error);
    return res.status(500).type("text/plain").send("Sitemap unavailable");
  }
}
