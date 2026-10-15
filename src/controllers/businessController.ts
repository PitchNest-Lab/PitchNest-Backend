import crypto from "node:crypto";
import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { logEvent } from "../services/eventService.ts";
import {
  MediaError,
  PUBLIC_TITLE_MAX,
  deleteDraftMedia,
  isMediaKind,
  loadPublicTeam,
  mediaObjectPath,
  processBusinessImage,
  publishMedia,
  removePublicMedia,
  signDraftMedia,
  storeDraftMedia,
} from "../services/businessMediaService.ts";
import { ensureFounderHandle, handlesForUsers } from "../services/founderService.ts";

export const BUSINESS_TYPES = [
  "software",
  "services",
  "physical",
  "traditional",
  "other",
] as const;
export const BUSINESS_PUBLICATION_CONSENT_VERSION = "business-publication-v1";

type BusinessType = (typeof BUSINESS_TYPES)[number];

const FIELD_SPECS = {
  name: { column: "name", max: 120 },
  tagline: { column: "tagline", max: 180 },
  description: { column: "description", max: 3000 },
  industry: { column: "industry", max: 100 },
  stage: { column: "stage", max: 80 },
  region: { column: "region", max: 120 },
  problem: { column: "problem", max: 1500 },
  solution: { column: "solution", max: 1500 },
  targetCustomer: { column: "target_customer", max: 800 },
  websiteUrl: { column: "website_url", max: 500 },
} as const;

const BUSINESS_COLUMNS = [
  "id",
  "slug",
  "name",
  "tagline",
  "description",
  "business_type",
  "industry",
  "stage",
  "region",
  "problem",
  "solution",
  "target_customer",
  "website_url",
  "logo_file",
  "cover_file",
  "status",
  "profile_version",
  "published_at",
  "unpublished_at",
  "created_at",
  "updated_at",
].join(", ");

export interface BusinessValidationResult {
  values: Record<string, string | null>;
  errors: string[];
}

export interface LegacyBusinessDraftResult {
  available: boolean;
  draft: {
    name: string;
    businessType: BusinessType;
    tagline: string;
    description: string;
    industry: string;
    stage: string;
    region: string;
    problem: string;
    solution: string;
    targetCustomer: string;
    websiteUrl: string;
  } | null;
}

function cleanLegacyText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * Legacy onboarding was designed for practice setup, not public profiles. Copy
 * only fields whose meaning is unchanged. In particular, the old `goal` value
 * is a practice preference and must never become a public description.
 */
export function legacyProfileToBusinessDraft(row: unknown): LegacyBusinessDraftResult {
  const profile = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const name = cleanLegacyText(profile.startup_name, 120);
  if (name.length < 2) return { available: false, draft: null };

  const industry = cleanLegacyText(profile.industry, 100);
  const stage = cleanLegacyText(profile.funding_stage, 80);
  const businessType: BusinessType = /\bsaas\b|\bsoftware\b/i.test(industry)
    ? "software"
    : "other";

  return {
    available: true,
    draft: {
      name,
      businessType,
      tagline: "",
      description: "",
      industry,
      stage,
      region: "",
      problem: "",
      solution: "",
      targetCustomer: "",
      websiteUrl: "",
    },
  };
}

export function validateBusinessInput(
  input: unknown,
  options: { partial?: boolean } = {},
): BusinessValidationResult {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const values: Record<string, string | null> = {};
  const errors: string[] = [];

  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === "") {
      values[spec.column] = null;
      continue;
    }
    if (typeof raw !== "string") {
      errors.push(`${field} must be text.`);
      continue;
    }
    const clean = raw.trim();
    if (clean.length > spec.max) {
      errors.push(`${field} is too long (max ${spec.max} characters).`);
      continue;
    }
    values[spec.column] = clean || null;
  }

  if ("businessType" in body) {
    if (
      typeof body.businessType !== "string" ||
      !BUSINESS_TYPES.includes(body.businessType as BusinessType)
    ) {
      errors.push(`businessType must be one of: ${BUSINESS_TYPES.join(", ")}.`);
    } else {
      values.business_type = body.businessType;
    }
  }

  if (!options.partial) {
    if (typeof values.name !== "string" || values.name.length < 2) {
      errors.push("name must be at least 2 characters.");
    }
    if (!values.business_type) {
      errors.push("businessType is required.");
    }
  } else if ("name" in values && (values.name?.length ?? 0) < 2) {
    errors.push("name must be at least 2 characters.");
  }

  if (typeof values.website_url === "string") {
    try {
      const parsed = new URL(values.website_url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        errors.push("websiteUrl must use http or https.");
      }
    } catch {
      errors.push("websiteUrl must be a valid URL.");
    }
  }

  return { values, errors: [...new Set(errors)] };
}

export function slugifyBusinessName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return slug || "business";
}

type DraftMediaUrls = { logoUrl: string | null; coverUrl: string | null };

export function toPrivateBusiness(row: any, membershipRole?: string, media?: DraftMediaUrls) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline ?? "",
    description: row.description ?? "",
    businessType: row.business_type,
    industry: row.industry ?? "",
    stage: row.stage ?? "",
    region: row.region ?? "",
    problem: row.problem ?? "",
    solution: row.solution ?? "",
    targetCustomer: row.target_customer ?? "",
    websiteUrl: row.website_url ?? "",
    // Signed, short-lived URLs of the private drafts; never public URLs.
    logoUrl: media?.logoUrl ?? null,
    coverUrl: media?.coverUrl ?? null,
    status: row.status,
    profileVersion: row.profile_version,
    publishedAt: row.published_at ?? null,
    unpublishedAt: row.unpublished_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(membershipRole ? { membershipRole } : {}),
  };
}

export function toPublicBusinessPreview(row: any) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline ?? "",
    description: row.description ?? "",
    businessType: row.business_type,
    industry: row.industry ?? "",
    stage: row.stage ?? "",
    region: row.region ?? "",
    problem: row.problem ?? "",
    solution: row.solution ?? "",
    targetCustomer: row.target_customer ?? "",
    websiteUrl: row.website_url ?? "",
  };
}

export function publicationBlockers(row: any): string[] {
  const required: Array<[string, unknown]> = [
    ["tagline", row.tagline],
    ["description", row.description],
    ["industry", row.industry],
    ["stage", row.stage],
    ["region", row.region],
  ];
  return required
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([field]) => field);
}

async function fetchBusiness(businessId: string) {
  const result = await supabase
    .from("businesses")
    .select(BUSINESS_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();
  return result as { data: any | null; error: any };
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugifyBusinessName(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${crypto.randomBytes(3).toString("hex")}`;
    const candidate = `${base.slice(0, 79 - suffix.length)}${suffix}`;
    const { data, error } = await supabase
      .from("businesses")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error("Unable to allocate a unique business URL.");
}

async function recordAudit(
  businessId: string,
  actorId: number,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  const { error } = await supabase.from("business_audit_log").insert({
    business_id: businessId,
    actor_id: actorId,
    action,
    metadata,
  });
  if (error) console.warn(`Business audit write failed for ${action}:`, error.message);
}

function rpcRow(data: any): any {
  return Array.isArray(data) ? data[0] : data;
}

/** Signed draft-image URLs for business rows, in one storage call. */
async function draftMediaUrls(rows: any[]): Promise<Map<string, DraftMediaUrls>> {
  const paths: string[] = [];
  for (const row of rows) {
    if (row?.logo_file) paths.push(mediaObjectPath(row.id, row.logo_file));
    if (row?.cover_file) paths.push(mediaObjectPath(row.id, row.cover_file));
  }
  const signed = await signDraftMedia(paths);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        logoUrl: row?.logo_file ? signed.get(mediaObjectPath(row.id, row.logo_file)) ?? null : null,
        coverUrl: row?.cover_file ? signed.get(mediaObjectPath(row.id, row.cover_file)) ?? null : null,
      },
    ]),
  );
}

async function privateBusinessResponse(row: any, membershipRole?: string) {
  return toPrivateBusiness(row, membershipRole, (await draftMediaUrls([row])).get(row?.id));
}

export async function createBusiness(req: Request, res: Response) {
  const validation = validateBusinessInput(req.body);
  if (validation.errors.length) {
    return res.status(400).json({ error: validation.errors[0], errors: validation.errors });
  }

  try {
    const slug = await uniqueSlug(validation.values.name as string);
    const { data, error } = await supabase.rpc("create_business_with_owner", {
      p_owner_id: req.user!.id,
      p_slug: slug,
      p_name: validation.values.name,
      p_tagline: validation.values.tagline ?? null,
      p_description: validation.values.description ?? null,
      p_business_type: validation.values.business_type,
      p_industry: validation.values.industry ?? null,
      p_stage: validation.values.stage ?? null,
      p_region: validation.values.region ?? null,
      p_problem: validation.values.problem ?? null,
      p_solution: validation.values.solution ?? null,
      p_target_customer: validation.values.target_customer ?? null,
      p_website_url: validation.values.website_url ?? null,
    });

    const created = rpcRow(data);
    if (error || !created) {
      console.error("Business creation failed:", error);
      return res.status(500).json({ error: "Failed to create business." });
    }
    logEvent("business_draft_created", {
      userId: req.user!.id,
      businessId: created.id,
      properties: { fromOnboarding: req.body?.fromOnboarding === true },
    });
    return res.status(201).json({ data: toPrivateBusiness(created, "owner") });
  } catch (error) {
    console.error("Business creation threw:", error);
    return res.status(500).json({ error: "Failed to create business." });
  }
}

export async function listMyBusinesses(req: Request, res: Response) {
  try {
    const { data: memberships, error: membershipError } = await supabase
      .from("business_members")
      .select("business_id, role, public_display_consent, created_at")
      .eq("user_id", req.user!.id)
      .eq("status", "active")
      .order("created_at", { ascending: false });

    if (membershipError) {
      console.error("Business membership list failed:", membershipError);
      return res.status(500).json({ error: "Failed to load businesses." });
    }
    if (!memberships?.length) return res.json({ data: [] });

    const { data: businesses, error } = await supabase
      .from("businesses")
      .select(BUSINESS_COLUMNS)
      .in("id", memberships.map((membership) => membership.business_id))
      .neq("status", "removed");

    if (error) {
      console.error("Business list failed:", error);
      return res.status(500).json({ error: "Failed to load businesses." });
    }

    const businessRows = (businesses ?? []) as any[];
    const byId = new Map(businessRows.map((business) => [business.id, business]));
    const media = await draftMediaUrls(businessRows);
    const result = memberships.flatMap((membership) => {
      const business = byId.get(membership.business_id);
      return business ? [toPrivateBusiness(business, membership.role, media.get(business.id))] : [];
    });
    return res.json({ data: result });
  } catch (error) {
    console.error("Business list threw:", error);
    return res.status(500).json({ error: "Failed to load businesses." });
  }
}

export async function getLegacyBusinessDraft(req: Request, res: Response) {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("startup_name, industry, funding_stage")
      .eq("user_id", req.user!.id)
      .maybeSingle();

    if (error) {
      console.error("Legacy business draft fetch failed:", error);
      return res.status(500).json({ error: "Failed to load onboarding suggestions." });
    }

    return res.json({ data: legacyProfileToBusinessDraft(data) });
  } catch (error) {
    console.error("Legacy business draft fetch threw:", error);
    return res.status(500).json({ error: "Failed to load onboarding suggestions." });
  }
}

export async function getBusiness(req: Request, res: Response) {
  const { data, error } = await fetchBusiness(req.businessMembership!.businessId);
  if (error) {
    console.error("Business fetch failed:", error);
    return res.status(500).json({ error: "Failed to load business." });
  }
  if (!data || data.status === "removed") {
    return res.status(404).json({ error: "Business not found." });
  }
  return res.json({
    data: await privateBusinessResponse(data, req.businessMembership!.role),
  });
}

export async function updateBusiness(req: Request, res: Response) {
  const validation = validateBusinessInput(req.body, { partial: true });
  if (validation.errors.length) {
    return res.status(400).json({ error: validation.errors[0], errors: validation.errors });
  }
  if (!Object.keys(validation.values).length) {
    return res.status(400).json({ error: "No editable business fields were provided." });
  }

  const businessId = req.businessMembership!.businessId;
  const result = await supabase
    .from("businesses")
    .update(validation.values)
    .eq("id", businessId)
    .neq("status", "removed")
    .select(BUSINESS_COLUMNS)
    .maybeSingle();
  const { data, error } = result as { data: any | null; error: any };

  if (error) {
    console.error("Business update failed:", error);
    return res.status(500).json({ error: "Failed to update business." });
  }
  if (!data) return res.status(404).json({ error: "Business not found." });

  await recordAudit(businessId, req.user!.id, "business.updated", {
    fields: Object.keys(validation.values),
  });
  return res.json({ data: await privateBusinessResponse(data, req.businessMembership!.role) });
}

export async function getPublicationPreview(req: Request, res: Response) {
  const { data, error } = await fetchBusiness(req.businessMembership!.businessId);
  if (error) return res.status(500).json({ error: "Failed to build preview." });
  if (!data || data.status === "removed") {
    return res.status(404).json({ error: "Business not found." });
  }
  const blockers = publicationBlockers(data);
  const [media, team] = await Promise.all([
    draftMediaUrls([data]).then((urls) => urls.get(data.id)),
    loadPublicTeam(data.id),
  ]);
  return res.json({
    data: {
      // Images are what publishing will make public; the team is shown as it
      // will appear, but each member controls their own place on it.
      preview: {
        ...toPublicBusinessPreview(data),
        logoUrl: media?.logoUrl ?? null,
        coverUrl: media?.coverUrl ?? null,
        team,
      },
      profileVersion: data.profile_version,
      consentVersion: BUSINESS_PUBLICATION_CONSENT_VERSION,
      canPublish: blockers.length === 0 && !["hidden", "removed"].includes(data.status),
      blockers,
    },
  });
}

export async function publishBusiness(req: Request, res: Response) {
  const profileVersion = Number(req.body?.profileVersion);
  if (
    req.body?.confirmed !== true ||
    req.body?.consentVersion !== BUSINESS_PUBLICATION_CONSENT_VERSION ||
    !Number.isInteger(profileVersion) ||
    profileVersion < 1
  ) {
    return res.status(400).json({
      error: "Review the current preview and explicitly confirm publication.",
    });
  }

  const { data, error } = await supabase.rpc("publish_business", {
    p_business_id: req.businessMembership!.businessId,
    p_actor_id: req.user!.id,
    p_expected_profile_version: profileVersion,
    p_consent_version: BUSINESS_PUBLICATION_CONSENT_VERSION,
  });

  if (error) {
    if (error.code === "40001") {
      return res.status(409).json({ error: "Business changed after preview. Review it again." });
    }
    if (error.code === "23514") {
      return res.status(422).json({ error: error.message || "Business is not publishable." });
    }
    console.error("Business publication failed:", error);
    return res.status(500).json({ error: "Failed to publish business." });
  }

  const business = rpcRow(data);
  // Copy the approved images to public storage and drop superseded ones. The
  // profile is already live; a failure here only leaves images missing.
  const imagesPublished = await publishMedia(req.businessMembership!.businessId, [
    business?.logo_file,
    business?.cover_file,
  ]);
  logEvent("business_published", {
    userId: req.user!.id,
    businessId: req.businessMembership!.businessId,
  });
  return res.json({
    data: await privateBusinessResponse(business, req.businessMembership!.role),
    ...(imagesPublished
      ? {}
      : { warning: "Your profile is live, but its images could not be published. Publish again to retry." }),
  });
}

export async function unpublishBusiness(req: Request, res: Response) {
  const businessId = req.businessMembership!.businessId;
  // Public object URLs are durable capabilities. Remove them before changing
  // database state so a failed storage call cannot leave withdrawn media live.
  if (!(await removePublicMedia(businessId))) {
    return res.status(503).json({ error: "Could not remove public images. Please retry." });
  }
  const { data, error } = await supabase.rpc("unpublish_business", {
    p_business_id: businessId,
    p_actor_id: req.user!.id,
  });
  if (error) {
    console.error("Business unpublish failed:", error);
    return res.status(500).json({ error: "Failed to unpublish business." });
  }
  logEvent("business_unpublished", {
    userId: req.user!.id,
    businessId: req.businessMembership!.businessId,
  });
  return res.json({
    data: await privateBusinessResponse(rpcRow(data), req.businessMembership!.role),
  });
}

export async function archiveBusiness(req: Request, res: Response) {
  const businessId = req.businessMembership!.businessId;
  if (!(await removePublicMedia(businessId))) {
    return res.status(503).json({ error: "Could not remove public images. Please retry." });
  }
  const { error } = await supabase.rpc("archive_business", {
    p_business_id: businessId,
    p_actor_id: req.user!.id,
  });
  if (error) {
    console.error("Business archive failed:", error);
    return res.status(500).json({ error: "Failed to archive business." });
  }
  return res.status(204).send();
}

const MEDIA_COLUMNS = { logo: "logo_file", cover: "cover_file" } as const;

/**
 * PUT /api/businesses/:id/media/:kind — replace the logo or cover DRAFT. The
 * public profile changes only when the business is published again (the image
 * change bumps profile_version, so the next publish previews it).
 */
export async function uploadBusinessMedia(req: Request, res: Response) {
  const kind = req.params.kind;
  if (!isMediaKind(kind)) return res.status(404).json({ error: "Unknown image type." });
  if (!req.file?.buffer?.length) return res.status(400).json({ error: "Choose an image to upload." });

  const businessId = req.businessMembership!.businessId;
  let processed: { file: string; buffer: Buffer };
  try {
    processed = await processBusinessImage(kind, req.file.buffer);
  } catch (error) {
    if (error instanceof MediaError) return res.status(error.status).json({ error: error.message });
    console.error("Business image processing failed:", error);
    return res.status(500).json({ error: "Failed to process the image." });
  }

  const { data: current, error: currentError } = await fetchBusiness(businessId);
  if (currentError) return res.status(500).json({ error: "Failed to save the image." });
  if (!current || current.status === "removed") return res.status(404).json({ error: "Business not found." });

  try {
    await storeDraftMedia(businessId, processed.file, processed.buffer);
  } catch (error) {
    console.error("Business image upload failed:", error);
    return res.status(500).json({ error: "Failed to save the image." });
  }

  const column = MEDIA_COLUMNS[kind];
  const result = await supabase
    .from("businesses")
    .update({ [column]: processed.file })
    .eq("id", businessId)
    .neq("status", "removed")
    .select(BUSINESS_COLUMNS)
    .maybeSingle();
  const { data, error } = result as { data: any | null; error: any };
  if (error || !data) {
    console.error("Business image update failed:", error);
    if (current[column] !== processed.file) await deleteDraftMedia(businessId, processed.file);
    return res.status(500).json({ error: "Failed to save the image." });
  }
  if (current[column] && current[column] !== processed.file) {
    await deleteDraftMedia(businessId, current[column]);
  }

  await recordAudit(businessId, req.user!.id, "business.media.updated", { kind });
  return res.json({ data: await privateBusinessResponse(data, req.businessMembership!.role) });
}

/** DELETE /api/businesses/:id/media/:kind — remove the logo or cover draft. */
export async function removeBusinessMedia(req: Request, res: Response) {
  const kind = req.params.kind;
  if (!isMediaKind(kind)) return res.status(404).json({ error: "Unknown image type." });
  const businessId = req.businessMembership!.businessId;
  const column = MEDIA_COLUMNS[kind];

  const { data: current, error: currentError } = await fetchBusiness(businessId);
  if (currentError) return res.status(500).json({ error: "Failed to remove the image." });
  if (!current || current.status === "removed") return res.status(404).json({ error: "Business not found." });

  const result = await supabase
    .from("businesses")
    .update({ [column]: null })
    .eq("id", businessId)
    .neq("status", "removed")
    .select(BUSINESS_COLUMNS)
    .maybeSingle();
  const { data, error } = result as { data: any | null; error: any };
  if (error || !data) {
    console.error("Business image removal failed:", error);
    return res.status(500).json({ error: "Failed to remove the image." });
  }
  await deleteDraftMedia(businessId, current[column]);
  await recordAudit(businessId, req.user!.id, "business.media.removed", { kind });
  return res.json({ data: await privateBusinessResponse(data, req.businessMembership!.role) });
}

function cleanPublicTitle(value: unknown): { title?: string | null; error?: string } {
  if (value === undefined) return {};
  if (value === null || value === "") return { title: null };
  if (typeof value !== "string") return { error: "title must be text." };
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > PUBLIC_TITLE_MAX) return { error: `title is too long (max ${PUBLIC_TITLE_MAX} characters).` };
  return { title: clean || null };
}

/**
 * PUT /api/businesses/:id/members/me/public-profile — the caller's OWN choice
 * to appear on the public profile, and their public title. No one can make
 * another member public.
 */
export async function updateMyPublicProfile(req: Request, res: Response) {
  const consent = req.body?.consent;
  if (typeof consent !== "boolean") {
    return res.status(400).json({ error: "consent must be true or false." });
  }
  const { title, error: titleError } = cleanPublicTitle(req.body?.title);
  if (titleError) return res.status(400).json({ error: titleError });

  const businessId = req.businessMembership!.businessId;
  const update: Record<string, unknown> = {
    public_display_consent: consent,
    updated_at: new Date().toISOString(),
  };
  if (title !== undefined) update.public_title = title;

  const { data, error } = await supabase
    .from("business_members")
    .update(update)
    .eq("business_id", businessId)
    .eq("user_id", req.user!.id)
    .eq("status", "active")
    .select("public_display_consent, public_title")
    .maybeSingle();
  if (error) {
    console.error("Public profile preference update failed:", error);
    return res.status(500).json({ error: "Failed to save your preference." });
  }
  if (!data) return res.status(404).json({ error: "Membership not found." });

  await recordAudit(
    businessId,
    req.user!.id,
    consent ? "member.public_display.granted" : "member.public_display.withdrawn",
  );

  // A public member gets a founder page; the handle is created on first consent.
  let founderHandle: string | null = null;
  if (consent) {
    const { data: user } = await supabase.from("users").select("name").eq("id", req.user!.id).maybeSingle();
    founderHandle = await ensureFounderHandle(req.user!.id, (user as any)?.name);
  }
  return res.json({
    data: {
      publicDisplayConsent: (data as any).public_display_consent === true,
      publicTitle: (data as any).public_title ?? "",
      founderHandle,
    },
  });
}

export async function listBusinessMembers(req: Request, res: Response) {
  const businessId = req.businessMembership!.businessId;
  const { data: memberships, error } = await supabase
    .from("business_members")
    .select("user_id, role, status, public_display_consent, public_title, joined_at, created_at")
    .eq("business_id", businessId)
    .neq("status", "removed")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Business member list failed:", error);
    return res.status(500).json({ error: "Failed to load business members." });
  }
  if (!memberships?.length) return res.json({ data: [] });

  const { data: users, error: userError } = await supabase
    .from("users")
    .select("id, name, email, avatar_url")
    .in("id", memberships.map((membership) => membership.user_id));
  if (userError) {
    console.error("Business member identities failed:", userError);
    return res.status(500).json({ error: "Failed to load business members." });
  }

  const maySeeEmail = ["owner", "admin"].includes(req.businessMembership!.role);
  const usersById = new Map((users ?? []).map((user) => [user.id, user]));
  // Handles are public for consenting members only, so only theirs are listed.
  const handles = await handlesForUsers(
    memberships.filter((m) => m.public_display_consent === true).map((m) => m.user_id),
  );
  return res.json({
    data: memberships.map((membership) => {
      const user = usersById.get(membership.user_id);
      return {
        userId: membership.user_id,
        name: user?.name ?? "Member",
        avatarUrl: user?.avatar_url ?? null,
        ...(maySeeEmail ? { email: user?.email ?? null } : {}),
        role: membership.role,
        status: membership.status,
        publicDisplayConsent: membership.public_display_consent === true,
        publicTitle: (membership as any).public_title ?? "",
        founderHandle: membership.public_display_consent === true ? handles.get(membership.user_id) ?? null : null,
        joinedAt: membership.joined_at ?? null,
      };
    }),
  });
}
