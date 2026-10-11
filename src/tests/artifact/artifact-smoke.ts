/**
 * Runs INSIDE an extracted PROD Lambda package (placed at app/artifact-smoke.mjs
 * by scripts/verify-lambda-artifact.mjs). Proves the two Lambda-bundle
 * failures from the readiness audit are fixed in the real package layout:
 *   H2 - pdfkit report generation (fonts/AFM data must resolve)
 *   H3 - pdf-parse text extraction (pdfjs must load as real modules)
 * Prints one JSON line; never prints configuration values.
 */
import { generatePitchReportPDF, generateDeckAuditPDF } from "../../services/pdfService.ts";
import { extractPdfPages } from "../../services/deckTextService.ts";

const root = new URL("../", import.meta.url).href;

const session = {
  business_name: "Artifact Smoke Co",
  created_at: new Date().toISOString(),
  evaluation_report: {
    evaluationStatus: "complete",
    scores: { delivery: 62, clarity: 70, scalability: 55, readiness: 58 },
    summary: "A clear problem statement with credible early traction; unit economics need sharper evidence before a raise.",
    strengths: ["Clear problem framing grounded in customer interviews.", "Early paying pilots with measurable retention."],
    risks: ["Customer acquisition cost is not yet measured.", "Competitive moat relies on execution speed."],
    next_steps: [{ title: "Quantify CAC", priority: "High Priority", desc: "Measure acquisition cost per channel over the next 60 days." }],
    sentiments: [{ persona: "Marcus (Lead Investor)", quote: "Promising, but show me the unit economics." }],
    topic_coverage: [{ topic: "Problem Definition", percentage: 90 }, { topic: "Traction", percentage: 60 }],
    topic_coverage_overall: 75,
    transcript_summary: "The founder covered problem, solution and traction; financials were brief.",
    questions_to_prepare: ["What is your CAC by channel?"],
    duration: 300,
    transcript: [
      { type: "model", speaker: "Marcus", text: "Whenever you're ready." },
      { type: "user", inputMethod: "voice", text: "We help founders rehearse investor pitches with an AI panel and measurable feedback." },
    ],
  },
};

const audit = {
  id: 1,
  deck_id: 1,
  created_at: new Date().toISOString(),
  report: {
    verdict: "Watch",
    one_liner: "Solid problem framing; traction evidence is thin.",
    fundability_score: 58,
    strengths: ["Clear problem"], weaknesses: ["Thin traction"], risks: ["Crowded market"], vc_concerns: ["CAC unknown"],
    red_flags: [{ flag: "No financials", why: "Investors need unit economics.", fix: "Add a one-page model." }],
    sections: [{ section: "Problem", status: "strong", note: "Well evidenced." }],
  },
};

const out: Record<string, unknown> = {};
try {
  out.pdfkitResolvedInsidePackage = import.meta.resolve("pdfkit").startsWith(root);
  out.pdfParseResolvedInsidePackage = import.meta.resolve("pdf-parse").startsWith(root);

  const report = await generatePitchReportPDF(session);
  out.reportIsPdf = report.subarray(0, 5).toString("latin1") === "%PDF-";
  out.reportBytes = report.length;
  out.reportEmbedsInterFont = report.includes(Buffer.from("Inter"));

  const deckPdf = await generateDeckAuditPDF(audit, "Artifact Deck");
  out.auditIsPdf = deckPdf.subarray(0, 5).toString("latin1") === "%PDF-";

  const extraction = await extractPdfPages(report);
  out.extractedChars = extraction.text.length;
  out.extractedPages = extraction.pageCount;
  out.extractedContainsBusinessName = extraction.text.includes("Artifact Smoke Co");
  out.ok = true;
} catch (err: any) {
  out.ok = false;
  out.error = String(err?.stack || err).split("\n").slice(0, 4).join(" | ");
}
console.log("ARTIFACT_SMOKE " + JSON.stringify(out));
