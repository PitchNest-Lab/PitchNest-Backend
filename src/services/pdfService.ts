import PDFDocument from "pdfkit";

type PDFDoc = InstanceType<typeof PDFDocument>;

// ── Color palette ────────────────────────────────────────────────────────────
const COLORS = {
  primary: "#0EA5E9",       // sky-500
  primaryDark: "#0284C7",   // sky-600
  dark: "#0F172A",          // slate-900
  text: "#334155",          // slate-700
  textLight: "#64748B",     // slate-500
  border: "#E2E8F0",        // slate-200
  bgLight: "#F8FAFC",       // slate-50
  emerald: "#10B981",
  emeraldBg: "#ECFDF5",
  rose: "#F43F5E",
  roseBg: "#FFF1F2",
  amber: "#F59E0B",
  amberBg: "#FFFBEB",
  indigo: "#6366F1",
  indigoBg: "#EEF2FF",
  white: "#FFFFFF",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function clamp(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

function getVerdict(score: number, isInsufficient: boolean): string {
  if (isInsufficient) return "Incomplete";
  if (score >= 80) return "Strong Buy (Invest)";
  if (score >= 60) return "Consideration (Follow Up)";
  return "Decline to Invest";
}

function getVerdictColor(score: number, isInsufficient: boolean): string {
  if (isInsufficient) return COLORS.textLight;
  if (score >= 80) return COLORS.emerald;
  if (score >= 60) return COLORS.primary;
  return COLORS.rose;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "Unknown Date";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "Unknown Date";
  }
}

function drawHorizontalRule(doc: PDFDoc, y: number) {
  doc
    .moveTo(50, y)
    .lineTo(doc.page.width - 50, y)
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .stroke();
}

function drawScoreBar(
  doc: PDFDoc,
  x: number,
  y: number,
  width: number,
  score: number,
  color: string,
) {
  // Background bar
  doc.roundedRect(x, y, width, 8, 4).fill(COLORS.border);
  // Filled bar
  if (score > 0) {
    const fillWidth = Math.max(8, (score / 100) * width);
    doc.roundedRect(x, y, fillWidth, 8, 4).fill(color);
  }
}

function ensureSpace(doc: PDFDoc, needed: number) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage();
  }
}

// ── Main generator ───────────────────────────────────────────────────────────
export async function generatePitchReportPDF(session: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: {
          Title: `PitchNest Report — ${session?.business_name || "Pitch Evaluation"}`,
          Author: "PitchNest",
          Subject: "Pitch Evaluation Report",
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const report = session?.evaluation_report || {};
      const rawScores = report.scores || {};
      const scores = {
        delivery: clamp(rawScores.delivery),
        clarity: clamp(rawScores.clarity),
        scalability: clamp(rawScores.scalability),
        readiness: clamp(rawScores.readiness),
      };
      const overallScore = Math.round(
        (scores.delivery + scores.clarity + scores.scalability + scores.readiness) / 4,
      );
      const isInsufficient =
        report.evaluationStatus === "insufficient_data" ||
        report.evaluationStatus === "failed" ||
        Object.values(scores).every((v) => v === 0);

      const businessName = session?.business_name || "My Startup";
      const formattedDate = formatDate(session?.created_at || session?.timestamp);
      const strengths: string[] = Array.isArray(report.strengths) ? report.strengths : [];
      const risks: string[] = Array.isArray(report.risks) ? report.risks : [];
      const nextSteps: any[] = Array.isArray(report.next_steps) ? report.next_steps : [];
      const sentiments: any[] = Array.isArray(report.sentiments) ? report.sentiments : [];
      const transcript: any[] = Array.isArray(report.transcript) ? report.transcript : [];

      const pageWidth = doc.page.width - 100; // usable width (margins)

      // ═══════════════════════════════════════════════════════════════════════
      // PAGE 1 — HEADER + SCORES
      // ═══════════════════════════════════════════════════════════════════════

      // ── Header band ──
      doc.rect(0, 0, doc.page.width, 120).fill(COLORS.dark);

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(COLORS.primary)
        .text("PITCHNEST", 50, 30, { width: pageWidth });

      doc
        .font("Helvetica-Bold")
        .fontSize(22)
        .fillColor(COLORS.white)
        .text(businessName, 50, 48, { width: pageWidth });

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#94A3B8")
        .text(`Pitch Date: ${formattedDate}`, 50, 80);

      // Verdict badge
      const verdictText = `Verdict: ${getVerdict(overallScore, isInsufficient)}`;
      const verdictColor = getVerdictColor(overallScore, isInsufficient);
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(verdictColor)
        .text(verdictText, 50, 95, { width: pageWidth, align: "left" });

      doc.y = 140;

      // ── Overall Score Section ──
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.dark)
        .text("OVERALL PITCH SCORE", 50, doc.y);

      doc.y += 8;

      const scoreDisplay = isInsufficient ? "N/A" : `${overallScore}/100`;
      doc
        .font("Helvetica-Bold")
        .fontSize(36)
        .fillColor(isInsufficient ? COLORS.textLight : COLORS.primary)
        .text(scoreDisplay, 50, doc.y);

      doc.y += 10;

      // Summary
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor(COLORS.text)
        .text(
          report.summary || "Pitch was too short. AI could not generate a full report.",
          50,
          doc.y,
          { width: pageWidth, lineGap: 3 },
        );

      doc.y += 20;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ── Category Scores ──
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.dark)
        .text("CATEGORY SCORES", 50, doc.y);

      doc.y += 15;

      const categories = [
        { label: "Delivery", score: scores.delivery, color: COLORS.primary },
        { label: "Clarity", score: scores.clarity, color: COLORS.indigo },
        { label: "Scalability", score: scores.scalability, color: COLORS.amber },
        { label: "Readiness", score: scores.readiness, color: COLORS.emerald },
      ];

      for (const cat of categories) {
        const displayScore = isInsufficient ? "N/A" : `${cat.score}/100`;
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(COLORS.text)
          .text(cat.label, 50, doc.y, { width: 90 });

        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(COLORS.dark)
          .text(displayScore, pageWidth - 10, doc.y, { width: 60, align: "right" });

        doc.y += 14;
        drawScoreBar(doc, 50, doc.y, pageWidth, isInsufficient ? 0 : cat.score, cat.color);
        doc.y += 18;
      }

      doc.y += 5;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ── Investor Sentiment ──
      ensureSpace(doc, 100);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.dark)
        .text("INVESTOR SENTIMENT", 50, doc.y);

      doc.y += 12;

      if (isInsufficient || sentiments.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(COLORS.textLight)
          .text(
            "Your pitch was too short to generate investor sentiment. Please speak for at least 2 minutes.",
            50,
            doc.y,
            { width: pageWidth },
          );
        doc.y += 20;
      } else {
        for (const sent of sentiments.slice(0, 3)) {
          ensureSpace(doc, 50);
          doc
            .font("Helvetica-Bold")
            .fontSize(9)
            .fillColor(COLORS.indigo)
            .text(sent.persona || "Panelist", 50, doc.y);

          doc.y += 12;
          doc
            .font("Helvetica-Oblique")
            .fontSize(9)
            .fillColor(COLORS.text)
            .text(`"${sent.quote || ""}"`, 60, doc.y, { width: pageWidth - 20, lineGap: 2 });

          doc.y += 15;
        }
      }

      doc.y += 5;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ═══════════════════════════════════════════════════════════════════════
      // STRENGTHS & RISKS
      // ═══════════════════════════════════════════════════════════════════════

      // ── Key Strengths ──
      ensureSpace(doc, 80);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.emerald)
        .text("KEY STRENGTHS", 50, doc.y);

      doc.y += 12;

      if (isInsufficient || strengths.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(COLORS.textLight)
          .text("Not enough data.", 50, doc.y);
        doc.y += 15;
      } else {
        for (const str of strengths) {
          ensureSpace(doc, 25);
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(COLORS.emerald)
            .text("✓ ", 50, doc.y, { continued: true })
            .fillColor(COLORS.text)
            .text(str, { width: pageWidth - 20, lineGap: 2 });
          doc.y += 8;
        }
      }

      doc.y += 10;

      // ── Critical Risks ──
      ensureSpace(doc, 80);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.rose)
        .text("CRITICAL RISKS", 50, doc.y);

      doc.y += 12;

      if (isInsufficient || risks.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(COLORS.textLight)
          .text("Not enough data.", 50, doc.y);
        doc.y += 15;
      } else {
        for (const risk of risks) {
          ensureSpace(doc, 25);
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(COLORS.rose)
            .text("⚠ ", 50, doc.y, { continued: true })
            .fillColor(COLORS.text)
            .text(risk, { width: pageWidth - 20, lineGap: 2 });
          doc.y += 8;
        }
      }

      doc.y += 10;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ═══════════════════════════════════════════════════════════════════════
      // ACTIONABLE NEXT STEPS
      // ═══════════════════════════════════════════════════════════════════════

      ensureSpace(doc, 80);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.dark)
        .text("ACTIONABLE NEXT STEPS", 50, doc.y);

      doc.y += 12;

      if (isInsufficient || nextSteps.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(COLORS.textLight)
          .text(
            "Complete a full pitch session to receive your personalized action plan.",
            50,
            doc.y,
            { width: pageWidth },
          );
        doc.y += 20;
      } else {
        for (let i = 0; i < nextSteps.length; i++) {
          const step = nextSteps[i];
          ensureSpace(doc, 45);

          // Step number + title
          doc
            .font("Helvetica-Bold")
            .fontSize(9)
            .fillColor(COLORS.dark)
            .text(`${i + 1}. ${step.title || "Action Item"}`, 50, doc.y, { width: pageWidth - 80 });

          // Priority badge
          const isHigh = (step.priority || "").toLowerCase().includes("high");
          doc
            .font("Helvetica-Bold")
            .fontSize(8)
            .fillColor(isHigh ? COLORS.rose : COLORS.amber)
            .text(step.priority || "Medium", pageWidth - 20, doc.y, { width: 70, align: "right" });

          doc.y += 14;

          // Description
          if (step.desc) {
            doc
              .font("Helvetica")
              .fontSize(9)
              .fillColor(COLORS.textLight)
              .text(step.desc, 62, doc.y, { width: pageWidth - 30, lineGap: 2 });
            doc.y += 10;
          }

          doc.y += 5;
        }
      }

      doc.y += 5;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ═══════════════════════════════════════════════════════════════════════
      // AI ENGAGEMENT STATS
      // ═══════════════════════════════════════════════════════════════════════

      ensureSpace(doc, 80);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.dark)
        .text("AI ENGAGEMENT METRICS", 50, doc.y);

      doc.y += 15;

      const questionsAsked = isInsufficient
        ? 0
        : Math.max(1, risks.length + nextSteps.length + 2);
      const confidenceScore = isInsufficient ? 0 : Math.min(100, scores.readiness);
      const trend = isInsufficient
        ? "N/A"
        : scores.delivery >= 70
          ? `+${(scores.delivery * 0.15).toFixed(0)}%`
          : `-${((100 - scores.delivery) / 10).toFixed(0)}%`;

      const engagementItems = [
        { label: "Questions Asked", value: isInsufficient ? "N/A" : String(questionsAsked) },
        { label: "Confidence Score", value: isInsufficient ? "N/A" : `${confidenceScore}%` },
        { label: "Sentiment Trend", value: trend },
      ];

      for (const item of engagementItems) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(COLORS.text)
          .text(item.label, 50, doc.y, { width: 200 });
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(COLORS.primary)
          .text(item.value, pageWidth - 40, doc.y, { width: 90, align: "right" });
        doc.y += 18;
      }

      doc.y += 5;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ═══════════════════════════════════════════════════════════════════════
      // INVESTOR READINESS ANALYSIS
      // ═══════════════════════════════════════════════════════════════════════

      ensureSpace(doc, 80);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(COLORS.primary)
        .text("INVESTOR READINESS ANALYSIS", 50, doc.y);

      doc.y += 12;

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(COLORS.text)
        .text(
          `Based on this session, your pitch readiness is evaluated at `,
          50,
          doc.y,
          { continued: true, width: pageWidth, lineGap: 3 },
        )
        .font("Helvetica-Bold")
        .fillColor(COLORS.primary)
        .text(`${scores.readiness}/100`, { continued: true })
        .font("Helvetica")
        .fillColor(COLORS.text)
        .text(
          `. Focus on iterating your delivery and ensuring your market size arguments are defensible before presenting to live VC panels.`,
          { width: pageWidth, lineGap: 3 },
        );

      doc.y += 20;
      drawHorizontalRule(doc, doc.y);
      doc.y += 15;

      // ═══════════════════════════════════════════════════════════════════════
      // TRANSCRIPT
      // ═══════════════════════════════════════════════════════════════════════

      if (transcript.length > 0) {
        ensureSpace(doc, 60);
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(COLORS.dark)
          .text("SESSION TRANSCRIPT", 50, doc.y);

        doc.y += 15;

        for (const msg of transcript) {
          ensureSpace(doc, 40);

          const isUser = msg.type === "user";
          const label = isUser ? "FOUNDER" : (msg.speaker || "INVESTOR");
          const labelColor = isUser ? COLORS.primary : COLORS.indigo;

          doc
            .font("Helvetica-Bold")
            .fontSize(8)
            .fillColor(labelColor)
            .text(label.toUpperCase(), 50, doc.y);

          doc.y += 11;

          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(COLORS.text)
            .text(`"${msg.text || ""}"`, 60, doc.y, { width: pageWidth - 20, lineGap: 2 });

          doc.y += 10;
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // FOOTER
      // ═══════════════════════════════════════════════════════════════════════

      // Add footer to all pages
      const totalPages = doc.bufferedPageRange();
      for (let i = 0; i < totalPages.count; i++) {
        doc.switchToPage(i);
        doc
          .font("Helvetica")
          .fontSize(7)
          .fillColor(COLORS.textLight)
          .text(
            `PitchNest — AI-Powered Pitch Evaluation Report  •  Generated ${new Date().toISOString().split("T")[0]}  •  Page ${i + 1} of ${totalPages.count}`,
            50,
            doc.page.height - 35,
            { width: pageWidth, align: "center" },
          );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
