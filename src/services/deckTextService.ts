/**
 * DeckTextService — extract deck text WITH its page boundaries intact.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────────────────────
 * deckIntelligenceService.parseDeckIntoSlides splits a deck into slides by
 * looking for form feeds (\f) first, then "Slide N" / "Page N" headers, then
 * blank-line paragraph breaks. The upload path used to normalise extracted text
 * with `.replace(/\s{2,}/g, " ")`, which collapses \f AND every blank line into
 * a single space — so by the time the parser saw the text there were no page
 * boundaries left, and EVERY pdf deck came out as exactly one slide.
 *
 * That is the root cause behind "the AI doesn't know which slide I'm on": the
 * structured deck context it received listed one slide for a 14-page deck.
 *
 * pdf-parse v2 already hands back per-page text (`TextResult.pages[]`), so the
 * fix is to normalise WITHIN each page and join pages with \f. No schema change,
 * no new dependency, and parseDeckIntoSlides then works as written.
 */

/** Marker parseDeckIntoSlides splits on. One per page boundary. */
export const PAGE_DELIMITER = "\f";

export interface DeckExtraction {
  /** Page texts joined with PAGE_DELIMITER. Empty when nothing was extractable. */
  text: string;
  /** Real page count from the document, or 0 when unknown (e.g. image-only PDF). */
  pageCount: number;
}

/**
 * Collapse runs of spaces/tabs and trim each line, but PRESERVE line breaks.
 *
 * Line structure is what the slide parser uses to pick a slide title and its
 * bullet claims, and it is what a blank-line fallback split depends on, so it
 * must survive. Only horizontal whitespace and runs of 3+ blank lines are
 * squeezed.
 */
function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract page-delimited text from a PDF buffer.
 *
 * Returns an empty extraction rather than throwing — an image-only or malformed
 * deck must still upload and still be presentable, it just has no text for the
 * AI to reason over (which the prompt builder already handles).
 */
export async function extractPdfPages(buffer: Buffer): Promise<DeckExtraction> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();

      // Preferred path: real per-page text.
      const pages = Array.isArray((result as any)?.pages)
        ? ((result as any).pages as Array<{ num?: number; text?: string }>)
        : [];

      if (pages.length > 0) {
        const pageTexts = pages
          .slice()
          .sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0))
          .map((p) => normalizePageText(p.text || ""));

        const pageCount = Number((result as any)?.total) || pages.length;

        // Keep EMPTY pages in place, INCLUDING a leading or trailing one.
        // Dropping them would shift every later slide number by one, so
        // "Slide 7" in the AI's context would no longer be the seventh page the
        // founder sees — and an image-only cover slide (a very common first
        // page) would shift the whole deck. An empty page contributes no text
        // but must still occupy its position.
        //
        // Note this is also why the join is NOT trimmed: String.trim() strips
        // form feeds, which would silently delete exactly those boundary pages.
        const hasAnyText = pageTexts.some((t) => t.length > 0);
        if (!hasAnyText) {
          // Image-only deck: report the real page count so the viewer can still
          // paginate, but no text — the prompt builder already handles a deck
          // with no extractable content.
          return { text: "", pageCount };
        }

        return { text: pageTexts.join(PAGE_DELIMITER), pageCount };
      }

      // Older/edge builds without `pages`: keep whatever \f the flat text has.
      const flat = normalizePageText((result as any)?.text || "");
      const pageCount =
        Number((result as any)?.total) ||
        (flat ? flat.split(PAGE_DELIMITER).length : 0);
      return { text: flat, pageCount };
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (err) {
    console.warn("⚠️ Failed to parse PDF text:", err);
    return { text: "", pageCount: 0 };
  }
}

/**
 * Extract text from a plain-text / markdown deck.
 *
 * These have no pages, so an explicit "---" / "Slide N" / "Page N" separator is
 * promoted to a page break and everything else falls through to the parser's
 * blank-line handling. Line breaks are preserved for the same reason as above.
 */
export function extractPlainTextDeck(raw: string): DeckExtraction {
  const normalized = normalizePageText(raw)
    .replace(/\n\s*(?:-{3,}|={3,})\s*\n/g, PAGE_DELIMITER)
    .replace(/\n\s*(?:Slide|Page)\s+\d+\s*\n/gi, PAGE_DELIMITER);
  // A separator at the very start (a file that opens with "Slide 1") would
  // otherwise produce an empty leading page and push every slide number up by
  // one. Only the outer delimiters are removed; interior ones stay in place.
  const text = normalized.replace(/^\f+/, "").replace(/\f+$/, "");
  return {
    text,
    pageCount: text.trim() ? text.split(PAGE_DELIMITER).length : 0,
  };
}

/**
 * Count the pages represented in already-stored extracted text.
 *
 * Used to report a slide total for decks uploaded before this fix, where the
 * stored text has no \f at all and therefore genuinely reads as a single page.
 * Empty interior pages are counted — their positions are real.
 */
export function pageCountFromText(text: string | null | undefined): number {
  if (!text || !text.trim()) return 0;
  return text.split(PAGE_DELIMITER).length;
}
