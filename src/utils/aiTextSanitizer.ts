const META_TALK_PREFIX =
  /^(?:okay[,.]?\s+so(?:\s+the\s+user\s+said)?|right[,.]?\s+i\s+need\s+to|i\s+need\s+to\s+keep\s+this|i'm\s+structuring\s+the\s+initial|i've\s+successfully\s+synthesized|i\s+will\s+execute|i've\s+crafted|i've\s+refined|i\s+am\s+focusing\s+on|let\s+me\s+think|first[,.]?\s+i\s+need\s+to|the\s+user\s+(?:just\s+)?said|based\s+on\s+(?:the|this)\s+(?:deck|context)|i\s+should\s+(?:now\s+)?(?:ask|respond|focus))/i;

const THINKING_HEADER_LINE =
  /^(?:confirming|initiating|interpreting|analyzing|rephrasing|assessing|evaluating|deepening|challenging|quantitative|technical|strategic|reviewing|processing|considering|formulating|preparing|transitioning|redirecting|addressing|summarizing|concluding|opening|closing|wrapping)[^.!?]*$/i;

const TITLE_CASE_MONOLOGUE = /^[A-Z][a-z]+(?:[\s'-]+[A-Za-z]+){1,6}\s*$/;

const STAGE_DIRECTION_PAREN = /^\([^)]*(?:thinking|pause|sighs?|nods?|smiles?|leans?|looks?|gestures?)[^)]*\)\s*/i;

const SPEAKER_PREFIX = /^(?:marcus|riley|sarah|chen|investor|founder|panelist):\s*/i;

/**
 * Strips meta-talk, markdown, stage directions, and other non-spoken content
 * from the AI model's streamed response chunks.
 * Returns null when the entire chunk should be discarded.
 */
export function sanitizeAiSpeech(rawText: string): string | null {
  if (!rawText?.trim()) return null;

  let text = rawText.trim();

  if (META_TALK_PREFIX.test(text)) return null;

  // Remove bracketed stage directions like [pause] or [thinking]
  text = text.replace(/\[(?:pause|thinking|silence|wait|note|action|stage)[^\]]*\]/gi, "");

  // Remove parenthetical stage directions at the start
  text = text.replace(STAGE_DIRECTION_PAREN, "");

  // Strip markdown emphasis and inline annotations
  text = text.replace(/\*[^*]+\*/g, "");
  text = text.replace(/_{1,2}[^_]+_{1,2}/g, "");

  // Remove speaker labels the model sometimes adds
  text = text.replace(SPEAKER_PREFIX, "");

  // Drop standalone thinking-header lines
  text = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (TITLE_CASE_MONOLOGUE.test(trimmed)) return false;
      if (THINKING_HEADER_LINE.test(trimmed)) return false;
      return true;
    })
    .join(" ");

  text = text.replace(/\s{2,}/g, " ").trim();

  return text || null;
}

export function detectSpeaker(cleanText: string): { speaker: string; text: string } {
  let speaker = "";
  let text = cleanText;

  const introMatch =
    text.match(/^(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)\s+here[,.]?\s*/i) ||
    text.match(/(?:I'm|I am|This is|It's)\s+(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)[,.\s\u2014-]+/i);

  if (introMatch?.[1]) {
    speaker = introMatch[1].charAt(0).toUpperCase() + introMatch[1].slice(1).toLowerCase();
  }

  const namePrefix = text.match(/^(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)[,:\s]/i);
  if (namePrefix && !speaker) {
    speaker = namePrefix[1].charAt(0).toUpperCase() + namePrefix[1].slice(1).toLowerCase();
    text = text.replace(/^(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)[,:\s]+/i, "").trim();
  }

  return { speaker, text };
}
