import crypto from "crypto";
import { Request, Response } from "express";
import { config } from "../../config/env.ts";
import { supabase } from "../../config/supabase.ts";
import { normalizeFields, validateAnswers } from "./programFormUtils.ts";

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function activeMembership(userId: number, organizationId: number) {
  return supabase.from("pitchnest_org_founder_memberships")
    .select("id, organization_id, user_id, status, cohort, joined_at")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();
}

export const listFounderPrograms = async (req: Request, res: Response) => {
  const { data: memberships, error } = await supabase.from("pitchnest_org_founder_memberships")
    .select("id, organization_id, status, cohort, joined_at")
    .eq("user_id", req.user!.id)
    .eq("status", "active")
    .order("joined_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Could not load your programs." });
  const organizationIds = [...new Set((memberships ?? []).map((item) => item.organization_id))];
  if (!organizationIds.length) return res.json({ data: { programs: [] } });
  const [{ data: organizations, error: orgError }, { data: forms, error: formsError }] = await Promise.all([
    supabase.from("Organizations").select("id, org_code, org_name, website_url").in("id", organizationIds),
    supabase.from("pitchnest_org_submission_forms").select("id, organization_id, title, description, due_at, updated_at")
      .in("organization_id", organizationIds).eq("status", "published").order("updated_at", { ascending: false }),
  ]);
  if (orgError || formsError) return res.status(500).json({ error: "Could not load your program details." });
  const organizationById = new Map((organizations ?? []).map((item) => [item.id, item]));
  const formsByOrganization = new Map<number, any[]>();
  for (const form of forms ?? []) formsByOrganization.set(form.organization_id, [...(formsByOrganization.get(form.organization_id) ?? []), form]);
  return res.json({ data: { programs: (memberships ?? []).flatMap((membership) => {
    const organization = organizationById.get(membership.organization_id);
    if (!organization) return [];
    return [{
      membershipId: membership.id,
      organizationId: organization.id,
      orgCode: String(organization.org_code),
      organizationName: organization.org_name || "Organization",
      websiteUrl: organization.website_url || "",
      cohort: membership.cohort,
      joinedAt: membership.joined_at,
      forms: formsByOrganization.get(organization.id) ?? [],
    }];
  }) } });
};
export const listFounderProgramForms = async (req: Request, res: Response) => {
  const organizationId = positiveId(req.params.organizationId);
  if (!organizationId) return res.status(400).json({ error: "Invalid organization." });
  const { data: membership, error: membershipError } = await activeMembership(req.user!.id, organizationId);
  if (membershipError) return res.status(500).json({ error: "Could not check program membership." });
  if (!membership) return res.status(403).json({ error: "You do not belong to this program." });
  const { data: forms, error } = await supabase.from("pitchnest_org_submission_forms")
    .select("id, title, description, fields, due_at, updated_at")
    .eq("organization_id", organizationId).eq("status", "published").order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Could not load program forms." });
  return res.json({ data: { forms: forms ?? [] } });
};

export const createFounderSubmissionDraft = async (req: Request, res: Response) => {
  const organizationId = positiveId(req.params.organizationId);
  const formId = String(req.params.formId || "");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(formId)) return res.status(400).json({ error: "Invalid form." });
  const { data: membership, error: membershipError } = await activeMembership(req.user!.id, organizationId);
  if (membershipError) return res.status(500).json({ error: "Could not check program membership." });
  if (!membership) return res.status(403).json({ error: "You do not belong to this program." });
  const { data: form, error: formError } = await supabase.from("pitchnest_org_submission_forms")
    .select("id, organization_id, title, description, fields, due_at")
    .eq("id", formId).eq("organization_id", organizationId).eq("status", "published").maybeSingle();
  if (formError) return res.status(500).json({ error: "Could not load this form." });
  if (!form) return res.status(404).json({ error: "This form is no longer available." });
  if (form.due_at && new Date(form.due_at).getTime() < Date.now()) return res.status(409).json({ error: "The submission deadline has passed." });
  const fields = normalizeFields(form.fields);
  if (!fields) return res.status(409).json({ error: "This form is not configured correctly. Contact the organization." });
  const { data: submission, error } = await supabase.from("pitchnest_org_submissions").insert({
    organization_id: organizationId,
    form_id: form.id,
    membership_id: membership.id,
    user_id: req.user!.id,
    form_snapshot: { id: form.id, title: form.title, fields },
    answers: {},
    status: "draft",
  }).select("id").single();
  if (error || !submission) return res.status(500).json({ error: "Could not start your submission." });
  return res.status(201).json({ data: { submissionId: submission.id } });
};

export const uploadFounderSubmissionFile = async (req: Request, res: Response) => {
  const organizationId = positiveId(req.params.organizationId);
  const submissionId = String(req.params.submissionId || "");
  const fieldId = String(req.body?.fieldId || "");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(submissionId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(fieldId)) {
    return res.status(400).json({ error: "Invalid submission file request." });
  }
  if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
  const { data: membership, error: membershipError } = await activeMembership(req.user!.id, organizationId);
  if (membershipError) return res.status(500).json({ error: "Could not check program membership." });
  if (!membership) return res.status(403).json({ error: "You do not belong to this program." });
  const { data: submission, error } = await supabase.from("pitchnest_org_submissions")
    .select("id, form_id, form_snapshot, status")
    .eq("id", submissionId).eq("organization_id", organizationId).eq("membership_id", membership.id).eq("user_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: "Could not check this submission." });
  if (!submission || submission.status !== "draft") return res.status(404).json({ error: "Draft submission not found." });
  const fields = normalizeFields((submission.form_snapshot as any)?.fields);
  const field = fields?.find((item) => item.id === fieldId);
  if (!field || field.type !== "file") return res.status(400).json({ error: "This form field does not accept a file." });

  const safeName = req.file.originalname.replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "attachment";
  const objectPath = `org-submissions/${organizationId}/${req.user!.id}/${submissionId}/${crypto.randomUUID()}`;
  const { error: storageError } = await supabase.storage.from(config.storageBucket).upload(objectPath, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false,
  });
  if (storageError) return res.status(502).json({ error: "File storage is temporarily unavailable." });
  const { data: file, error: insertError } = await supabase.from("pitchnest_org_submission_files").insert({
    organization_id: organizationId,
    submission_id: submissionId,
    field_id: fieldId,
    object_path: objectPath,
    original_name: safeName,
    content_type: req.file.mimetype,
    size_bytes: req.file.size,
  }).select("id, original_name").single();
  if (insertError || !file) {
    await supabase.storage.from(config.storageBucket).remove([objectPath]);
    return res.status(500).json({ error: "Could not attach this file to your submission." });
  }
  return res.status(201).json({ data: { fileId: file.id, fileName: file.original_name } });
};

export const submitFounderSubmission = async (req: Request, res: Response) => {
  const organizationId = positiveId(req.params.organizationId);
  const submissionId = String(req.params.submissionId || "");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(submissionId)) return res.status(400).json({ error: "Invalid submission." });
  const { data: membership, error: membershipError } = await activeMembership(req.user!.id, organizationId);
  if (membershipError) return res.status(500).json({ error: "Could not check program membership." });
  if (!membership) return res.status(403).json({ error: "You do not belong to this program." });
  const { data: submission, error } = await supabase.from("pitchnest_org_submissions")
    .select("id, form_id, form_snapshot, status")
    .eq("id", submissionId).eq("organization_id", organizationId).eq("membership_id", membership.id).eq("user_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: "Could not load this submission." });
  if (!submission || submission.status !== "draft") return res.status(404).json({ error: "Draft submission not found." });
  const fields = normalizeFields((submission.form_snapshot as any)?.fields);
  if (!fields) return res.status(409).json({ error: "This form is not configured correctly." });
  const answers = validateAnswers(fields, req.body?.answers);
  if (!answers) return res.status(400).json({ error: "Complete each required field and check the values you entered." });
  const fileFields = fields.filter((field) => field.type === "file" && typeof answers[field.id] === "string");
  for (const field of fileFields) {
    const { data: file, error: fileError } = await supabase.from("pitchnest_org_submission_files")
      .select("id").eq("id", answers[field.id]).eq("organization_id", organizationId)
      .eq("submission_id", submissionId).eq("field_id", field.id).maybeSingle();
    if (fileError || !file) return res.status(400).json({ error: `Upload a file for ${field.label}.` });
  }
  const { data: publishedForm, error: formError } = await supabase.from("pitchnest_org_submission_forms")
    .select("id, due_at, status").eq("id", submission.form_id).eq("organization_id", organizationId).maybeSingle();
  if (formError) return res.status(500).json({ error: "Could not check the form deadline." });
  if (!publishedForm || publishedForm.status !== "published") return res.status(409).json({ error: "This form is no longer accepting submissions." });
  if (publishedForm.due_at && new Date(publishedForm.due_at).getTime() < Date.now()) return res.status(409).json({ error: "The submission deadline has passed." });
  const { data: updated, error: updateError } = await supabase.from("pitchnest_org_submissions").update({
    answers,
    status: "submitted",
    submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", submissionId).eq("organization_id", organizationId).eq("membership_id", membership.id)
    .eq("user_id", req.user!.id).eq("status", "draft").select("id").maybeSingle();
  if (updateError) return res.status(500).json({ error: "Could not submit your answers." });
  if (!updated) return res.status(409).json({ error: "This draft changed before it could be submitted. Refresh and try again." });
  return res.json({ data: { submitted: true, submittedAt: new Date().toISOString() } });
};

export const listFounderSubmissions = async (req: Request, res: Response) => {
  const organizationId = positiveId(req.params.organizationId);
  if (!organizationId) return res.status(400).json({ error: "Invalid organization." });
  const { data: membership, error: membershipError } = await activeMembership(req.user!.id, organizationId);
  if (membershipError) return res.status(500).json({ error: "Could not check program membership." });
  if (!membership) return res.status(403).json({ error: "You do not belong to this program." });
  const { data, error } = await supabase.from("pitchnest_org_submissions")
    .select("id, form_id, form_snapshot, status, submitted_at, updated_at, reviewer_feedback")
    .eq("organization_id", organizationId).eq("membership_id", membership.id).neq("status", "draft")
    .order("submitted_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: "Could not load your submissions." });
  return res.json({ data: { submissions: (data ?? []).map((item) => ({
    id: item.id,
    formId: item.form_id,
    formTitle: (item.form_snapshot as any)?.title || "Program form",
    status: item.status,
    submittedAt: item.submitted_at,
    updatedAt: item.updated_at,
    reviewerFeedback: item.reviewer_feedback,
  })) } });
};

export const founderSubmissionFileUrl = async (req: Request, res: Response) => {
  const organizationId = positiveId(req.params.organizationId);
  const { submissionId, fileId } = req.params;
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(submissionId) || !/^[0-9a-f-]{36}$/i.test(fileId)) {
    return res.status(400).json({ error: "Invalid file request." });
  }
  const { data: membership, error: membershipError } = await activeMembership(req.user!.id, organizationId);
  if (membershipError) return res.status(500).json({ error: "Could not check program membership." });
  if (!membership) return res.status(403).json({ error: "You do not belong to this program." });
  const { data: file, error } = await supabase.from("pitchnest_org_submission_files")
    .select("object_path, original_name").eq("id", fileId).eq("submission_id", submissionId).eq("organization_id", organizationId).maybeSingle();
  if (error) return res.status(500).json({ error: "Could not load this file." });
  if (!file) return res.status(404).json({ error: "File not found." });
  const { data: submission } = await supabase.from("pitchnest_org_submissions").select("id")
    .eq("id", submissionId).eq("membership_id", membership.id).eq("user_id", req.user!.id).maybeSingle();
  if (!submission) return res.status(403).json({ error: "You cannot access this file." });
  const { data: signed, error: signedError } = await supabase.storage.from(config.storageBucket).createSignedUrl(file.object_path, 300, { download: file.original_name });
  if (signedError || !signed?.signedUrl) return res.status(502).json({ error: "Could not prepare the file download." });
  return res.json({ data: { url: signed.signedUrl } });
};
