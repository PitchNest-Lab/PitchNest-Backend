import "../helpers/testEnv.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePitchReportPDF } from "../../services/pdfService.ts";

/**
 * Page layout of the session report. A long analytics page (many hard
 * questions, full category rows) must not push fixed-size cards past the
 * footer: PDFKit would then start a new page for every label of the card.
 */

const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

const sentence = (topic: string) =>
  `The answer on ${topic} stayed general and needs one concrete figure, its source, and a clear owner before the next pitch.`;

const questions = [
  "Who is the first paying customer, and what exactly do they pay for in the first contract?",
  "How will you prove that repeated use changes outcomes beyond the survey responses collected so far?",
  "What single result from the pilot would show that the partner will renew and pay at full price?",
  "How did you derive the valuation, and which milestones will this round fund in the next eighteen months?",
  "Why would a partner choose the cohort price when individual users already pay a monthly subscription?",
  "How will you acquire users efficiently, and what protects the product once larger platforms copy it?",
];

function longReport(hard: number, cellRepeat: number) {
  const cell = (topic: string) => sentence(topic).repeat(cellRepeat).trim();
  return {
    business_name: "Sample Venture",
    created_at: "2026-10-19T12:00:00.000Z",
    evaluation_report: {
      evaluationStatus: "complete",
      scores: { delivery: 45, clarity: 50, scalability: 43, readiness: 42 },
      summary: sentence("the overall opportunity").repeat(2).trim(),
      strengths: [sentence("traction"), sentence("the problem"), sentence("partnerships")],
      risks: [sentence("pricing"), sentence("market size"), sentence("use of funds")],
      next_steps: [
        { title: "Lock pilot success metrics", priority: "High Priority", desc: sentence("pilot metrics") },
        { title: "Finalize pricing model", priority: "High Priority", desc: sentence("pricing") },
        { title: "Quantify the market", priority: "High Priority", desc: sentence("market size") },
        { title: "Build an 18-month plan", priority: "Medium Priority", desc: sentence("milestones") },
      ],
      sentiments: [
        { persona: "Marcus", quote: sentence("milestones") },
        { persona: "Sarah", quote: sentence("pricing") },
        { persona: "Chen", quote: sentence("outcomes") },
      ],
      questions_to_prepare: questions,
      question_difficulty: { easy: 4, medium: 8, hard },
      category_matrix: ["Delivery", "Clarity", "Scalability", "Readiness"].map((category) => ({
        category,
        went_well: cell(`${category.toLowerCase()} strengths`),
        needs_improvement: cell(`${category.toLowerCase()} gaps`),
        impact: "High",
      })),
      confidence_timeline: [
        { time: "0:00", value: 58 },
        { time: "1:30", value: 52 },
        { time: "3:00", value: 46 },
        { time: "4:30", value: 38 },
        { time: "6:00", value: 48 },
      ],
      vc_investment_probability: 31,
      duration: 372,
    },
  };
}

test("five hard questions and full category rows keep the report to its normal pages", async () => {
  const pdf = await generatePitchReportPDF(longReport(5, 1));
  const pages = pageCount(pdf);
  assert.ok(pages >= 7 && pages <= 8, `expected 7 or 8 pages, got ${pages}`);
});

test("the longest category rows still cannot spill the benchmark card across pages", async () => {
  const pdf = await generatePitchReportPDF(longReport(6, 3));
  const pages = pageCount(pdf);
  assert.ok(pages >= 7 && pages <= 8, `expected 7 or 8 pages, got ${pages}`);
});
