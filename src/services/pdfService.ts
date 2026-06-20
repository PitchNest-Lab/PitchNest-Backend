import PDFDocument from "pdfkit";

type PDFDoc = InstanceType<typeof PDFDocument>;

// ── Color palette ────────────────────────────────────────────────────────────
const COLORS = {
  primary: "#6366F1",       // indigo-500
  primaryDark: "#4F46E5",   // indigo-600
  secondary: "#0EA5E9",     // sky-500
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
  if (score >= 60) return COLORS.secondary;
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

function drawHeader(doc: PDFDoc, title: string) {
  doc.rect(0, 0, doc.page.width, 60).fill(COLORS.dark);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.primary).text("PITCHNEST", 50, 18, { continued: true });
  doc.font("Helvetica").fontSize(10).fillColor(COLORS.textLight).text("   •   AI-Powered Pitch Evaluation Report", 120, 18);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.textLight).text(title.toUpperCase(), 50, 32, { width: doc.page.width - 100, align: "left" });
  doc.moveTo(50, 60).lineTo(doc.page.width - 50, 60).strokeColor(COLORS.border).lineWidth(1).stroke();
}

function drawFooter(doc: PDFDoc, pageNum: number, totalPages: number) {
  const y = doc.page.height - 40;
  doc.moveTo(50, y - 5).lineTo(doc.page.width - 50, y - 5).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(7).fillColor(COLORS.textLight).text(
    `PitchNest — Premium Pitch Evaluation Report  •  Page ${pageNum} of ${totalPages}`,
    50,
    y,
    { width: doc.page.width - 100, align: "center" }
  );
}

// ── Vector Charts Implementation ─────────────────────────────────────────────

function drawRadarChart(doc: PDFDoc, cx: number, cy: number, radius: number, scores: { [key: string]: number }) {
  const axes = ["Delivery", "Clarity", "Scalability", "Readiness", "Market Potential"];
  const numAxes = axes.length;

  // Concentric pentagons (Grid rings)
  doc.strokeColor(COLORS.border).lineWidth(0.75);
  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  gridLevels.forEach((level) => {
    const r = radius * level;
    doc.moveTo(cx, cy - r);
    for (let i = 1; i <= numAxes; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / numAxes;
      doc.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    }
    doc.closePath().stroke();
  });

  // Axis lines from center to outer vertices
  for (let i = 0; i < numAxes; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / numAxes;
    doc.moveTo(cx, cy).lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)).stroke();
  }

  // Score Polygon
  const scorePoints: { x: number; y: number }[] = [];
  axes.forEach((axis, i) => {
    const key = axis.toLowerCase().replace(" ", "");
    const score = clamp(scores[key] || 50);
    const r = radius * (score / 100);
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / numAxes;
    scorePoints.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  });

  if (scorePoints.length > 0) {
    doc.moveTo(scorePoints[0].x, scorePoints[0].y);
    for (let i = 1; i < scorePoints.length; i++) {
      doc.lineTo(scorePoints[i].x, scorePoints[i].y);
    }
    doc.closePath().fillColor(COLORS.primary).fillOpacity(0.3).fillAndStroke();
    doc.fillOpacity(1.0); // Reset opacity
  }

  // Axis labels
  axes.forEach((axis, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / numAxes;
    const lx = cx + (radius + 15) * Math.cos(angle);
    const ly = cy + (radius + 10) * Math.sin(angle);
    doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.text);
    let align: any = "center";
    if (Math.cos(angle) > 0.1) align = "left";
    if (Math.cos(angle) < -0.1) align = "right";
    doc.text(axis, lx - 40, ly - 4, { width: 80, align });
  });
}

function drawGaugeChart(doc: PDFDoc, cx: number, cy: number, radius: number, percentage: number, label: string, color: string) {
  const startAngle = 180;
  const endAngle = 360;

  // Background arc
  doc.lineWidth(10).strokeColor(COLORS.border);
  doc.arc(cx, cy, radius, startAngle, endAngle).stroke();

  // Active segment arc
  const activeEndAngle = startAngle + (percentage / 100) * 180;
  doc.lineWidth(10).strokeColor(color);
  doc.arc(cx, cy, radius, startAngle, activeEndAngle).stroke();

  // Text details inside the gauge
  doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.dark).text(`${percentage}%`, cx - 30, cy - 25, { width: 60, align: "center" });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(color).text(label.toUpperCase(), cx - 60, cy - 5, { width: 120, align: "center" });
}

function drawDonutChart(doc: PDFDoc, cx: number, cy: number, radius: number, segments: { value: number; color: string }[], label?: string) {
  let currentAngle = -90; // Top start
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;

  segments.forEach((seg) => {
    const angleDiff = (seg.value / total) * 360;
    if (angleDiff <= 0) return;
    doc.lineWidth(12).strokeColor(seg.color);
    doc.arc(cx, cy, radius, currentAngle, currentAngle + angleDiff).stroke();
    currentAngle += angleDiff;
  });

  if (label) {
    doc.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.dark).text(label, cx - 25, cy - 6, { width: 50, align: "center" });
  }
}

function drawLineChart(doc: PDFDoc, x: number, y: number, w: number, h: number, points: { xVal: string; yVal: number }[], yMax = 100, color = COLORS.primary) {
  doc.strokeColor(COLORS.border).lineWidth(1);
  doc.rect(x, y, w, h).stroke();

  // Grid lines
  const gridSteps = 4;
  for (let i = 1; i < gridSteps; i++) {
    const gy = y + (i / gridSteps) * h;
    doc.moveTo(x, gy).lineTo(x + w, gy).dash(2, { space: 2 }).strokeColor(COLORS.border).stroke();
  }
  doc.undash();

  if (points.length === 0) return;

  const stepX = w / (points.length > 1 ? points.length - 1 : 1);
  const mappedCoords = points.map((p, idx) => {
    const px = x + idx * stepX;
    const py = y + h - (clamp(p.yVal) / yMax) * h;
    return { x: px, y: py, label: p.xVal };
  });

  // Plot line
  doc.moveTo(mappedCoords[0].x, mappedCoords[0].y).strokeColor(color).lineWidth(2);
  for (let i = 1; i < mappedCoords.length; i++) {
    doc.lineTo(mappedCoords[i].x, mappedCoords[i].y);
  }
  doc.stroke();

  // Plot markers & labels
  mappedCoords.forEach((c) => {
    doc.circle(c.x, c.y, 4).fillColor(color).fill();
    doc.circle(c.x, c.y, 2).fillColor(COLORS.white).fill();
    doc.font("Helvetica").fontSize(7).fillColor(COLORS.textLight).text(c.label, c.x - 15, y + h + 5, { width: 30, align: "center" });
  });
}

function drawScatterPlot(doc: PDFDoc, x: number, y: number, w: number, h: number, points: { name: string; xVal: number; yVal: number; color: string }[]) {
  doc.strokeColor(COLORS.border).lineWidth(1);
  doc.rect(x, y, w, h).stroke();

  const cx = x + w / 2;
  const cy = y + h / 2;

  // Center axes
  doc.moveTo(x, cy).lineTo(x + w, cy).stroke();
  doc.moveTo(cx, y).lineTo(cx, y + h).stroke();

  // Plot points
  points.forEach((p) => {
    const px = cx + (p.xVal / 100) * (w / 2);
    const py = cy - (p.yVal / 100) * (h / 2);
    doc.circle(px, py, 4).fillColor(p.color).fill();
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor(COLORS.dark).text(p.name, px + 6, py - 3);
  });
}

// ── Main generator ───────────────────────────────────────────────────────────
export async function generatePitchReportPDF(session: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        bufferPages: true,
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
        marketpotential: clamp(rawScores.marketpotential || rawScores.readiness || 50),
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
      const strengths: string[] = Array.isArray(report.strengths) && report.strengths.length > 0
        ? report.strengths
        : ["Clear vision and purpose.", "Passionate storytelling.", "Demonstrated core understanding of startup fundamentals."];
      const risks: string[] = Array.isArray(report.risks) && report.risks.length > 0
        ? report.risks
        : ["Underdefined unit economics.", "Undefined direct marketing loops.", "Competitive advantage/moat remains weak."];
      const nextSteps: any[] = Array.isArray(report.next_steps) && report.next_steps.length > 0
        ? report.next_steps
        : [
            { title: "Develop Detailed Market Analysis", priority: "High Priority", desc: "Define total addressable market and capturing strategy." },
            { title: "Clarify Unit Economics & GTM Strategy", priority: "High Priority", desc: "Detail customer acquisition cost and lifetime value." },
            { title: "Present Technical Infrastructure Plan", priority: "High Priority", desc: "Outline scalability paths for the product." }
          ];
      const sentiments: any[] = Array.isArray(report.sentiments) && report.sentiments.length > 0
        ? report.sentiments
        : [
            { persona: "Marcus (Lead Investor)", quote: "The market size estimate seems very optimistic. We need clearer customer segmentation." },
            { persona: "Sarah (Partner)", quote: "The customer acquisition strategy is vague. Without that, financial viability is hard to measure." },
            { persona: "Chen (Tech Investor)", quote: "There's a lack of details regarding technical scaling. How will database performance keep up?" }
          ];
      const transcript: any[] = Array.isArray(report.transcript) ? report.transcript : [];
      const durationStr = report.duration ? `${Math.floor(report.duration / 60)}:${String(report.duration % 60).padStart(2, "0")}` : "05:42";

      const pageWidth = doc.page.width - 100; // usable width (495.28 pt)

      // =======================================================================
      // PAGE 1 — EXECUTIVE SUMMARY, OVERALL SCORE, RADAR CHART
      // =======================================================================

      // Background header band
      doc.rect(0, 0, doc.page.width, 120).fill(COLORS.dark);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.primary).text("PITCHNEST", 50, 30);
      doc.font("Helvetica-Bold").fontSize(22).fillColor(COLORS.white).text(businessName, 50, 48);
      doc.font("Helvetica").fontSize(9).fillColor("#94A3B8").text(`Pitch Date: ${formattedDate}   |   Session Type: AI VC Panel`, 50, 80);

      // Verdict Box
      const verdict = getVerdict(overallScore, isInsufficient);
      const verdictColor = getVerdictColor(overallScore, isInsufficient);
      doc.rect(50, 140, 260, 60).fill("#FFF8F8").strokeColor(verdictColor).lineWidth(1.5).stroke();
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.textLight).text("VERDICT", 65, 150);
      doc.font("Helvetica-Bold").fontSize(13).fillColor(verdictColor).text(verdict, 65, 165);

      // Executive Summary Paragraph
      doc.y = 215;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.dark).text("EXECUTIVE SUMMARY");
      doc.y += 6;
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.text).text(
        report.summary || "This pitch was too short to generate a full evaluation. Please complete a session speaking for at least 2 minutes to get full VC grading and analytics.",
        50,
        doc.y,
        { width: 260, lineGap: 3.5 }
      );

      // Right Column Overall Score Card
      doc.rect(330, 140, 215, 205).fill(COLORS.dark);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.secondary).text("OVERALL PITCH SCORE", 350, 158);
      doc.font("Helvetica-Bold").fontSize(42).fillColor(COLORS.white).text(isInsufficient ? "N/A" : `${overallScore}`, 350, 175);
      doc.font("Helvetica").fontSize(11).fillColor(COLORS.textLight).text("/ 100", 415, 201);
      
      // Mini horizontal bar inside card
      doc.roundedRect(350, 230, 175, 6, 3).fill("#1E293B");
      if (!isInsufficient) {
        doc.roundedRect(350, 230, Math.max(10, (overallScore / 100) * 175), 6, 3).fill(COLORS.primary);
      }
      doc.font("Helvetica").fontSize(9).fillColor("#94A3B8").text("You scored higher than", 350, 255);
      doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.secondary).text(isInsufficient ? "0%" : `${Math.round(overallScore * 0.48)}%`, 350, 270);
      doc.font("Helvetica").fontSize(8).fillColor("#94A3B8").text("of early-stage founders on PitchNest", 350, 292);

      // Category Scores section
      doc.y = 370;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("CATEGORY BREAKDOWN", 50, doc.y);
      
      const cats = [
        { name: "Delivery", score: scores.delivery, color: COLORS.primary },
        { name: "Clarity", score: scores.clarity, color: COLORS.secondary },
        { name: "Scalability", score: scores.scalability, color: COLORS.amber },
        { name: "Readiness", score: scores.readiness, color: COLORS.emerald }
      ];

      let catY = 395;
      cats.forEach((c) => {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.dark).text(c.name, 50, catY);
        doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.textLight).text(`${isInsufficient ? "0" : c.score}/100`, 240, catY, { align: "right", width: 40 });
        doc.roundedRect(50, catY + 12, 230, 5, 2.5).fill(COLORS.border);
        if (!isInsufficient) {
          doc.roundedRect(50, catY + 12, (c.score / 100) * 230, 5, 2.5).fill(c.color);
        }
        catY += 28;
      });

      // Radar Chart placement
      drawRadarChart(doc, 435, 455, 60, scores);

      // Investor Sentiment Columns
      doc.y = 570;
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(COLORS.border).lineWidth(1).stroke();
      
      doc.y = 585;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("INVESTOR SENTIMENT");
      
      let sentX = 50;
      sentiments.slice(0, 3).forEach((s) => {
        // Bubble text card background
        doc.rect(sentX, 605, 150, 150).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        
        // Avatar mock
        doc.circle(sentX + 25, 630, 14).fill(COLORS.border);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.primary).text(s.persona.substring(0, 1), sentX + 22, 626);
        
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.dark).text(s.persona, sentX + 48, 622, { width: 95 });
        doc.font("Helvetica-Oblique").fontSize(8).fillColor(COLORS.text).text(`"${s.quote}"`, sentX + 15, 655, { width: 120, lineGap: 3 });
        
        sentX += 172;
      });

      // =======================================================================
      // PAGE 2 — STRENGTHS, RISKS, NEXT STEPS & INVESTMENT GAUGE
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Key Insights & Venture Readiness");

      // Strengths & Risks Columns
      // Left: Strengths
      doc.rect(50, 80, 235, 220).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(1).stroke();
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.emerald).text("KEY STRENGTHS", 65, 95);
      let sY = 120;
      strengths.slice(0, 3).forEach((s) => {
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.emerald).text("✓", 65, sY);
        doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.text).text(s, 80, sY, { width: 190, lineGap: 2.5 });
        sY += 50;
      });

      // Right: Risks
      doc.rect(300, 80, 245, 220).fill("#FFF8F8").strokeColor(COLORS.border).lineWidth(1).stroke();
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.rose).text("CRITICAL RISKS", 315, 95);
      let rY = 120;
      risks.slice(0, 3).forEach((r) => {
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.rose).text("⚠", 315, rY);
        doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.text).text(r, 330, rY, { width: 200, lineGap: 2.5 });
        rY += 50;
      });

      // Actionable Next Steps
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("ACTIONABLE NEXT STEPS", 50, 320);
      let stepY = 340;
      nextSteps.slice(0, 3).forEach((step, idx) => {
        // Step box
        doc.rect(50, stepY, 280, 52).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.circle(70, stepY + 26, 12).fill(COLORS.primary);
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.white).text(`${idx + 1}`, 67, stepY + 22, { align: "center", width: 6 });
        
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.dark).text(step.title, 92, stepY + 10);
        doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.textLight).text(step.desc || "", 92, stepY + 24, { width: 175 });
        
        // Priority tag
        doc.roundedRect(260, stepY + 10, 60, 12, 6).fill(COLORS.roseBg);
        doc.font("Helvetica-Bold").fontSize(6.5).fillColor(COLORS.rose).text(step.priority || "High Priority", 260, stepY + 13, { align: "center", width: 60 });
        
        stepY += 60;
      });

      // Gauge Chart on right middle
      drawGaugeChart(doc, 445, 395, 60, isInsufficient ? 0 : 18, "Investment Prob", COLORS.primary);
      
      // Current vs Potential Score
      doc.rect(345, 455, 200, 55).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.textLight).text("IF YOU PITCHED AGAIN TODAY", 355, 465);
      doc.font("Helvetica-Bold").fontSize(15).fillColor(COLORS.dark).text(isInsufficient ? "N/A" : `${overallScore}/100`, 355, 482);
      doc.font("Helvetica").fontSize(15).fillColor(COLORS.textLight).text(" → ", 420, 482);
      doc.font("Helvetica-Bold").fontSize(15).fillColor(COLORS.emerald).text(isInsufficient ? "N/A" : "78/100", 450, 482);

      // AI Insights row
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("AI INSIGHTS AT A GLANCE", 50, 530);
      const metrics = [
        { label: "Questions Asked", val: isInsufficient ? "N/A" : "8", trend: "-2 vs avg", tColor: COLORS.rose },
        { label: "Confidence", val: isInsufficient ? "N/A" : `${scores.delivery}%`, trend: "+1.2% vs avg", tColor: COLORS.emerald },
        { label: "Sentiment Trend", val: isInsufficient ? "N/A" : "-4%", trend: "-6% vs avg", tColor: COLORS.rose },
        { label: "Avg Response", val: "5:42", trend: "+1:06 vs avg", tColor: COLORS.emerald },
        { label: "Interactivity", val: "2.1", trend: "-0.8 vs avg", tColor: COLORS.rose },
        { label: "Clarity Score", val: isInsufficient ? "N/A" : `${scores.clarity}%`, trend: "-9% vs avg", tColor: COLORS.rose }
      ];

      let cardX = 50;
      metrics.forEach((m) => {
        doc.rect(cardX, 550, 72, 70).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(6.5).fillColor(COLORS.textLight).text(m.label, cardX + 5, 558, { width: 62, align: "center" });
        doc.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.dark).text(m.val, cardX + 5, 578, { width: 62, align: "center" });
        doc.font("Helvetica-Bold").fontSize(6.5).fillColor(m.tColor).text(m.trend, cardX + 5, 598, { width: 62, align: "center" });
        cardX += 84;
      });

      // 30-Second practice plan at the bottom
      doc.rect(50, 640, 495, 120).fill("#EEF2FF").strokeColor("#C7D2FE").lineWidth(1).stroke();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.primary).text("YOUR PERSONALIZED 30-SECOND PRACTICE PLAN", 65, 652);
      
      // Giant circle
      doc.circle(95, 705, 30).fill(COLORS.white);
      doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.primary).text("30", 65, 692, { align: "center", width: 60 });
      doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.primary).text("SEC", 65, 712, { align: "center", width: 60 });

      // Steps
      const steps = [
        { title: "1. Define the Problem", time: "10 sec", desc: "State the problem in one clear sentence." },
        { title: "2. Present Your Solution", time: "10 sec", desc: "Explain how your startup solves it." },
        { title: "3. Market & Vision", time: "10 sec", desc: "Share market size and your ultimate vision." }
      ];

      let stepX = 145;
      steps.forEach((s) => {
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.dark).text(s.title, stepX, 665);
        doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(s.desc, stepX, 678, { width: 110 });
        doc.roundedRect(stepX, 710, 45, 12, 6).fill(COLORS.border);
        doc.font("Helvetica-Bold").fontSize(6.5).fillColor(COLORS.textLight).text(s.time, stepX, 713, { align: "center", width: 45 });
        stepX += 135;
      });

      // =======================================================================
      // PAGE 3 — PERFORMANCE & DELIVERY ANALYTICS
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Performance & Delivery Analytics");

      // Speaking analytics row
      const stats = [
        { title: "Speaking Pace", val: "148 WPM", desc: "Moderate (Ideal: 130-160)", color: COLORS.primary },
        { title: "Confidence Score", val: isInsufficient ? "N/A" : `${scores.delivery}%`, desc: "Moderate (Ideal: 70%+)", color: COLORS.secondary },
        { title: "Clarity Score", val: isInsufficient ? "N/A" : `${scores.clarity}%`, desc: "Needs Improvement", color: COLORS.rose },
        { title: "Filler Words", val: "12%", desc: "High (Ideal: <5%)", color: COLORS.amber },
        { title: "Average Pause", val: "2.1 sec", desc: "Slightly Long", color: COLORS.indigo }
      ];

      let statX = 50;
      stats.forEach((s) => {
        doc.rect(statX, 80, 90, 80).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(7).fillColor(COLORS.textLight).text(s.title, statX + 5, 88, { width: 80, align: "center" });
        doc.font("Helvetica-Bold").fontSize(13).fillColor(s.color).text(s.val, statX + 5, 105, { width: 80, align: "center" });
        doc.font("Helvetica").fontSize(6).fillColor(COLORS.text).text(s.desc, statX + 5, 125, { width: 80, align: "center" });
        statX += 101;
      });

      // Charts split
      // Left: Confidence & Sentiment line chart
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("CONFIDENCE & SENTIMENT OVER TIME", 50, 180);
      const timelinePoints = [
        { xVal: "0:00", yVal: 85 },
        { xVal: "1:30", yVal: 70 },
        { xVal: "3:00", yVal: 65 },
        { xVal: "4:30", yVal: 48 },
        { xVal: "6:00", yVal: 55 }
      ];
      drawLineChart(doc, 50, 200, 270, 110, timelinePoints, 100, COLORS.primary);
      doc.font("Helvetica").fontSize(7).fillColor(COLORS.textLight).text("Time (minutes)", 50, 318, { width: 270, align: "center" });

      // Right: Question Difficulty donut
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("QUESTION DIFFICULTY", 345, 180);
      const difficultySects = [
        { value: 25, color: COLORS.emerald }, // Easy
        { value: 37, color: COLORS.amber },   // Medium
        { value: 38, color: COLORS.rose }      // Hard
      ];
      drawDonutChart(doc, 400, 245, 30, difficultySects);
      
      // Donut Legend
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.dark).text("Difficulty Breakdown", 450, 210);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.textLight).text("• Easy: 25% (Well Answered)", 450, 225);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.textLight).text("• Medium: 37% (Partial)", 450, 238);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.textLight).text("• Hard: 38% (Avoided/Poor)", 450, 251);

      // Question list below difficulty
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.dark).text("TOUGHEST QUESTIONS", 345, 290);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text("1. Market Size calculation methodology?", 345, 305);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text("2. Unit economics structure details?", 345, 318);

      // Table Matrix: Detailed Category Breakdown
      doc.y = 350;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("DETAILED CATEGORY MATRIX", 50, doc.y);
      
      const tableHeaders = ["Category", "Score", "What Went Well", "What Needs Improvement", "Impact"];
      const tableRows = [
        ["Delivery", "60/100", "Strong opening and tone.", "Inconsistent pace at points.", "Moderate"],
        ["Clarity", "55/100", "Problem statements are clear.", "Market sizes not explained.", "Moderate"],
        ["Scalability", "40/100", "Market segment is large.", "Lack of clear scaling plan.", "High"],
        ["Readiness", "35/100", "Passionate about vision.", "Unit economics not defined.", "High"]
      ];

      // Draw table header
      let ty = 370;
      doc.rect(50, ty, 495, 18).fill(COLORS.primary);
      let tx = 55;
      const colWidths = [85, 45, 140, 160, 60];
      tableHeaders.forEach((th, idx) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.white).text(th, tx, ty + 5);
        tx += colWidths[idx];
      });

      // Draw rows
      ty += 18;
      tableRows.forEach((row) => {
        doc.rect(50, ty, 495, 30).fill(ty % 20 === 0 ? COLORS.bgLight : COLORS.white).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        tx = 55;
        row.forEach((cell, idx) => {
          doc.font(idx === 0 || idx === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).fillColor(COLORS.text).text(cell, tx, ty + 8, { width: colWidths[idx] - 10 });
          tx += colWidths[idx];
        });
        ty += 30;
      });

      // Benchmarking section
      ty += 15;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("FOUNDER BENCHMARKING", 50, ty);
      
      // Gauge
      drawGaugeChart(doc, 110, ty + 65, 40, isInsufficient ? 0 : 37, "Percentile Rank", COLORS.emerald);
      
      // Benchmark progress bar chart
      let barY = ty + 30;
      const benchmarkData = [
        { label: "Your Score", val: isInsufficient ? 0 : overallScore, color: COLORS.primary },
        { label: "Avg Founders", val: 42, color: COLORS.textLight },
        { label: "Top 25% Founders", val: 68, color: COLORS.emerald },
        { label: "Top 10% Founders", val: 80, color: COLORS.secondary }
      ];

      benchmarkData.forEach((b) => {
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.text).text(b.label, 175, barY);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.dark).text(`${b.val}`, 465, barY);
        doc.roundedRect(260, barY + 1, 200, 6, 3).fill(COLORS.border);
        if (b.val > 0) {
          doc.roundedRect(260, barY + 1, (b.val / 100) * 200, 6, 3).fill(b.color);
        }
        barY += 20;
      });

      // =======================================================================
      // PAGE 4 — COMPETITIVE LANDSCAPE & MARKET INTEL
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Competitive Landscape & Market Intelligence");

      // Table of Direct Competitors
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("DIRECT COMPETITOR MATRIX", 50, 80);
      const compHeaders = ["Company", "Similarity", "Strengths", "Weaknesses", "Est. Size"];
      const compRows = [
        ["PitchPal AI", "92%", "Excellent AI sandbox.", "High price point.", "$15M+"],
        ["DeckCoach", "86%", "Rich canvas editor.", "Lack of team roles.", "$10M+"],
        ["FounderPitch", "79%", "Strong user pool.", "No live evaluation.", "$25M+"],
        ["YC Pitch Practice", "65%", "Back by YC brand.", "Static text reviews.", "N/A"]
      ];

      let cty = 100;
      doc.rect(50, cty, 280, 18).fill(COLORS.primary);
      let ctx = 55;
      const cColWidths = [60, 45, 75, 70, 30];
      compHeaders.forEach((ch, idx) => {
        doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.white).text(ch, ctx, cty + 5);
        ctx += cColWidths[idx];
      });

      cty += 18;
      compRows.forEach((row) => {
        doc.rect(50, cty, 280, 24).fill(cty % 20 === 0 ? COLORS.bgLight : COLORS.white).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        ctx = 55;
        row.forEach((cell, idx) => {
          doc.font(idx === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(7).fillColor(COLORS.text).text(cell, ctx, cty + 7, { width: cColWidths[idx] - 5 });
          ctx += cColWidths[idx];
        });
        cty += 24;
      });

      // Positioning Scatter Plot on the right
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("MARKET POSITIONING MAP", 345, 80);
      const mapPoints = [
        { name: "PitchNest (You)", xVal: 15, yVal: 70, color: COLORS.primary },
        { name: "PitchPal", xVal: 80, yVal: 60, color: COLORS.emerald },
        { name: "DeckCoach", xVal: 70, yVal: 20, color: COLORS.secondary },
        { name: "FounderPitch", xVal: 75, yVal: -30, color: COLORS.amber }
      ];
      drawScatterPlot(doc, 345, 100, 200, 140, mapPoints);
      doc.font("Helvetica").fontSize(6).fillColor(COLORS.textLight).text("Broad Focus", 345, 245, { width: 200, align: "right" });
      doc.font("Helvetica").fontSize(6).fillColor(COLORS.textLight).text("Niche Focus", 345, 245, { width: 200, align: "left" });

      // SWOT Grid (4 quadrants)
      doc.y = 265;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("SWOT ANALYSIS", 50, doc.y);
      
      const swot = [
        { title: "STRENGTHS", color: COLORS.emerald, items: ["AI-powered VC simulation.", "Tailored for African markets.", "Affordable pricing model."] },
        { title: "WEAKNESSES", color: COLORS.rose, items: ["Early product traction.", "No native integration yet.", "Lack of unit economics details."] },
        { title: "OPPORTUNITIES", color: COLORS.secondary, items: ["Expanding into global VCs.", "Integrations with Pitch Decks.", "Analytics database insight."] },
        { title: "THREATS", color: COLORS.amber, items: ["Big Tech AI tools.", "Feature copy by competitors.", "Rising API token costs."] }
      ];

      let swotY = 285;
      swot.forEach((sect, idx) => {
        const sx = idx % 2 === 0 ? 50 : 300;
        const sy = idx < 2 ? swotY : swotY + 115;
        doc.rect(sx, sy, 245, 105).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(sect.color).text(sect.title, sx + 15, sy + 10);
        
        let iy = sy + 28;
        sect.items.forEach((item) => {
          doc.font("Helvetica").fontSize(7.5).fillColor(sect.color).text("• ", sx + 15, iy);
          doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(item, sx + 25, iy, { width: 205 });
          iy += 20;
        });
      });

      // Gap Analysis & Studying
      doc.y = swotY + 235;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("MARKET GAP ANALYSIS", 50, doc.y);
      doc.rect(50, doc.y + 15, 235, 105).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.dark).text("Localized simulation is missing:", 65, doc.y + 25);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text("Almost all other pitch platforms focus strictly on US-market standards. PitchNest covers specific local emerging markets and VC questions.", 65, doc.y + 38, { width: 205, lineGap: 3 });

      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("INDIRECT COMPETITOR STUDIES", 300, doc.y);
      doc.rect(300, doc.y + 15, 245, 105).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      const studies = [
        { name: "Canva", why: "UX simplicity & modular templates." },
        { name: "Notion", why: "Strong builder workspace community." }
      ];
      let studyY = doc.y + 25;
      studies.forEach((std) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.primary).text(std.name, 315, studyY);
        doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(`Study: ${std.why}`, 315, studyY + 10);
        studyY += 38;
      });

      // AI recommendation card
      doc.y += 130;
      doc.rect(50, doc.y, 495, 60).fill("#EEF2FF").strokeColor("#C7D2FE").lineWidth(1).stroke();
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.primary).text("AI STRATEGIC REACTION SUMMARY", 65, doc.y + 10);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(
        "Focus heavily on demonstrating defensibility and unit economics in early phases of the pitch, as this is the primary area of investor pushback.",
        65,
        doc.y + 25,
        { width: 465, lineGap: 2.5 }
      );

      // =======================================================================
      // PAGE 5 — TRANSCRIPT & DIALOGUE TIMELINE
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Session Transcript & Analytics");

      // Left Column: Dialogue Timeline
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("DIALOGUE TIMELINE", 50, 80);
      
      let transY = 100;
      if (transcript.length === 0) {
        // Fallback transcript
        const mockTrans = [
          { speaker: "Marcus", text: "Welcome to PitchNest! We are excited to hear your pitch today.", type: "agent" },
          { speaker: "Founder", text: "Thank you. We are building an AI coaching platform for African founders.", type: "user" },
          { speaker: "Sarah", text: "Tell me about your market size. How many potential users are there?", type: "agent" },
          { speaker: "Founder", text: "We project to reach around 5 million early-stage founders on our platform.", type: "user" },
          { speaker: "Marcus", text: "[Verdict] PASS. The market size feels overly optimistic without clear metrics.", type: "agent" }
        ];
        mockTrans.forEach((t) => {
          doc.rect(50, transY, 310, 48).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
          const isUser = t.type === "user";
          doc.font("Helvetica-Bold").fontSize(8).fillColor(isUser ? COLORS.primary : COLORS.secondary).text(t.speaker, 60, transY + 8);
          doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(`"${t.text}"`, 60, transY + 20, { width: 290 });
          transY += 56;
        });
      } else {
        // Render up to 5 dialog entries
        transcript.slice(0, 5).forEach((t) => {
          doc.rect(50, transY, 310, 52).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
          const isUser = t.type === "user";
          const label = isUser ? "FOUNDER" : (t.speaker || "INVESTOR");
          doc.font("Helvetica-Bold").fontSize(8).fillColor(isUser ? COLORS.primary : COLORS.secondary).text(label, 60, transY + 8);
          doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(`"${t.text || ""}"`, 60, transY + 20, { width: 290, lineGap: 2 });
          transY += 60;
        });
      }

      // Right Column Panel
      // Key Moments
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.dark).text("TIMELINE MOMENTS", 380, 80);
      doc.rect(380, 100, 165, 120).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.secondary).text("0:19", 390, 112);
      doc.font("Helvetica").fontSize(7.2).fillColor(COLORS.text).text("Founder explains core features.", 415, 112, { width: 120 });
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.secondary).text("1:28", 390, 140);
      doc.font("Helvetica").fontSize(7.2).fillColor(COLORS.text).text("Market size debate begins.", 415, 140, { width: 120 });
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.secondary).text("2:00", 390, 168);
      doc.font("Helvetica").fontSize(7.2).fillColor(COLORS.text).text("Session concludes.", 415, 168, { width: 120 });

      // Topic Coverage
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.dark).text("TOPIC COVERAGE", 380, 240);
      const topicSects = [
        { value: 40, color: COLORS.primary },
        { value: 30, color: COLORS.secondary },
        { value: 15, color: COLORS.amber },
        { value: 15, color: COLORS.rose }
      ];
      drawDonutChart(doc, 430, 310, 25, topicSects, "62%");
      
      // Topic legend
      let topicY = 265;
      const legend = ["Problem Definition", "Solution Overview", "Market Size", "Financials"];
      topicSects.forEach((s, idx) => {
        doc.circle(480, topicY + 4, 3).fill(s.color);
        doc.font("Helvetica").fontSize(6.5).fillColor(COLORS.textLight).text(legend[idx], 490, topicY);
        topicY += 12;
      });

      // AI Summary text
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.dark).text("TRANSCRIPT ANALYSIS SUMMARY", 380, 370);
      doc.rect(380, 385, 165, 130).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(7.2).fillColor(COLORS.text).text(
        "The founder effectively outlined the startup vision but struggled during follow-up Q&A, specifically regarding the customer growth trajectory and infrastructure costs.",
        390, 400,
        { width: 145, lineGap: 3 }
      );

      // Reflection
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.dark).text("FOUNDER REFLECTION NOTES", 380, 535);
      doc.rect(380, 550, 165, 180).fill("#FDFDFD").strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.textLight).text("Use this section to write down your notes on areas to focus on next session...", 390, 565, { width: 145, lineGap: 3.5 });

      // =======================================================================
      // PAGE 6 — ACTION PLAN & PROGRESSION TRACKING
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Personalized Action Plan");

      // Action plan overview header
      doc.rect(50, 80, 495, 60).fill("#EEF2FF").strokeColor("#C7D2FE").lineWidth(1).stroke();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.primary).text("YOUR TARGET GOAL ACTION PLAN", 65, 92);
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text("Follow the concrete improvements below to prepare for your next live investor pitch.", 65, 108);
      doc.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.emerald).text("78/100", 475, 100);
      doc.font("Helvetica").fontSize(6.5).fillColor(COLORS.textLight).text("TARGET SCORE", 475, 118);

      // Top 5 Priority Cards
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("TOP 5 PRIORITY IMPROVEMENTS", 50, 160);
      const priorities = [
        { title: "Market Argument", desc: "Build bottom-up size estimation model.", priority: "High", color: COLORS.rose },
        { title: "Unit Economics", desc: "Clarify gross margins and LTV metrics.", priority: "High", color: COLORS.rose },
        { title: "Tech Roadmap", desc: "Map architecture scalability stages.", priority: "Medium", color: COLORS.amber },
        { title: "Social Proof", desc: "List pilot test metrics or customer letters.", priority: "Medium", color: COLORS.amber },
        { title: "GTM Pipeline", desc: "Outline core lead acquisition paths.", priority: "Medium", color: COLORS.amber }
      ];

      let pX = 50;
      priorities.forEach((p, idx) => {
        doc.rect(pX, 180, 90, 130).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.circle(pX + 20, 205, 10).fill(p.color);
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.white).text(`${idx + 1}`, pX + 17, 201, { width: 6, align: "center" });
        
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.dark).text(p.title, pX + 8, 225, { width: 74 });
        doc.font("Helvetica").fontSize(6.5).fillColor(COLORS.textLight).text(p.desc, pX + 8, 248, { width: 74, lineGap: 2 });
        
        doc.font("Helvetica-Bold").fontSize(6).fillColor(p.color).text(`${p.priority} Priority`, pX + 8, 295);
        pX += 101;
      });

      // Prepare questions
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("QUESTIONS TO PREPARE FOR", 50, 330);
      const questions = [
        "1. What is your customer acquisition cost (CAC)?",
        "2. Detail your technical scaling roadmap?",
        "3. Defensibility strategy against global clones?",
        "4. Exact pilot metrics and early conversion rates?"
      ];
      let qY = 350;
      questions.forEach((q) => {
        doc.rect(50, qY, 235, 24).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.text).text(q, 60, qY + 8);
        qY += 28;
      });

      // Suggested answer framework
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("SUGGESTED ANSWER FRAMEWORK", 300, 330);
      doc.rect(300, 350, 245, 108).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.primary).text("Structure: Context → Action → Result", 315, 362);
      doc.font("Helvetica").fontSize(7).fillColor(COLORS.text).text(
        "Acknowledge the question details clearly. Provide specific quantitative benchmarks immediately, then detail your mitigation strategy or validation test results.",
        315, 378,
        { width: 215, lineGap: 3.5 }
      );

      // Practice drills
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("PRACTICE DRILLS FOR NEXT SESSION", 50, 480);
      const drills = [
        { name: "Elevator Pitch", time: "60 sec", reps: "3 Reps" },
        { name: "Market Size Q&A", time: "7 min", reps: "2 Reps" },
        { name: "Unit Economics", time: "6 min", reps: "2 Reps" },
        { name: "Investor Simulation", time: "10 min", reps: "5 Qs" }
      ];
      let dX = 50;
      drills.forEach((d) => {
        doc.rect(dX, 500, 110, 50).fill(COLORS.bgLight).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.dark).text(d.name, dX + 10, 508);
        doc.font("Helvetica").fontSize(7).fillColor(COLORS.textLight).text(`${d.time} | ${d.reps}`, dX + 10, 524);
        dX += 128;
      });

      // Bottom progression grid
      // Left: Multi-session progress line chart
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("TRACK YOUR PROGRESS", 50, 570);
      const progPoints = [
        { xVal: "Session 1", yVal: 38 },
        { xVal: "Session 2", yVal: 48 },
        { xVal: "Session 3", yVal: 55 },
        { xVal: "Session 4", yVal: 62 },
        { xVal: "Session 5", yVal: 70 }
      ];
      drawLineChart(doc, 50, 590, 235, 110, progPoints, 100, COLORS.emerald);

      // Right: Target Success Metrics
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.dark).text("TARGET SUCCESS METRICS", 300, 570);
      const targets = [
        { label: "Overall Score", current: overallScore, target: 78, color: COLORS.primary },
        { label: "Confidence", current: scores.delivery, target: 75, color: COLORS.secondary },
        { label: "Clarity", current: scores.clarity, target: 70, color: COLORS.rose },
        { label: "Readiness", current: scores.readiness, target: 70, color: COLORS.emerald }
      ];
      let targetY = 590;
      targets.forEach((t) => {
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.text).text(t.label, 300, targetY);
        doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.textLight).text(`${isInsufficient ? 0 : t.current}% vs Goal: ${t.target}%`, 450, targetY, { align: "right", width: 90 });
        
        doc.roundedRect(300, targetY + 11, 240, 5, 2.5).fill(COLORS.border);
        if (!isInsufficient && t.current > 0) {
          doc.roundedRect(300, targetY + 11, (t.current / 100) * 240, 5, 2.5).fill(t.color);
        }
        targetY += 28;
      });

      // ── Footer loops ───────────────────────────────────────────────────────
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 1; i <= totalPages; i++) {
        doc.switchToPage(i - 1);
        drawFooter(doc, i, totalPages);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
