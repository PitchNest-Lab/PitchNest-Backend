import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { computeOverallScore } from "../services/aiService.ts";
import {
  PRACTICE_DRAFT_TTL_MS,
  buildPracticeContext,
  cleanPracticeQuestion,
  isUuid,
  toPracticeDraftView,
} from "../services/practiceDraftService.ts";
import { normalizeSessionMode } from "../sockets/resumeGrants.ts";
import { logEvent } from "../services/eventService.ts";

/**
 * POST /api/practice/drafts — create a short-lived, single-use bridge from a
 * business the caller belongs to into a private practice session.
 * Body: { businessId, mode?, question? }. The caller is always req.user.
 */
export async function createPracticeDraft(req: Request, res: Response) {
  // The public profile only knows a business by its slug (the UUID is never
  // public), so members practising from there send businessSlug instead.
  // Either way, membership is checked below before anything is created.
  let businessId = req.body?.businessId;
  if (!isUuid(businessId) && typeof req.body?.businessSlug === "string") {
    const slug = req.body.businessSlug.trim().toLowerCase().slice(0, 80);
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      const { data: bySlug } = await supabase.from("businesses").select("id").eq("slug", slug).maybeSingle();
      businessId = (bySlug as any)?.id;
      if (!isUuid(businessId)) return res.status(404).json({ error: "Business not found." });
    }
  }
  if (!isUuid(businessId)) return res.status(400).json({ error: "Choose a business to practise." });

  const rawQuestion = req.body?.question;
  let question = cleanPracticeQuestion(rawQuestion);
  if (typeof rawQuestion === "string" && rawQuestion.trim() && !question) {
    return res.status(400).json({ error: "That question is too short to practise." });
  }

  // "Practise this question" from a public comment: the question text comes
  // from the stored comment, never from the browser, and the comment must be
  // visible and belong to this same business.
  const sourceCommentId = req.body?.sourceCommentId;
  if (sourceCommentId !== undefined && sourceCommentId !== null && !isUuid(sourceCommentId)) {
    return res.status(400).json({ error: "That question can't be practised." });
  }

  try {
    const { data: membership, error: membershipError } = await supabase
      .from("business_members")
      .select("role")
      .eq("business_id", businessId)
      .eq("user_id", req.user!.id)
      .eq("status", "active")
      .maybeSingle();
    if (membershipError) {
      console.error("Practice draft membership check failed:", membershipError);
      return res.status(500).json({ error: "Unable to start practice." });
    }
    // 404 so non-members cannot probe which businesses exist.
    if (!membership) return res.status(404).json({ error: "Business not found." });

    const { data: business, error: businessError } = await supabase
      .from("businesses")
      .select("id, name, tagline, description, industry, stage, status")
      .eq("id", businessId)
      .maybeSingle();
    if (businessError) {
      console.error("Practice draft business read failed:", businessError);
      return res.status(500).json({ error: "Unable to start practice." });
    }
    if (!business || (business as any).status === "removed") {
      return res.status(404).json({ error: "Business not found." });
    }

    if (isUuid(sourceCommentId)) {
      const { data: comment, error: commentError } = await supabase
        .from("business_comments")
        .select("id, body")
        .eq("id", sourceCommentId)
        .eq("business_id", businessId)
        .eq("status", "visible")
        .maybeSingle();
      if (commentError) {
        console.error("Practice draft comment read failed:", commentError);
        return res.status(500).json({ error: "Unable to start practice." });
      }
      if (!comment) return res.status(404).json({ error: "That question is no longer available." });
      question = cleanPracticeQuestion((comment as any).body);
      if (!question) return res.status(400).json({ error: "That comment is too short to practise." });
    }

    const { data: draft, error } = await supabase
      .from("practice_drafts")
      .insert({
        user_id: req.user!.id,
        business_id: businessId,
        mode: normalizeSessionMode(req.body?.mode),
        context_snapshot: buildPracticeContext(business as Record<string, unknown>),
        source_question: question,
        ...(isUuid(sourceCommentId) ? { source_comment_id: sourceCommentId } : {}),
        expires_at: new Date(Date.now() + PRACTICE_DRAFT_TTL_MS).toISOString(),
      })
      .select("id, business_id, mode, context_snapshot, source_question, expires_at")
      .single();
    if (error || !draft) {
      console.error("Practice draft insert failed:", error);
      return res.status(500).json({ error: "Unable to start practice." });
    }
    if (question) {
      logEvent("question_sent_to_practice", {
        userId: req.user!.id,
        businessId,
        properties: { fromComment: isUuid(sourceCommentId) },
      });
    }
    return res.status(201).json({ data: toPracticeDraftView(draft) });
  } catch (error) {
    console.error("Practice draft creation threw:", error);
    return res.status(500).json({ error: "Unable to start practice." });
  }
}

/** GET /api/practice/drafts/:id — the owner's unexpired, unused draft. */
export async function getPracticeDraft(req: Request, res: Response) {
  const draftId = req.params.id;
  if (!isUuid(draftId)) return res.status(404).json({ error: "Practice draft not found." });
  try {
    const { data, error } = await supabase
      .from("practice_drafts")
      .select("id, business_id, mode, context_snapshot, source_question, expires_at, consumed_at")
      .eq("id", draftId)
      .eq("user_id", req.user!.id)
      .maybeSingle();
    if (error) {
      console.error("Practice draft read failed:", error);
      return res.status(500).json({ error: "Unable to load practice draft." });
    }
    const expired = !data || data.consumed_at || new Date(data.expires_at).getTime() <= Date.now();
    if (expired) {
      return res.status(404).json({ error: "This practice link has expired. Start again from your workspace." });
    }
    res.set("Cache-Control", "private, no-store");
    return res.json({ data: toPracticeDraftView(data) });
  } catch (error) {
    console.error("Practice draft read threw:", error);
    return res.status(500).json({ error: "Unable to load practice draft." });
  }
}

export function toPracticeSessionSummary(row: any) {
  const report = row?.evaluation_report;
  const complete = report?.evaluationStatus === "complete" && report?.scores;
  return {
    id: row.id,
    createdAt: row.created_at ?? row.timestamp ?? null,
    mode: normalizeSessionMode(row.mode),
    attemptNumber: Number.isInteger(row.attempt_number) ? row.attempt_number : null,
    overallScore: complete ? computeOverallScore(report.scores) : null,
  };
}

/**
 * GET /api/businesses/:id/practice-sessions — the CALLER's own private
 * sessions linked to this business. Other members' sessions are never
 * returned: practice stays personal even inside a shared business.
 */
export async function listBusinessPracticeSessions(req: Request, res: Response) {
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, created_at, timestamp, mode, attempt_number, evaluation_report")
      .eq("business_id", req.businessMembership!.businessId)
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      console.error("Business practice sessions read failed:", error);
      return res.status(500).json({ error: "Failed to load practice history." });
    }
    res.set("Cache-Control", "private, no-store");
    return res.json({ data: (data ?? []).map(toPracticeSessionSummary) });
  } catch (error) {
    console.error("Business practice sessions read threw:", error);
    return res.status(500).json({ error: "Failed to load practice history." });
  }
}
