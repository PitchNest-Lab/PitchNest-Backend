import { supabase } from "../config/supabase.ts";
import { inlinePromptFragment } from "../utils/aiTextSanitizer.ts";
import { normalizeSessionMode } from "../sockets/resumeGrants.ts";

/**
 * Practice drafts bridge a business in the workspace to a PRIVATE practice
 * session (table from migration 0019). A draft is owner-bound, short-lived and
 * single-use. The WebSocket consumes it at admission and stamps the saved
 * session with the business id — only after re-checking that the founder is
 * still an active member of that business.
 *
 * Nothing here ever reads a deck, report, transcript or recording. The context
 * snapshot holds only descriptive business fields the member can already see.
 */

export const PRACTICE_DRAFT_TTL_MS = 30 * 60 * 1000;
export const PRACTICE_QUESTION_MAX = 300;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export interface PracticeContext {
  businessName: string;
  description: string;
  industry: string;
  fundingStage: string;
}

/**
 * The only business fields that may prefill a practice session. Kept to the
 * four the setup form already has, each capped to the session limits.
 */
export function buildPracticeContext(business: Record<string, unknown>): PracticeContext {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const concept = [text(business.tagline), text(business.description)].filter(Boolean).join(". ");
  return {
    businessName: inlinePromptFragment(text(business.name), 120),
    description: inlinePromptFragment(concept, 1500),
    industry: inlinePromptFragment(text(business.industry), 100),
    fundingStage: inlinePromptFragment(text(business.stage), 80),
  };
}

/** Community or founder-typed question text: untrusted, cleaned and capped. */
export function cleanPracticeQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = inlinePromptFragment(value, PRACTICE_QUESTION_MAX);
  return clean.length >= 5 ? clean : null;
}

export function toPracticeDraftView(row: any) {
  const context = row?.context_snapshot && typeof row.context_snapshot === "object"
    ? row.context_snapshot
    : {};
  return {
    id: row.id,
    businessId: row.business_id,
    mode: normalizeSessionMode(row.mode),
    question: typeof row.source_question === "string" ? row.source_question : null,
    expiresAt: row.expires_at,
    context: {
      businessName: typeof context.businessName === "string" ? context.businessName : "",
      description: typeof context.description === "string" ? context.description : "",
      industry: typeof context.industry === "string" ? context.industry : "",
      fundingStage: typeof context.fundingStage === "string" ? context.fundingStage : "",
    },
  };
}

export interface ConsumedPracticeDraft {
  businessId: string;
  question: string | null;
}

/**
 * Atomically marks a draft used and returns its business link, or null when
 * the draft is unknown, someone else's, expired, already used, or the founder
 * is no longer an active member of a live business. Never throws: a failed
 * bridge degrades to an ordinary private session.
 */
export async function consumePracticeDraft(
  userId: number,
  draftId: unknown,
): Promise<ConsumedPracticeDraft | null> {
  if (!Number.isInteger(userId) || !isUuid(draftId)) return null;
  try {
    const nowIso = new Date().toISOString();
    const { data: draft, error } = await supabase
      .from("practice_drafts")
      .update({ consumed_at: nowIso })
      .eq("id", draftId)
      .eq("user_id", userId)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .select("business_id, source_question")
      .maybeSingle();
    if (error || !draft) return null;

    const [{ data: membership }, { data: business }] = await Promise.all([
      supabase
        .from("business_members")
        .select("role")
        .eq("business_id", draft.business_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle(),
      supabase.from("businesses").select("id, status").eq("id", draft.business_id).maybeSingle(),
    ]);
    if (!membership || !business || (business as any).status === "removed") return null;

    return {
      businessId: draft.business_id,
      question: cleanPracticeQuestion(draft.source_question),
    };
  } catch (error) {
    console.warn("Practice draft consumption failed:", error);
    return null;
  }
}
