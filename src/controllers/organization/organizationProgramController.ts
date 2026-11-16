import { Request, Response } from "express";
import { config } from "../../config/env.ts";
import { supabase } from "../../config/supabase.ts";
import { normalizeFields } from "./programFormUtils.ts";

const UUID = /^[0-9a-f-]{36}$/i;

function formPayload(body: any) {
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 2000) : "";
  const fields = normalizeFields(body?.fields);
  const status = ["draft", "published", "archived"].includes(body?.status) ? body.status : null;
  let dueAt: string | null = null;
  if (body?.dueAt) {
    const parsed = new Date(body.dueAt);
    if (Number.isNaN(parsed.getTime())) return null;
    dueAt = parsed.toISOString();
  }
  if (!title || !fields || !status) return null;
  return { title, description, fields, status, due_at: dueAt };
}

export const listOrganizationForms = async (req: Request, res: Response) => {
  const { data: forms, error } = await supabase.from("pitchnest_org_submission_forms")
    .select("id, title, description, fields, status, due_at, created_at, updated_at")
    .eq("organization_id", req.organization!.id).order("updated_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: "Could not load organization forms." });
  const formIds = (forms ?? []).map((form) => form.id);
  const counts = new Map<string, { total: number; pending: number }>();
  if (formIds.length) {
    const { data: submissions, error: submissionError } = await supabase.from("pitchnest_org_submissions")
      .select("form_id, status").eq("organization_id", req.organization!.id).in("form_id", formIds).neq("status", "draft");
    if (submissionError) return res.status(500).json({ error: "Could not load form submission counts." });
    for (const submission of submissions ?? []) {
      const item = counts.get(submission.form_id) ?? { total: 0, pending: 0 };
      item.total += 1;
      if (submission.status === "submitted") item.pending += 1;
      counts.set(submission.form_id, item);
    }
  }
  return res.json({ data: { forms: (forms ?? []).map((form) => ({ ...form, ...(counts.get(form.id) ?? { total: 0, pending: 0 }) })) } });
};

export const createOrganizationForm = async (req: Request, res: Response) => {
  const payload = formPayload(req.body);
  if (!payload) return res.status(400).json({ error: "Add a title, at least one valid field, and a form status." });
  const { data, error } = await supabase.from("pitchnest_org_submission_forms").insert({
    ...payload,
    organization_id: req.organization!.id,
    created_by: req.organization!.memberId ?? null,
  }).select("id, title, description, fields, status, due_at, created_at, updated_at").single();
  if (error || !data) return res.status(500).json({ error: "Could not create this form." });
  return res.status(201).json({ data: { form: { ...data, total: 0, pending: 0 } } });
};

export const updateOrganizationForm = async (req: Request, res: Response) => {
  const formId = String(req.params.formId || "");
  if (!UUID.test(formId)) return res.status(400).json({ error: "Invalid form." });
  const payload = formPayload(req.body);
  if (!payload) return res.status(400).json({ error: "Add a title, at least one valid field, and a form status." });
  const { data, error } = await supabase.from("pitchnest_org_submission_forms").update({
    ...payload,
    updated_at: new Date().toISOString(),
  }).eq("id", formId).eq("organization_id", req.organization!.id)
    .select("id, title, description, fields, status, due_at, created_at, updated_at").maybeSingle();
  if (error) return res.status(500).json({ error: "Could not update this form." });
  if (!data) return res.status(404).json({ error: "Form not found." });
  return res.json({ data: { form: data } });
};

export const listOrganizationFormSubmissions = async (req: Request, res: Response) => {
  const formId = String(req.params.formId || "");
  if (!UUID.test(formId)) return res.status(400).json({ error: "Invalid form." });
  const { data: form, error: formError } = await supabase.from("pitchnest_org_submission_forms")
    .select("id, title, fields").eq("id", formId).eq("organization_id", req.organization!.id).maybeSingle();
  if (formError) return res.status(500).json({ error: "Could not load this form." });
  if (!form) return res.status(404).json({ error: "Form not found." });
  const { data: submissions, error } = await supabase.from("pitchnest_org_submissions")
    .select("id, user_id, form_snapshot, answers, status, submitted_at, reviewed_at, reviewer_feedback")
    .eq("organization_id", req.organization!.id).eq("form_id", formId).neq("status", "draft")
    .order("submitted_at", { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: "Could not load form submissions." });
  const userIds = [...new Set((submissions ?? []).map((item) => item.user_id))];
  const { data: users, error: usersError } = userIds.length
    ? await supabase.from("users").select("id, name, email, avatar_url").in("id", userIds)
    : { data: [], error: null };
  if (usersError) return res.status(500).json({ error: "Could not load founder details." });
  const usersById = new Map((users ?? []).map((user) => [user.id, user]));
  return res.json({ data: { submissions: (submissions ?? []).map((item) => ({
    id: item.id,
    founder: usersById.get(item.user_id) ?? { id: item.user_id, name: "Founder", email: "" },
    title: (item.form_snapshot as any)?.title || form.title,
    fields: (item.form_snapshot as any)?.fields || form.fields,
    answers: item.answers,
    status: item.status,
    submittedAt: item.submitted_at,
    reviewedAt: item.reviewed_at,
    reviewerFeedback: item.reviewer_feedback,
  })) } });
};

export const reviewOrganizationSubmission = async (req: Request, res: Response) => {
  const submissionId = String(req.params.submissionId || "");
  if (!UUID.test(submissionId)) return res.status(400).json({ error: "Invalid submission." });
  const feedback = typeof req.body?.feedback === "string" ? req.body.feedback.trim().slice(0, 5000) : "";
  const { data, error } = await supabase.from("pitchnest_org_submissions").update({
    status: "reviewed",
    reviewer_feedback: feedback || null,
    reviewed_by: req.organization!.memberId ?? null,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", submissionId).eq("organization_id", req.organization!.id).in("status", ["submitted", "reviewed"])
    .select("id, status, reviewer_feedback, reviewed_at").maybeSingle();
  if (error) return res.status(500).json({ error: "Could not save review." });
  if (!data) return res.status(404).json({ error: "Submission not found." });
  return res.json({ data: { submission: {
    id: data.id,
    status: data.status,
    reviewerFeedback: data.reviewer_feedback,
    reviewedAt: data.reviewed_at,
  } } });
};

export const organizationSubmissionFileUrl = async (req: Request, res: Response) => {
  const { submissionId, fileId } = req.params;
  if (!UUID.test(submissionId) || !UUID.test(fileId)) return res.status(400).json({ error: "Invalid file." });
  const { data: file, error } = await supabase.from("pitchnest_org_submission_files")
    .select("object_path, original_name").eq("id", fileId).eq("submission_id", submissionId)
    .eq("organization_id", req.organization!.id).maybeSingle();
  if (error) return res.status(500).json({ error: "Could not load this file." });
  if (!file) return res.status(404).json({ error: "File not found." });
  const { data: submission, error: submissionError } = await supabase.from("pitchnest_org_submissions")
    .select("id").eq("id", submissionId).eq("organization_id", req.organization!.id).neq("status", "draft").maybeSingle();
  if (submissionError) return res.status(500).json({ error: "Could not check submission access." });
  if (!submission) return res.status(404).json({ error: "Submission not found." });
  const { data: signed, error: signedError } = await supabase.storage.from(config.storageBucket)
    .createSignedUrl(file.object_path, 300, { download: file.original_name });
  if (signedError || !signed?.signedUrl) return res.status(502).json({ error: "Could not prepare the file download." });
  return res.json({ data: { url: signed.signedUrl } });
};

export const deleteOrganizationForm = async (req: Request, res: Response) => {
  const formId = String(req.params.formId || "");
  if (!UUID.test(formId)) return res.status(400).json({ error: "Invalid form." });
  const { data, error } = await supabase.from("pitchnest_org_submission_forms").update({
    status: "archived", updated_at: new Date().toISOString(),
  }).eq("id", formId).eq("organization_id", req.organization!.id).select("id").maybeSingle();
  if (error) return res.status(500).json({ error: "Could not archive this form." });
  if (!data) return res.status(404).json({ error: "Form not found." });
  return res.status(204).send();
};
