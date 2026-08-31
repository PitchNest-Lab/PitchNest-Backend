/**
 * DeckIntelligenceService — Slide parsing, structured slide representation,
 * and semantic slide-to-speech mapping for PitchNest.
 *
 * Allows founders to pitch naturally without reading slides, while the AI
 * maps speech to the relevant slide and detects updates vs contradictions.
 */

import { sanitizeDeckText } from "../utils/aiTextSanitizer.ts";

export interface StructuredSlide {
  slideNumber: number;
  title: string;
  topic: "Introduction" | "Problem" | "Solution" | "Market" | "Business Model" | "Traction" | "Competition" | "Go-To-Market" | "Financials" | "Team" | "Ask" | "General";
  rawText: string;
  keyNumbers: string[];
  keyClaims: string[];
}

export interface DeckIntelligence {
  deckName: string;
  totalSlides: number;
  slides: StructuredSlide[];
  summary: string;
}

const TOPIC_KEYWORDS: Record<StructuredSlide["topic"], RegExp> = {
  Introduction: /\b(welcome|intro|introduction|pitch|overview|title)\b/i,
  Problem: /\b(problem|pain|struggle|friction|inefficiency|challenge|broken|issue)\b/i,
  Solution: /\b(solution|product|platform|app|features|how it works|value prop|technology|workflow)\b/i,
  Market: /\b(market|tam|sam|som|industry|opportunity|target audience|demographic|market size)\b/i,
  "Business Model": /\b(business model|monetization|pricing|revenue stream|commission|subscription|fee|unit economics)\b/i,
  Traction: /\b(traction|growth|users|paying customers|retention|mrr|arr|validation|milestones|metrics)\b/i,
  Competition: /\b(competitor|competition|landscape|moat|advantage|differentiation|vs|alternative)\b/i,
  "Go-To-Market": /\b(go to market|gtm|acquisition|channels|distribution|sales|marketing|partnerships)\b/i,
  Financials: /\b(financials|projections|forecast|p&l|margins|revenue forecast|ebitda|cash flow)\b/i,
  Team: /\b(team|founders|advisors|leadership|background|co-founder|experience|credentials)\b/i,
  Ask: /\b(ask|raising|round|funding|use of funds|investment|milestones|valuation)\b/i,
  General: /.*/,
};

/**
 * Parses raw extracted deck text into structured slides.
 */
export function parseDeckIntoSlides(rawText: string, deckName: string = "Pitch Deck"): DeckIntelligence {
  const cleanDeckName = sanitizeDeckText(deckName) || "Pitch Deck";
  if (!rawText || !rawText.trim()) {
    return {
      deckName: cleanDeckName,
      totalSlides: 0,
      slides: [],
      summary: "No text content available.",
    };
  }

  // 1. Split on page break characters (\f) or header patterns (--- / Slide X / Page X)
  let rawChunks: string[] = [];
  if (rawText.includes("\f")) {
    // Form feeds are REAL page boundaries written by the extractor (one per PDF
    // page), so an empty chunk means an image-only page — it must keep its
    // position. Filtering empties here would renumber every later slide, and
    // then "Slide 7" in the AI's context would not be the seventh page the
    // founder is looking at in the viewer. The other two branches below are
    // heuristic splits with no real page numbering to preserve, so they still
    // drop empties.
    rawChunks = rawText.split("\f").map(s => s.trim());
  } else if (/\n\s*(?:---+|===+|Slide\s+\d+|Page\s+\d+)\s*\n/i.test(rawText)) {
    rawChunks = rawText.split(/\n\s*(?:---+|===+|Slide\s+\d+|Page\s+\d+)\s*\n/i).map(s => s.trim()).filter(Boolean);
  } else {
    // Split by major double linebreaks or paragraph chunks
    rawChunks = rawText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    if (rawChunks.length > 15) {
      // Group small paragraphs into ~10 slides
      const grouped: string[] = [];
      const chunkSize = Math.ceil(rawChunks.length / 10);
      for (let i = 0; i < rawChunks.length; i += chunkSize) {
        grouped.push(rawChunks.slice(i, i + chunkSize).join("\n\n"));
      }
      rawChunks = grouped;
    }
  }

  if (rawChunks.length === 0) {
    rawChunks = [rawText.trim()];
  }

  const slides: StructuredSlide[] = rawChunks.map((chunk, idx) => {
    const slideNumber = idx + 1;
    const cleanChunk = sanitizeDeckText(chunk);
    const lines = cleanChunk.split("\n").map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    
    // Extract title (use first line if clean, or "Slide X")
    let title = `Slide ${slideNumber}`;
    if (firstLine.length > 2 && firstLine.length < 60 && !/^[\d\s.,$₦%]+$/.test(firstLine)) {
      title = sanitizeDeckText(firstLine.replace(/^[#\-*\d.]+\s*/, ""));
    }

    // Infer topic from content
    let topic: StructuredSlide["topic"] = "General";
    for (const [t, regex] of Object.entries(TOPIC_KEYWORDS) as [StructuredSlide["topic"], RegExp][]) {
      if (t !== "General" && (regex.test(title) || regex.test(cleanChunk))) {
        topic = t;
        break;
      }
    }

    // Extract key numbers
    const numberMatches = cleanChunk.match(/(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|bn\b|x\b|million|billion|users?|customers?|arr|mrr)?/gi) || [];
    const keyNumbers = Array.from(new Set(numberMatches.map(n => sanitizeDeckText(n.trim())).filter(n => n.length > 1))).slice(0, 5);

    // Extract key claims / bullet points
    const keyClaims = lines
      .filter(l => l.length > 15 && l !== firstLine)
      .map(l => sanitizeDeckText(l.replace(/^[-*•\d.]+\s*/, "").trim()))
      .filter(Boolean)
      .slice(0, 4);

    return {
      slideNumber,
      title,
      topic,
      rawText: cleanChunk.slice(0, 1000),
      keyNumbers,
      keyClaims,
    };
  });

  return {
    deckName: cleanDeckName,
    totalSlides: slides.length,
    slides,
    summary: `Structured deck with ${slides.length} slides covering ${Array.from(new Set(slides.map(s => s.topic))).join(", ")}.`,
  };
}

/**
 * Semantically maps founder speech to the most relevant slide in the deck.
 */
export function inferActiveSlide(
  speech: string,
  deck: DeckIntelligence
): { activeSlide: StructuredSlide | null; matchScore: number } {
  if (!deck.slides || deck.slides.length === 0 || !speech.trim()) {
    return { activeSlide: null, matchScore: 0 };
  }

  const speechLower = speech.toLowerCase();
  let bestSlide: StructuredSlide | null = null;
  let highestScore = 0;

  for (const slide of deck.slides) {
    let score = 0;
    // Match topic keywords
    // Image-only pages hold their position in the deck but have no text to match
    // against, so they can never be inferred from speech. They are still
    // reachable — the viewer reports the page the founder is actually on.
    if (!slide.rawText.trim()) continue;

    const topicRegex = TOPIC_KEYWORDS[slide.topic];
    // "General" means UNCLASSIFIED, and its pattern is /.*/ — which matches any
    // speech at all. Granting it the topic bonus made every unclassified slide
    // score 3 (over the >= 2 threshold) for completely unrelated speech, so the
    // first such slide was reported as the active one no matter what the founder
    // said. An unclassified slide must earn its score from titles, numbers and
    // claims like any other.
    if (topicRegex && slide.topic !== "General" && topicRegex.test(speechLower)) {
      score += 3;
    }

    // Match slide title words
    const titleWords = slide.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const w of titleWords) {
      if (speechLower.includes(w)) score += 2;
    }

    // Match numbers
    for (const num of slide.keyNumbers) {
      const cleanNum = num.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleanNum.length > 1 && speechLower.replace(/[^a-z0-9]/g, "").includes(cleanNum)) {
        score += 4;
      }
    }

    // Match claims
    for (const claim of slide.keyClaims) {
      const claimWords = claim.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      for (const w of claimWords) {
        if (speechLower.includes(w)) score += 1;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestSlide = slide;
    }
  }

  return { activeSlide: highestScore >= 2 ? bestSlide : null, matchScore: highestScore };
}

/**
 * Formats structured deck intelligence for the AI prompt.
 */
export function buildStructuredDeckContextBlock(deck: DeckIntelligence): string {
  if (!deck.slides || deck.slides.length === 0) {
    return `PITCH DECK: None loaded or text unavailable. Base questions on live speech.`;
  }

  const parts: string[] = [];
  parts.push(`=== STRUCTURED PITCH DECK CONTEXT ("${deck.deckName}") ===`);
  parts.push(`TOTAL SLIDES: ${deck.totalSlides}`);

  for (const slide of deck.slides) {
    // A page with no extractable text (image-only slide) still occupies its real
    // page number. Say so plainly rather than emitting an empty line, so the
    // model knows the slide exists and that it has nothing to read from it —
    // instead of inferring the deck skips a number.
    if (!slide.rawText.trim()) {
      parts.push(
        `- Slide ${slide.slideNumber}: (image or chart only — no readable text; ask the founder to describe it)`,
      );
      continue;
    }
    const numLine = slide.keyNumbers.length > 0 ? ` [Key figures: ${slide.keyNumbers.join(", ")}]` : "";
    const claims = slide.keyClaims.length > 0 ? ` | Points: ${slide.keyClaims.join("; ")}` : "";
    parts.push(`- Slide ${slide.slideNumber} (${slide.title} — Topic: ${slide.topic}):${numLine}${claims}`);
  }

  parts.push(`DECK REASONING INSTRUCTIONS:
- The founder pitches naturally without reading word-for-word. Map their speech to the relevant slide semantically.
- When they mention numbers different from the deck (e.g. deck says 100 users, speech says 150), acknowledge this as an UPDATED metric rather than an error.
- Probe high-impact gaps between deck claims and what the founder explains.`);
  parts.push(`=== END DECK CONTEXT ===`);

  return parts.join("\n");
}
