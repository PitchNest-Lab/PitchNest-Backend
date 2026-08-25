/**
 * DeckIntelligenceService — Slide parsing, structured slide representation,
 * and semantic slide-to-speech mapping for PitchNest.
 *
 * Allows founders to pitch naturally without reading slides, while the AI
 * maps speech to the relevant slide and detects updates vs contradictions.
 */

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
  if (!rawText || !rawText.trim()) {
    return {
      deckName,
      totalSlides: 0,
      slides: [],
      summary: "No text content available.",
    };
  }

  // 1. Split on page break characters (\f) or header patterns (--- / Slide X / Page X)
  let rawChunks: string[] = [];
  if (rawText.includes("\f")) {
    rawChunks = rawText.split("\f").map(s => s.trim()).filter(Boolean);
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
    const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    
    // Extract title (use first line if clean, or "Slide X")
    let title = `Slide ${slideNumber}`;
    if (firstLine.length > 2 && firstLine.length < 60 && !/^[\d\s.,$₦%]+$/.test(firstLine)) {
      title = firstLine.replace(/^[#\-*\d.]+\s*/, "");
    }

    // Infer topic from content
    let topic: StructuredSlide["topic"] = "General";
    for (const [t, regex] of Object.entries(TOPIC_KEYWORDS) as [StructuredSlide["topic"], RegExp][]) {
      if (t !== "General" && (regex.test(title) || regex.test(chunk))) {
        topic = t;
        break;
      }
    }

    // Extract key numbers
    const numberMatches = chunk.match(/(?:[₦$£€]\s?|\bngn\s?|\busd\s?)?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|bn\b|x\b|million|billion|users?|customers?|arr|mrr)?/gi) || [];
    const keyNumbers = Array.from(new Set(numberMatches.map(n => n.trim()).filter(n => n.length > 1))).slice(0, 5);

    // Extract key claims / bullet points
    const keyClaims = lines
      .filter(l => l.length > 15 && l !== firstLine)
      .map(l => l.replace(/^[-*•\d.]+\s*/, "").trim())
      .slice(0, 4);

    return {
      slideNumber,
      title,
      topic,
      rawText: chunk.slice(0, 1000),
      keyNumbers,
      keyClaims,
    };
  });

  return {
    deckName,
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
    const topicRegex = TOPIC_KEYWORDS[slide.topic];
    if (topicRegex && topicRegex.test(speechLower)) {
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
