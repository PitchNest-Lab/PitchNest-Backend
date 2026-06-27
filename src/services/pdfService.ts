import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";
import { computeFounderPercentile, AVERAGE_FOUNDER_SCORE } from "./aiService.ts";

type PDFDoc = InstanceType<typeof PDFDocument>;

// ── Resolve asset paths ──────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");
const LOGO_PATH = path.resolve(ASSETS_DIR, "logo.png");
const FONT_REGULAR = path.resolve(ASSETS_DIR, "fonts", "Inter-Regular.ttf");
const FONT_BOLD = path.resolve(ASSETS_DIR, "fonts", "Inter-Bold.ttf");

// ── Color palette ────────────────────────────────────────────────────────────
const COLORS = {
  primary: "#3b52c4",
  primaryDark: "#1a2e6e",
  secondary: "#0ea5e9",
  dark: "#111827",
  text: "#374151",
  textLight: "#6b7280",
  border: "#e5e7eb",
  bgLight: "#f7f8fb",
  cardBg: "#f3f4f6",
  emerald: "#16a34a",
  emeraldBg: "#f0fdf4",
  emeraldBorder: "#bbf7d0",
  rose: "#ef4444",
  roseBg: "#fef2f2",
  roseBorder: "#fecaca",
  amber: "#f59e0b",
  amberBg: "#fffbeb",
  amberBorder: "#fde68a",
  indigo: "#3b52c4",
  indigoBg: "#e8edf8",
  white: "#ffffff",
  violet: "#8b5cf6",
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

function getScoreAccentColor(score: number): string {
  if (score >= 80) return COLORS.emerald;
  if (score >= 60) return COLORS.primary;
  if (score >= 40) return COLORS.amber;
  return COLORS.rose;
}

// Competitor sizes are AI estimates — never render a bare precise figure as
// fact. Mirrors the guard in aiService.validateEvaluationReport (belt-and-suspenders).
function hedgeSize(v: unknown): string {
  const s = String(v || "").trim();
  if (!s || s.toUpperCase() === "N/A") return "N/A";
  return /est|approx|~/i.test(s) ? s : `Est. ${s}`;
}

// Compact form for the page-4 "Est. Size" column: the estimate caveat is carried
// by the column header + disclaimer, so we strip the redundant "Est."/"approx."
// prefix, the "~", and a trailing "ARR" to keep each cell on one line.
function compactSize(v: unknown): string {
  let s = String(v || "").trim();
  if (!s || s.toUpperCase() === "N/A") return "N/A";
  s = s
    .replace(/^(?:est\.?|approx\.?|approximately|around|about)\s*/i, "")
    .replace(/~\s*/g, "")
    .replace(/\s*ARR\b/i, "")
    .trim();
  return s || "N/A";
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

// ── Delivery metrics computed from the REAL transcript ───────────────────────
// Code owns every number on the report. Anything not derivable from the saved
// transcript is returned as null so the caller renders "N/A" (honestly absent)
// instead of a fabricated placeholder. We deliberately do NOT compute Speaking
// Pace (WPM), Average Pause, or Avg Response: those need per-utterance audio
// timestamps the session does not record, and a fake number on the one claim a
// founder can personally disprove would discredit the whole report.
const FILLER_RE =
  /\b(?:u+m+|u+h+|e+r+|e+h+|a+h+|hmm+|like|y'?know|you know|i mean|sort of|kind of|kinda|sorta|basically|literally|actually)\b/gi;

interface DeliveryMetrics {
  founderWords: number | null;
  fillerPct: number | null;
  questionsAsked: number | null;
  talkRatioPct: number | null;
}
function computeDeliveryMetrics(transcript: unknown): DeliveryMetrics {
  const empty: DeliveryMetrics = {
    founderWords: null,
    fillerPct: null,
    questionsAsked: null,
    talkRatioPct: null,
  };
  if (!Array.isArray(transcript) || transcript.length === 0) return empty;

  const wordCount = (s: string) => (s.trim().match(/\S+/g) || []).length;
  let founderWords = 0;
  let fillerCount = 0;
  let panelWords = 0;
  let questionsAsked = 0;
  let hasFounderTurn = false;

  for (const m of transcript as any[]) {
    if (m?.type === "user") {
      hasFounderTurn = true;
      // Voice turns store the verbatim utterance in `fullText`; `text` holds a
      // short summary. Use the raw utterance so word and filler counts reflect
      // what the founder actually said, not the summarized version.
      const raw = String(m.fullText || m.text || "");
      founderWords += wordCount(raw);
      const fillers = raw.match(FILLER_RE);
      if (fillers) fillerCount += fillers.length;
    } else if (m?.text) {
      const t = String(m.text);
      panelWords += wordCount(t);
      // A panel turn that contains a question mark counts as one question asked.
      if (/\?/.test(t)) questionsAsked += 1;
    }
  }

  if (!hasFounderTurn) return empty;
  const totalWords = founderWords + panelWords;
  return {
    founderWords: founderWords > 0 ? founderWords : 0,
    fillerPct: founderWords > 0 ? Math.round((fillerCount / founderWords) * 100) : null,
    questionsAsked, // 0 is a real, valid answer
    talkRatioPct: totalWords > 0 ? Math.round((founderWords / totalWords) * 100) : null,
  };
}

// ── Pattern B: word-boundary truncation ──────────────────────────────────────
// One shared truncator: never cuts mid-word, appends a single standard ellipsis,
// and verifies the result fits within `width` × `maxLines` using heightOfString.
// Prefer raising maxLines/width so full text fits; only truncate when needed.
const ELLIPSIS = "…";
function fitText(
  doc: PDFDoc,
  text: string,
  width: number,
  font: string,
  fontSize: number,
  maxLines: number,
  lineGap = 0,
): string {
  if (!text) return "";
  doc.font(font).fontSize(fontSize);
  const lineH = doc.currentLineHeight();
  const maxHeight = maxLines * lineH + Math.max(0, maxLines - 1) * lineGap + 0.5;
  if (doc.heightOfString(text, { width, lineGap }) <= maxHeight) return text;

  const words = text.split(/\s+/);
  let result = "";
  for (let i = 0; i < words.length; i++) {
    const candidate = (result ? result + " " : "") + words[i];
    if (doc.heightOfString(candidate + ELLIPSIS, { width, lineGap }) > maxHeight) break;
    result = candidate;
  }
  result = result.replace(/[\s,.;:—-]+$/, "");
  return result ? result + ELLIPSIS : (words[0] || "") + ELLIPSIS;
}

// ── Pattern B2: sentence-complete truncation (for prose "writeups") ───────────
// Long-form paragraphs (executive summary, transcript summary, strategic
// recommendation) must never end mid-sentence with a dangling "…for". This packs
// as many WHOLE sentences as the reserved space allows and ends cleanly on a
// period — no ellipsis. Only if not even the first sentence fits do we fall back
// to fitText's word-boundary cut (which is still never mid-word).
function fitTextBySentence(
  doc: PDFDoc,
  text: string,
  width: number,
  font: string,
  fontSize: number,
  maxLines: number,
  lineGap = 0,
): string {
  const full = (text || "").trim();
  if (!full) return "";
  doc.font(font).fontSize(fontSize);
  const lineH = doc.currentLineHeight();
  const maxHeight = maxLines * lineH + Math.max(0, maxLines - 1) * lineGap + 0.5;
  if (doc.heightOfString(full, { width, lineGap }) <= maxHeight) return full;

  // Split on sentence terminators, keeping the punctuation (and any closing
  // quote/bracket) attached to each sentence.
  const sentences = full.match(/[^.!?]+[.!?]+["'”’)\]]*\s*|[^.!?]+$/g) || [full];
  let result = "";
  for (const s of sentences) {
    const candidate = (result + s).replace(/\s+$/, "");
    if (doc.heightOfString(candidate, { width, lineGap }) > maxHeight) break;
    result += s;
  }
  result = result.trim();
  if (result) return result;
  // First sentence alone overflows — fall back to a clean word-boundary cut.
  return fitText(doc, full, width, font, fontSize, maxLines, lineGap);
}

// ── Pattern A: dynamic row heights ───────────────────────────────────────────
// Measure a row's height as the tallest cell, so wrapping text never overlaps
// the next element. Shared by the page-3 matrix and page-4 competitor table so
// their height logic can't diverge.
interface RowCell {
  text: string;
  font?: string;
  fontSize?: number;
  color?: string;
  align?: "left" | "right" | "center";
}
function measureRowHeight(
  doc: PDFDoc,
  cells: RowCell[],
  colWidths: number[],
  padX: number,
  padY: number,
  lineGap: number,
  minHeight = 0,
): number {
  let contentH = 0;
  cells.forEach((cell, i) => {
    const w = colWidths[i] - padX * 2;
    doc.font(cell.font || "Inter").fontSize(cell.fontSize ?? 7.5);
    const h = doc.heightOfString(cell.text || "", { width: w, lineGap });
    if (h > contentH) contentH = h;
  });
  return Math.max(minHeight, contentH + padY * 2);
}
function drawTableRow(
  doc: PDFDoc,
  x: number,
  y: number,
  colWidths: number[],
  cells: RowCell[],
  opts: { padX?: number; padY?: number; fill?: string; border?: string; minHeight?: number; lineGap?: number } = {},
): number {
  const padX = opts.padX ?? 5;
  const padY = opts.padY ?? 6;
  const lineGap = opts.lineGap ?? 1.5;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const rowH = measureRowHeight(doc, cells, colWidths, padX, padY, lineGap, opts.minHeight ?? 0);

  if (opts.fill || opts.border) {
    doc.rect(x, y, totalWidth, rowH).lineWidth(0.5);
    if (opts.fill && opts.border) doc.fillAndStroke(opts.fill, opts.border);
    else if (opts.fill) doc.fill(opts.fill);
    else doc.strokeColor(opts.border!).stroke();
  }

  let cx = x;
  cells.forEach((cell, i) => {
    const w = colWidths[i];
    doc
      .font(cell.font || "Inter")
      .fontSize(cell.fontSize ?? 7.5)
      .fillColor(cell.color || COLORS.text)
      .text(cell.text || "", cx + padX, y + padY, { width: w - padX * 2, align: cell.align || "left", lineGap });
    cx += w;
  });

  return y + rowH;
}

// ── Dynamic page break helper ────────────────────────────────────────────────
// Call before every major section: if the remaining vertical space is less than
// `needed`, start a fresh page with a header so content never runs off the edge.
function ensureSpace(doc: PDFDoc, needed: number, title: string): void {
  const bottomMargin = 80;
  if (doc.y + needed > doc.page.height - bottomMargin) {
    doc.addPage();
    drawHeader(doc, title);
    doc.y = 65;
  }
}

// ── Vector Icon Drawing System ───────────────────────────────────────────────
function drawIcon(doc: PDFDoc, name: string, x: number, y: number, size: number, color: string) {
  const s = size;
  const cx = x + s / 2;
  const cy = y + s / 2;
  const r = s / 2;

  doc.save();
  doc.fillColor(color).strokeColor(color).lineWidth(1.2);

  switch (name) {
    case "target": {
      doc.circle(cx, cy, r * 0.85).stroke();
      doc.circle(cx, cy, r * 0.55).stroke();
      doc.circle(cx, cy, r * 0.2).fill();
      break;
    }
    case "calculator": {
      doc.roundedRect(x + s * 0.15, y + s * 0.08, s * 0.7, s * 0.84, 2).stroke();
      doc.rect(x + s * 0.25, y + s * 0.18, s * 0.5, s * 0.2).fill();
      // Grid dots
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          doc.circle(x + s * 0.3 + col * s * 0.2, y + s * 0.52 + row * s * 0.12, 1.5).fill();
        }
      }
      break;
    }
    case "trending_up": {
      doc.lineWidth(1.8);
      doc.moveTo(x + s * 0.1, y + s * 0.75)
        .lineTo(x + s * 0.35, y + s * 0.45)
        .lineTo(x + s * 0.55, y + s * 0.55)
        .lineTo(x + s * 0.9, y + s * 0.2)
        .stroke();
      // Arrow head
      doc.moveTo(x + s * 0.9, y + s * 0.2)
        .lineTo(x + s * 0.75, y + s * 0.2)
        .stroke();
      doc.moveTo(x + s * 0.9, y + s * 0.2)
        .lineTo(x + s * 0.9, y + s * 0.35)
        .stroke();
      break;
    }
    case "shield": {
      doc.lineWidth(1.5);
      doc.moveTo(cx, y + s * 0.08)
        .lineTo(x + s * 0.85, y + s * 0.25)
        .lineTo(x + s * 0.85, y + s * 0.55)
        .quadraticCurveTo(cx, y + s * 0.95, cx, y + s * 0.95)
        .quadraticCurveTo(x + s * 0.15, y + s * 0.55, x + s * 0.15, y + s * 0.55)
        .lineTo(x + s * 0.15, y + s * 0.25)
        .closePath()
        .stroke();
      break;
    }
    case "checkmark": {
      doc.lineWidth(2.2);
      doc.moveTo(x + s * 0.2, cy)
        .lineTo(x + s * 0.42, y + s * 0.72)
        .lineTo(x + s * 0.82, y + s * 0.28)
        .stroke();
      break;
    }
    case "dollar": {
      doc.circle(cx, cy, r * 0.85).stroke();
      doc.font("Inter-Bold").fontSize(s * 0.5).fillColor(color)
        .text("$", x, cy - s * 0.22, { width: s, align: "center" });
      break;
    }
    case "network": {
      const nodes = [
        { nx: cx, ny: y + s * 0.15 },
        { nx: x + s * 0.15, ny: y + s * 0.55 },
        { nx: x + s * 0.85, ny: y + s * 0.55 },
        { nx: cx, ny: y + s * 0.85 },
      ];
      doc.lineWidth(1);
      // Lines
      doc.moveTo(nodes[0].nx, nodes[0].ny).lineTo(nodes[1].nx, nodes[1].ny).stroke();
      doc.moveTo(nodes[0].nx, nodes[0].ny).lineTo(nodes[2].nx, nodes[2].ny).stroke();
      doc.moveTo(nodes[1].nx, nodes[1].ny).lineTo(nodes[3].nx, nodes[3].ny).stroke();
      doc.moveTo(nodes[2].nx, nodes[2].ny).lineTo(nodes[3].nx, nodes[3].ny).stroke();
      // Dots
      nodes.forEach(n => doc.circle(n.nx, n.ny, 2.5).fill());
      break;
    }
    case "microphone": {
      doc.roundedRect(cx - s * 0.15, y + s * 0.1, s * 0.3, s * 0.45, s * 0.15).stroke();
      doc.lineWidth(1.3);
      doc.moveTo(x + s * 0.2, y + s * 0.45)
        .quadraticCurveTo(x + s * 0.2, y + s * 0.7, cx, y + s * 0.7)
        .quadraticCurveTo(x + s * 0.8, y + s * 0.7, x + s * 0.8, y + s * 0.45)
        .stroke();
      doc.moveTo(cx, y + s * 0.7).lineTo(cx, y + s * 0.85).stroke();
      doc.moveTo(x + s * 0.3, y + s * 0.85).lineTo(x + s * 0.7, y + s * 0.85).stroke();
      break;
    }
    case "user": {
      doc.circle(cx, y + s * 0.3, s * 0.2).stroke();
      doc.lineWidth(1.5);
      doc.moveTo(x + s * 0.15, y + s * 0.9)
        .quadraticCurveTo(cx, y + s * 0.55, x + s * 0.85, y + s * 0.9)
        .stroke();
      break;
    }
    case "arrow_up": {
      doc.lineWidth(2);
      doc.moveTo(cx, y + s * 0.15).lineTo(cx, y + s * 0.85).stroke();
      doc.moveTo(cx, y + s * 0.15)
        .lineTo(x + s * 0.3, y + s * 0.4)
        .stroke();
      doc.moveTo(cx, y + s * 0.15)
        .lineTo(x + s * 0.7, y + s * 0.4)
        .stroke();
      break;
    }
    case "speech_bubble": {
      doc.roundedRect(x + s * 0.08, y + s * 0.1, s * 0.84, s * 0.55, 4).stroke();
      doc.moveTo(x + s * 0.25, y + s * 0.65)
        .lineTo(x + s * 0.2, y + s * 0.85)
        .lineTo(x + s * 0.45, y + s * 0.65)
        .stroke();
      break;
    }
    case "gauge": {
      doc.lineWidth(3);
      doc.arc(cx, cy + s * 0.1, r * 0.7, Math.PI, 0).stroke();
      // Needle
      doc.lineWidth(1.5);
      doc.moveTo(cx, cy + s * 0.1)
        .lineTo(cx + r * 0.35, cy - s * 0.15)
        .stroke();
      doc.circle(cx, cy + s * 0.1, 2).fill();
      break;
    }
    case "bar_chart": {
      const barW = s * 0.15;
      const bars = [0.4, 0.7, 0.5, 0.9];
      bars.forEach((h, i) => {
        const bx = x + s * 0.12 + i * (barW + s * 0.08);
        const bh = s * 0.65 * h;
        const by = y + s * 0.85 - bh;
        doc.rect(bx, by, barW, bh).fill();
      });
      break;
    }
  }
  doc.restore();
}

// ── Header and Footer ────────────────────────────────────────────────────────
function drawHeader(doc: PDFDoc, title: string) {
  // Logo image
  try {
    doc.image(LOGO_PATH, 50, 12, { width: 24, height: 24 });
  } catch {
    doc.roundedRect(50, 15, 20, 20, 4).fill(COLORS.primary);
    doc.font("Inter-Bold").fontSize(11).fillColor(COLORS.white).text("P", 50, 20, { width: 20, align: "center" });
  }

  // Brand name
  doc.font("Inter-Bold").fontSize(14).fillColor(COLORS.primaryDark).text("PitchNest", 78, 17);

  // Right side header info
  doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.primary).text("AI-POWERED PITCH EVALUATION REPORT", 250, 16, { width: doc.page.width - 300, align: "right" });
  doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(`Generated on ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, 250, 26, { width: doc.page.width - 300, align: "right" });

  // Subtitle
  doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.textLight).text(title.toUpperCase(), 50, 42, { width: doc.page.width - 100, align: "left" });

  doc.moveTo(50, 54).lineTo(doc.page.width - 50, 54).strokeColor(COLORS.border).lineWidth(1).stroke();
}

function drawFooter(doc: PDFDoc, pageNum: number, totalPages: number) {
  const y = doc.page.height - 64;
  doc.moveTo(50, y - 5).lineTo(doc.page.width - 50, y - 5).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(
    `Generated by PitchNest AI · For the founder's improvement only · Not a guarantee of investment`,
    50, y, { width: 340, align: "left", lineBreak: false }
  );
  doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.textLight).text(
    `Page ${pageNum} of ${totalPages}`,
    doc.page.width - 130, y, { width: 80, align: "right", lineBreak: false }
  );
}

// ── Vector Charts ────────────────────────────────────────────────────────────
function drawRadarChart(doc: PDFDoc, cx: number, cy: number, radius: number, scores: { [key: string]: number }) {
  // Exactly the four scored categories — no unscored 5th axis (keeps the radar
  // consistent with the Category Breakdown bars).
  const axes = ["Delivery", "Clarity", "Scalability", "Readiness"];
  const numAxes = axes.length;

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

  for (let i = 0; i < numAxes; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / numAxes;
    doc.moveTo(cx, cy).lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)).stroke();
  }

  const scorePoints: { x: number; y: number }[] = [];
  axes.forEach((axis, i) => {
    const key = axis.toLowerCase().replace(/ /g, "");
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
    doc.fillOpacity(1.0);
  }

  axes.forEach((axis, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / numAxes;
    const lx = cx + (radius + 15) * Math.cos(angle);
    const ly = cy + (radius + 10) * Math.sin(angle);
    doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.text);
    let align: any = "center";
    if (Math.cos(angle) > 0.1) align = "left";
    if (Math.cos(angle) < -0.1) align = "right";
    doc.text(axis, lx - 40, ly - 4, { width: 80, align });
  });
}

function drawArc(doc: PDFDoc, cx: number, cy: number, radius: number, startAngle: number, endAngle: number, color: string, thickness: number) {
  const polarToCartesian = (centerX: number, centerY: number, r: number, angleInDegrees: number) => {
    const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
    return {
      x: centerX + r * Math.cos(angleInRadians),
      y: centerY + r * Math.sin(angleInRadians)
    };
  };

  if (endAngle - startAngle >= 359.9) {
    doc.lineWidth(thickness).strokeColor(color);
    doc.circle(cx, cy, radius).stroke();
    return;
  }

  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  const d = [
    "M", start.x, start.y,
    "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y
  ].join(" ");

  doc.path(d).lineWidth(thickness).strokeColor(color).stroke();
}

function drawDonutChart(doc: PDFDoc, cx: number, cy: number, radius: number, segments: { value: number; color: string }[], label?: string) {
  let currentAngle = 0;
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;

  segments.forEach((seg) => {
    const angleDiff = (seg.value / total) * 360;
    if (angleDiff <= 0) return;
    drawArc(doc, cx, cy, radius, currentAngle, currentAngle + angleDiff, seg.color, 12);
    currentAngle += angleDiff;
  });

  if (label) {
    doc.font("Inter-Bold").fontSize(11).fillColor(COLORS.dark).text(label, cx - 25, cy - 6, { width: 50, align: "center" });
  }
}

function drawLineChart(doc: PDFDoc, x: number, y: number, w: number, h: number, points: { xVal: string; yVal: number }[], yMax = 100, color = COLORS.primary, opts: { yAxis?: boolean } = {}) {
  doc.strokeColor(COLORS.border).lineWidth(1);
  doc.rect(x, y, w, h).stroke();

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const gy = y + (i / gridSteps) * h;
    if (i > 0 && i < gridSteps) {
      doc.moveTo(x, gy).lineTo(x + w, gy).dash(2, { space: 2 }).strokeColor(COLORS.border).stroke();
    }
    // Y-axis scale labels (yMax at top → 0 at bottom)
    if (opts.yAxis) {
      const val = Math.round(yMax - (i / gridSteps) * yMax);
      doc.font("Inter").fontSize(5.5).fillColor(COLORS.textLight).text(`${val}`, x - 20, gy - 3, { width: 16, align: "right" });
    }
  }
  doc.undash();

  if (points.length === 0) return;

  const stepX = w / (points.length > 1 ? points.length - 1 : 1);
  const mappedCoords = points.map((p, idx) => {
    const px = x + idx * stepX;
    const py = y + h - (clamp(p.yVal) / yMax) * h;
    return { x: px, y: py, label: p.xVal };
  });

  doc.moveTo(mappedCoords[0].x, mappedCoords[0].y).strokeColor(color).lineWidth(2);
  for (let i = 1; i < mappedCoords.length; i++) {
    doc.lineTo(mappedCoords[i].x, mappedCoords[i].y);
  }
  doc.stroke();

  mappedCoords.forEach((c) => {
    doc.circle(c.x, c.y, 3).fillColor(color).fill();
    doc.circle(c.x, c.y, 1.5).fillColor(COLORS.white).fill();
    const cleanLabel = c.label.replace("\n", " ");
    doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(cleanLabel, c.x - 20, y + h + 5, { width: 40, align: "center" });
  });
}

function drawScatterPlot(doc: PDFDoc, x: number, y: number, w: number, h: number, points: { name: string; xVal: number; yVal: number; color: string; labelPosition?: "left" | "right" }[]) {
  doc.strokeColor(COLORS.border).lineWidth(1);
  doc.rect(x, y, w, h).stroke();

  const cx = x + w / 2;
  const cy = y + h / 2;

  doc.moveTo(x, cy).lineTo(x + w, cy).dash(3, { space: 2 }).strokeColor(COLORS.border).stroke();
  doc.moveTo(cx, y).lineTo(cx, y + h).dash(3, { space: 2 }).stroke();
  doc.undash();

  points.forEach((p) => {
    const px = cx + (p.xVal / 100) * (w / 2);
    const py = cy - (p.yVal / 100) * (h / 2);
    doc.circle(px, py, 4).fillColor(p.color).fill();

    const alignRight = p.labelPosition !== "left";
    const labelX = alignRight ? px + 6 : px - 75;
    doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.dark).text(p.name, labelX, py - 3, { width: 70, align: alignRight ? "left" : "right" });
  });
}

function drawGaugeChart(doc: PDFDoc, cx: number, cy: number, radius: number, percentage: number, label: string, color: string) {
  drawArc(doc, cx, cy, radius, 0, 360, COLORS.border, 10);
  const activeEndAngle = (percentage / 100) * 360;
  if (activeEndAngle > 0) {
    drawArc(doc, cx, cy, radius, 0, activeEndAngle, color, 10);
  }
  doc.font("Inter-Bold").fontSize(18).fillColor(COLORS.primaryDark).text(`${percentage}%`, cx - 30, cy - 25, { width: 60, align: "center" });
  doc.font("Inter-Bold").fontSize(8).fillColor(color).text(label.toUpperCase(), cx - 60, cy - 5, { width: 120, align: "center" });
}

function drawHalfGaugeChart(doc: PDFDoc, cx: number, cy: number, radius: number, percentage: number, label: string, color: string, thickness: number = 10, textColor: string = COLORS.dark) {
  drawArc(doc, cx, cy, radius, 270, 90, COLORS.border, thickness);
  const activeEndAngle = 270 + (percentage / 100) * 180;
  if (percentage > 0) {
    drawArc(doc, cx, cy, radius, 270, activeEndAngle, color, thickness);
  }
  
  doc.font("Inter-Bold").fontSize(20).fillColor(textColor).text(`${percentage}%`, cx - 40, cy - 15, { width: 80, align: "center" });
  if (label) {
    doc.font("Inter-Bold").fontSize(8).fillColor(color).text(label.toUpperCase(), cx - 60, cy + 5, { width: 120, align: "center" });
  }
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

      // Register Inter fonts
      try {
        doc.registerFont("Inter", FONT_REGULAR);
        doc.registerFont("Inter-Bold", FONT_BOLD);
      } catch {
        // Fallback to Helvetica if Inter fonts not found
        doc.registerFont("Inter", "Helvetica");
        doc.registerFont("Inter-Bold", "Helvetica-Bold");
      }

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
      const strengths: string[] = Array.isArray(report.strengths) && report.strengths.length > 0
        ? report.strengths
        : [
            "Innovative application of AI to help founders practice, get feedback, and improve pitching.",
            "Solo and panel modes provide realistic practice and simulate real investor interactions.",
            "Targeting founders in Africa addresses a large, underserved, and high-potential community."
          ];
      const risks: string[] = Array.isArray(report.risks) && report.risks.length > 0
        ? report.risks
        : [
            "Projected 5M founders in Africa lacks clear methodology and detailed breakdown.",
            "No clarity on CAC, pricing, revenue model, or go-to-market plan.",
            "No information on AI architecture, data strategy, or scalability approach."
          ];
      const nextSteps: any[] = Array.isArray(report.next_steps) && report.next_steps.length > 0
        ? report.next_steps
        : [
            { title: "Develop Detailed Market Analysis", priority: "High Priority", desc: "Provide a clear breakdown of the total addressable market and realistic capture projections." },
            { title: "Clarify Unit Economics & GTM Strategy", priority: "High Priority", desc: "Outline customer acquisition costs, pricing model, and revenue projections." },
            { title: "Present Technical Infrastructure Plan", priority: "High Priority", desc: "Detail the AI system architecture, data pipeline, and scalability approach." }
          ];
      const sentiments: any[] = Array.isArray(report.sentiments) && report.sentiments.length > 0
        ? report.sentiments
        : [
            { persona: "Marcus (Lead Investor)", quote: "The market sizing feels overly optimistic without clear evidence of demand or competitive differentiation." },
            { persona: "Sarah (Partner)", quote: "The unit economics and customer acquisition strategy were not addressed, making it hard to gauge financial viability." },
            { persona: "Chen (Tech Investor)", quote: "The technical details and infrastructure plans were missing, so I'm unsure about feasibility." }
          ];

      // Dynamic data from AI evaluation (with hardcoded fallbacks)
      const topicCoverage: { topic: string; percentage: number; color: string }[] = (() => {
        const topicColors: Record<string, string> = {
          "Problem Definition": COLORS.emerald,
          "Solution Overview": COLORS.primary,
          "Market Size": COLORS.amber,
          "Business Model": COLORS.violet,
          "Go-to-Market": COLORS.secondary,
          "Traction": COLORS.rose,
          "Team": "#f97316",
          "Financials": "#ec4899",
          "Technical Details": "#06b6d4",
        };
        if (Array.isArray(report.topic_coverage) && report.topic_coverage.length > 0) {
          return report.topic_coverage.map((t: any) => ({
            topic: t.topic,
            percentage: clamp(t.percentage),
            color: topicColors[t.topic] || COLORS.primary,
          }));
        }
        return [
          { topic: "Problem Definition", percentage: 100, color: COLORS.emerald },
          { topic: "Solution Overview", percentage: 90, color: COLORS.primary },
          { topic: "Market Size", percentage: 35, color: COLORS.amber },
          { topic: "Business Model", percentage: 20, color: COLORS.violet },
          { topic: "Go-to-Market", percentage: 10, color: COLORS.secondary },
        ];
      })();

      const transcriptSummary: string = report.transcript_summary ||
        "The founder effectively introduced the concept and core features. However, the market size claim lacked justification and detail. Key areas such as unit economics, go-to-market strategy, traction, team, and technical infrastructure were not addressed, leading to a unanimous PASS verdict from the investor panel.";

      const questionsToPrepare: string[] = Array.isArray(report.questions_to_prepare) && report.questions_to_prepare.length > 0
        ? report.questions_to_prepare
        : [
            "How did you calculate your total addressable market?",
            "What is your pricing model and unit economics?",
            "How will you acquire your first 1,000 paying customers?",
            "What makes your product defensible against competitors?",
            "What is your technology roadmap for the next 12 months?",
            "Who is on your team and why are you the right team to win?"
          ];

      const swotData = report.competitive_landscape?.swot || {
        strengths: ["AI-powered investor & YC panel simulation", "Built specifically for African founders and investors", "Affordable and accessible pricing model", "Addresses a large and underserved market"],
        weaknesses: ["Limited brand awareness and early traction", "No clear unit economics yet", "Small team and limited resources", "Lack of enterprise integrations"],
        opportunities: ["Growing startup ecosystem in Africa", "Partnerships with accelerators and VCs", "Expansion into global emerging markets", "Add advanced analytics & fundraising insights"],
        threats: ["Large global players may enter the space", "Feature replication is easy", "Economic downturn may reduce startup funding", "User acquisition cost may rise over time"],
      };

      const strategicRecommendation: string = report.competitive_landscape?.strategic_recommendation ||
        "PitchNest is addressing a real and underserved need with a strong value proposition. The Africa-first focus and AI-driven panel simulation are strong differentiators. However, to compete with well-funded global players, show clear traction, refine unit economics, and build strong partnerships with local accelerators and VCs.";

      const keyFocusAreas: string[] = report.competitive_landscape?.key_focus_areas || [
        "Validate market demand with real users",
        "Prove unit economics and sustainability",
        "Build strategic partnerships",
        "Strengthen technical roadmap"
      ];

      const practiceDrills: any[] = Array.isArray(report.practice_drills) && report.practice_drills.length > 0
        ? report.practice_drills
        : [
            { title: "Elevator Pitch (60 sec)", desc: "Practice a clear, concise pitch that covers problem, solution, and value.", reps: "3 Reps", time: "5 min" },
            { title: "Market Size Breakdown", desc: "Present your TAM, SAM, SOM with clear numbers and sources.", reps: "2 Reps", time: "7 min" },
            { title: "Unit Economics Pitch", desc: "Explain pricing, CAC, LTV, and why the model is sustainable.", reps: "2 Reps", time: "6 min" },
            { title: "Investor Q&A Simulation", desc: "Answer tough investor questions with clarity and confidence.", reps: "5 Qs", time: "10 min" }
          ];

      const durationStr = report.duration ? `${Math.floor(report.duration / 60)}:${String(report.duration % 60).padStart(2, "0")}` : "06:12";

      // ── Dynamic data from new AI fields (with hardcoded fallbacks) ───────────
      const marketGaps: { title: string; desc: string }[] =
        Array.isArray(report.market_gaps) && report.market_gaps.length > 0
          ? report.market_gaps.slice(0, 4)
          : [
              { title: "Geographic Focus", desc: "Most tools focus on US/Europe — PitchNest is Africa-first." },
              { title: "Investor Simulation", desc: "Few platforms simulate local African investor dynamics." },
              { title: "Localized Insights", desc: "No localized templates or guidance for African founders." },
              { title: "Affordability", desc: "Competitors are too expensive for early-stage founders." },
            ];

      const collaborationOpportunities: string[] =
        Array.isArray(report.collaboration_opportunities) && report.collaboration_opportunities.length > 0
          ? report.collaboration_opportunities.slice(0, 4)
          : [
              "Partner with African accelerators and incubators for distribution",
              "Collaborate with VC firms to provide portfolio company training",
              "Build integrations with pitch deck tools (Tome, Beautiful.ai)",
              "Establish university partnerships for entrepreneurship programs",
            ];

      const questionDifficulty = report.question_difficulty || { easy: 2, medium: 3, hard: 3 };

      const vcInvestmentProbability =
        typeof report.vc_investment_probability === "number"
          ? report.vc_investment_probability
          : isInsufficient ? 0 : 18;

      // ── Phase 4: Fully dynamic fields ────────────────────────────────────────
      const competitorList = Array.isArray(report.competitors) && report.competitors.length > 0
        ? report.competitors.slice(0, 4)
        : [
            { name: "Competitor A", similarity: 80, strength: "Strong brand presence", weakness: "Limited geographic focus", size: "Est. ~$15M" },
            { name: "Competitor B", similarity: 72, strength: "Great UX and onboarding", weakness: "Higher price point", size: "Est. ~$10M" },
            { name: "Competitor C", similarity: 65, strength: "Large user base", weakness: "No AI features", size: "Est. ~$25M" },
            { name: "Competitor D", similarity: 55, strength: "Backed by top VCs", weakness: "Poor customer support", size: "N/A" },
          ];

      const studiesToShow = Array.isArray(report.companies_to_study) && report.companies_to_study.length > 0
        ? report.companies_to_study.slice(0, 4)
        : [
            { name: "Y Combinator", why: "Best-in-class founder education and network." },
            { name: "Stripe", why: "Exceptional developer experience and product-led growth." },
            { name: "Canva", why: "Mastered freemium conversion at global scale." },
            { name: "Notion", why: "Viral growth through templates and community sharing." },
          ];

      const priorityImprovements = Array.isArray(report.top_priorities) && report.top_priorities.length > 0
        ? report.top_priorities.slice(0, 5)
        : [
            { title: "Strengthen Market Size", desc: "Provide a detailed breakdown of your market with realistic capture projections.", priority: "High Priority", impact: "Very High" },
            { title: "Clarify Unit Economics", desc: "Define pricing model, CAC, LTV, and gross margin to show financial viability.", priority: "High Priority", impact: "Very High" },
            { title: "Present Technical Scale", desc: "Explain your architecture, data pipeline, and scalability strategy clearly.", priority: "High Priority", impact: "High" },
            { title: "Build Traction & Proof", desc: "Show early user adoption, testimonials, and partnership evidence.", priority: "Medium Priority", impact: "High" },
            { title: "Refine Go-to-Market", desc: "Outline customer acquisition channels, partnerships, and growth plan.", priority: "Medium Priority", impact: "Medium" },
          ];

      const frameworkData = report.answer_framework || {
        question: "How did you calculate your total addressable market?",
        steps: [
          { label: "Start with the Big Picture", text: "Reference total industry size using credible third-party sources." },
          { label: "Show Your Calculation", text: "Break down TAM into SAM and SOM with clear logical steps." },
          { label: "Market Capture Plan", text: "State your realistic capture percentage and the timeline to get there." },
          { label: "Back It Up with Data", text: "Cite sources like Statista, World Bank, or industry reports." },
          { label: "Close with Confidence", text: "Restate your conservative estimate and the levers available to expand it." },
        ],
      };

      const categoryMatrixRows = Array.isArray(report.category_matrix) && report.category_matrix.length > 0
        ? report.category_matrix.slice(0, 4)
        : [
            { category: "Delivery", went_well: "Strong opening tone and conviction.", needs_improvement: "Pace was inconsistent under pressure.", impact: "Moderate" },
            { category: "Clarity", went_well: "Problem statement was clearly framed.", needs_improvement: "Market sizing was not clearly explained.", impact: "Moderate" },
            { category: "Scalability", went_well: "Large market segment identified.", needs_improvement: "No clear scaling plan was articulated.", impact: "High" },
            { category: "Readiness", went_well: "Passionate about the vision.", needs_improvement: "Unit economics were not defined.", impact: "High" },
          ];

      const timelinePoints = Array.isArray(report.confidence_timeline) && report.confidence_timeline.length > 0
        ? report.confidence_timeline.map((p: any) => ({ xVal: p.time, yVal: p.value }))
        : [
            { xVal: "0:00", yVal: 85 },
            { xVal: "1:30", yVal: 70 },
            { xVal: "3:00", yVal: 65 },
            { xVal: "4:30", yVal: 48 },
            { xVal: "6:00", yVal: 55 },
          ];

      // Derived from the SAME overall score shown on the page, so the percentile
      // is identical on p1 and p3 and can never read above-average for a
      // below-average score. Phrased everywhere as "scored higher than X%".
      const founderPercentile = isInsufficient ? 0 : computeFounderPercentile(overallScore);

      // =======================================================================
      // PAGE 1 — EXECUTIVE SUMMARY
      // =======================================================================

      // Dark hero header band
      doc.rect(0, 0, doc.page.width, 120).fill(COLORS.primaryDark);

      // Logo in hero
      try {
        doc.image(LOGO_PATH, 50, 22, { width: 28, height: 28 });
      } catch {
        doc.roundedRect(50, 24, 24, 24, 4).fill(COLORS.primary);
        doc.font("Inter-Bold").fontSize(14).fillColor(COLORS.white).text("P", 50, 28, { width: 24, align: "center" });
      }
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.white).text("PITCHNEST", 84, 26);
      doc.font("Inter-Bold").fontSize(22).fillColor(COLORS.white).text(businessName, 50, 50);
      doc.font("Inter").fontSize(9).fillColor("#94a3b8").text(`Pitch Date: ${formattedDate}   |   Session Type: AI VC Panel`, 50, 82);

      // Verdict Box
      const verdict = getVerdict(overallScore, isInsufficient);
      const verdictColor = getVerdictColor(overallScore, isInsufficient);
      doc.rect(50, 140, 260, 60).lineWidth(1.5).fillAndStroke("#FFF8F8", verdictColor);
      doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.textLight).text("VERDICT", 65, 150);
      doc.font("Inter-Bold").fontSize(13).fillColor(verdictColor).text(verdict, 65, 165);

      // Executive Summary Paragraph
      doc.y = 215;
      doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.dark).text("EXECUTIVE SUMMARY");
      doc.y += 6;
      const rawSummary = report.summary || "This pitch was too short to generate a full evaluation. Please complete a session speaking for at least 2 minutes to get full VC grading and analytics.";
      // Use the full height available before Category Breakdown (~10 lines). A
      // normal 2-3 sentence summary fits fully; a longer one is trimmed to whole
      // sentences (never mid-sentence) so the writeup always reads complete.
      const summary = fitTextBySentence(doc, rawSummary, 260, "Inter", 9, 10, 3.5);
      doc.font("Inter").fontSize(9).fillColor(COLORS.text).text(summary, 50, doc.y, { width: 260, lineGap: 3.5 });

      // Right Column Overall Score Card — improved contrast
      const scoreAccentColor = getScoreAccentColor(overallScore);
      doc.rect(330, 140, 215, 205).fill(COLORS.primaryDark);
      doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.secondary).text("OVERALL PITCH SCORE", 350, 158);

      // Large score number with accent color for low scores
      const scoreDisplayColor = overallScore < 40 ? scoreAccentColor : COLORS.white;
      doc.font("Inter-Bold").fontSize(42).fillColor(scoreDisplayColor).text(isInsufficient ? "N/A" : `${overallScore}`, 350, 175);
      doc.font("Inter").fontSize(11).fillColor(COLORS.textLight).text("/ 100", 415, 201);

      // Progress bar — lighter track for visibility on the navy panel, with a subtle border
      doc.roundedRect(350, 230, 175, 6, 3).fillAndStroke("#475569", "#64748b");
      if (!isInsufficient) {
        doc.roundedRect(350, 230, Math.max(10, (overallScore / 100) * 175), 6, 3).fill(scoreAccentColor);
      }
      doc.font("Inter").fontSize(9).fillColor("#94a3b8").text("You scored higher than", 350, 255);
      doc.font("Inter-Bold").fontSize(18).fillColor(scoreAccentColor).text(isInsufficient ? "0%" : `${founderPercentile}%`, 350, 270);
      doc.font("Inter").fontSize(8).fillColor("#94a3b8").text("of early-stage founders on PitchNest", 350, 292);

      // Category Scores
      doc.y = 370;
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.dark).text("CATEGORY BREAKDOWN", 50, doc.y);

      const cats = [
        { name: "Delivery", score: scores.delivery, color: COLORS.primary },
        { name: "Clarity", score: scores.clarity, color: COLORS.secondary },
        { name: "Scalability", score: scores.scalability, color: COLORS.amber },
        { name: "Readiness", score: scores.readiness, color: COLORS.emerald }
      ];

      let catY = 395;
      cats.forEach((c) => {
        doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.dark).text(c.name, 50, catY);
        doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.textLight).text(`${isInsufficient ? "0" : c.score}/100`, 240, catY, { align: "right", width: 40 });
        doc.roundedRect(50, catY + 12, 230, 5, 2.5).fill(COLORS.border);
        if (!isInsufficient) {
          doc.roundedRect(50, catY + 12, (c.score / 100) * 230, 5, 2.5).fill(c.color);
        }
        catY += 28;
      });

      // Radar Chart
      drawRadarChart(doc, 435, 455, 60, scores);

      // Investor Sentiment
      doc.y = 570;
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor(COLORS.border).lineWidth(1).stroke();
      doc.y = 585;
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.dark).text("INVESTOR SENTIMENT");

      let sentX = 50;
      sentiments.slice(0, 3).forEach((s) => {
        doc.rect(sentX, 605, 158, 155).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
        doc.circle(sentX + 25, 630, 14).fill(COLORS.border);
        doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.primary).text(s.persona.substring(0, 1), sentX + 22, 626);
        doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.dark).text(s.persona, sentX + 48, 622, { width: 103 });
        const cappedQuote = fitText(doc, s.quote, 130, "Helvetica-Oblique", 8, 8, 3);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor(COLORS.text).text(`"${cappedQuote}"`, sentX + 15, 655, { width: 130, lineGap: 3 });
        sentX += 172;
      });

      // =======================================================================
      // PAGE 2 — KEY INSIGHTS & VENTURE READINESS
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Key Insights & Venture Readiness");

      // Strengths & Risks
      doc.rect(50, 80, 235, 220).lineWidth(1).fillAndStroke(COLORS.bgLight, COLORS.border);
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.emerald).text("KEY STRENGTHS", 65, 95);
      let sY = 120;
      // Pattern A + B: each item is capped at 4 lines and advances by its
      // measured height, so longer copy stacks cleanly instead of overlapping.
      strengths.slice(0, 3).forEach((s) => {
        const sText = fitText(doc, s, 190, "Inter", 8.5, 4, 2.5);
        drawIcon(doc, "checkmark", 62, sY - 2, 12, COLORS.emerald);
        doc.font("Inter").fontSize(8.5).fillColor(COLORS.text).text(sText, 80, sY, { width: 190, lineGap: 2.5 });
        sY += Math.max(40, doc.heightOfString(sText, { width: 190, lineGap: 2.5 }) + 12);
      });

      doc.rect(300, 80, 245, 220).lineWidth(1).fillAndStroke(COLORS.roseBg, COLORS.border);
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.rose).text("CRITICAL RISKS", 315, 95);
      let rY = 120;
      risks.slice(0, 3).forEach((r) => {
        const rText = fitText(doc, r, 200, "Inter", 8.5, 4, 2.5);
        drawIcon(doc, "shield", 312, rY - 2, 12, COLORS.rose);
        doc.font("Inter").fontSize(8.5).fillColor(COLORS.text).text(rText, 330, rY, { width: 200, lineGap: 2.5 });
        rY += Math.max(40, doc.heightOfString(rText, { width: 200, lineGap: 2.5 }) + 12);
      });

      // Actionable Next Steps
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.dark).text("ACTIONABLE NEXT STEPS", 50, 320);
      let stepY = 340;
      const stepsToShow = nextSteps.slice(0, 5);
      for (let idx = 0; idx < stepsToShow.length; idx++) {
        const step = stepsToShow[idx];
        // Dynamic row height: measure description to determine card size
        const descText = fitText(doc, step.desc || "", 225, "Inter", 7.5, 3, 1.5);
        const descH = doc.heightOfString(descText, { width: 225, lineGap: 1.5 });
        const stepRowH = Math.max(48, 24 + descH + 8);

        // Stop drawing if we'd overflow into the AI INSIGHTS section
        if (stepY + stepRowH > 520) break;

        doc.rect(50, stepY, 280, stepRowH).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
        doc.circle(70, stepY + stepRowH / 2, 12).fill(COLORS.primary);
        doc.font("Inter-Bold").fontSize(8.5).fillColor(COLORS.white).text(`${idx + 1}`, 67, stepY + stepRowH / 2 - 4, { align: "center", width: 6 });

        // Title: one line, leaving room for the priority pill on the same row.
        const stepTitle = fitText(doc, step.title || "", 150, "Inter-Bold", 8.5, 1);
        doc.font("Inter-Bold").fontSize(8.5).fillColor(COLORS.dark).text(stepTitle, 92, stepY + 9, { width: 150 });
        // Description: up to three lines BELOW the title/pill row, full card width.
        doc.font("Inter").fontSize(7.5).fillColor(COLORS.textLight).text(descText, 92, stepY + 24, { width: 225, lineGap: 1.5 });

        // Priority tag — High Priority: red bg, white text
        const isHighPriority = (step.priority || "").toLowerCase().includes("high");
        if (isHighPriority) {
          doc.roundedRect(255, stepY + 8, 65, 14, 6).fill(COLORS.rose);
          doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.white).text(step.priority || "High Priority", 255, stepY + 11, { align: "center", width: 65 });
        } else {
          doc.roundedRect(255, stepY + 8, 65, 14, 6).lineWidth(0.5).fillAndStroke(COLORS.amberBg, COLORS.amber);
          doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.amber).text(step.priority || "Medium Priority", 255, stepY + 11, { align: "center", width: 65 });
        }

        stepY += stepRowH + 6;
      }

      // Investment Gauge Card
      doc.roundedRect(345, 320, 200, 125, 6).lineWidth(0.5).fillAndStroke(COLORS.white, COLORS.border);
      doc.font("Inter-Bold").fontSize(8.5).fillColor(COLORS.primaryDark).text("VC INVESTMENT PROBABILITY", 355, 330);
      doc.circle(525, 334, 4.5).lineWidth(0.5).strokeColor(COLORS.textLight).stroke();
      doc.font("Inter-Bold").fontSize(6).fillColor(COLORS.textLight).text("i", 521, 331, { width: 8, align: "center" });
      
      const invProb = vcInvestmentProbability;
      drawHalfGaugeChart(doc, 445, 392, 45, invProb, "", COLORS.primary, 8, COLORS.dark);
      doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.rose).text("Low Probability", 395, 398, { width: 100, align: "center" });

      doc.roundedRect(355, 410, 180, 28, 4).fill(COLORS.indigoBg);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text(
        "Investors need more evidence of market demand, unit economics, and technical feasibility before considering an investment.",
        360, 415, { width: 170, lineGap: 1.5 }
      );

      // Current vs Potential
      doc.roundedRect(345, 450, 200, 78, 6).lineWidth(0.5).fillAndStroke(COLORS.white, COLORS.border);
      doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.primaryDark).text("IF YOU PITCHED AGAIN TODAY", 355, 458, { width: 185 });

      // Current score column
      doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.textLight).text("Current Score", 358, 472, { width: 68, align: "center" });
      doc.font("Inter-Bold").fontSize(17).fillColor(COLORS.primary).text(isInsufficient ? "N/A" : `${overallScore}`, 358, 480, { width: 40, align: "right" });
      doc.font("Inter").fontSize(8.5).fillColor(COLORS.textLight).text("/100", 401, 485);

      // Arrow
      doc.font("Inter").fontSize(13).fillColor(COLORS.textLight).text("→", 422, 482, { width: 18, align: "center" });

      // Potential score column
      doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.textLight).text("Potential Score", 440, 472, { width: 78, align: "center" });
      doc.font("Inter-Bold").fontSize(17).fillColor(COLORS.emerald).text(isInsufficient ? "N/A" : "78", 440, 480, { width: 40, align: "right" });
      doc.font("Inter").fontSize(8.5).fillColor(COLORS.textLight).text("/100", 483, 485);

      doc.font("Inter").fontSize(6).fillColor(COLORS.textLight).text("By addressing the risks in this report.", 355, 503, { width: 186, align: "center" });

      // AI Insights — every value is computed from the real transcript (or live
      // scores). No "vs avg" deltas: we have no per-metric founder benchmark, and
      // a fabricated delta is worse than none. Metrics that can't be derived show
      // a factual sub-label, never a placeholder number.
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.dark).text("AI INSIGHTS AT A GLANCE", 50, 530);
      const dm = computeDeliveryMetrics(report.transcript);
      const numOrNA = (v: number | null, suffix = "") =>
        isInsufficient || v === null ? "N/A" : `${v}${suffix}`;
      const metrics = [
        { label: "Questions Asked", val: numOrNA(dm.questionsAsked), sub: "from the panel" },
        { label: "Words Spoken", val: numOrNA(dm.founderWords), sub: "by you" },
        { label: "Filler Words", val: numOrNA(dm.fillerPct, "%"), sub: "ideal: <5%" },
        { label: "Confidence", val: isInsufficient ? "N/A" : `${scores.delivery}%`, sub: "ideal: 70%+" },
        { label: "Clarity", val: isInsufficient ? "N/A" : `${scores.clarity}%`, sub: "ideal: 70%+" },
        { label: "Talk Ratio", val: numOrNA(dm.talkRatioPct, "%"), sub: "your share" },
      ];

      let cardX = 50;
      metrics.forEach((m) => {
        doc.rect(cardX, 550, 72, 70).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(m.label, cardX + 5, 558, { width: 62, align: "center" });
        doc.font("Inter-Bold").fontSize(13).fillColor(COLORS.dark).text(m.val, cardX + 5, 578, { width: 62, align: "center" });
        doc.font("Inter").fontSize(6).fillColor(COLORS.textLight).text(m.sub, cardX + 5, 600, { width: 62, align: "center" });
        cardX += 84;
      });

      // 30-Second practice plan
      doc.rect(50, 640, 495, 120).lineWidth(1).fillAndStroke(COLORS.indigoBg, "#c7d2fe");
      doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.primary).text("YOUR PERSONALIZED 30-SECOND PRACTICE PLAN", 65, 652);

      doc.circle(95, 705, 30).fill(COLORS.white);
      doc.font("Inter-Bold").fontSize(18).fillColor(COLORS.primary).text("30", 65, 692, { align: "center", width: 60 });
      doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.primary).text("SEC", 65, 712, { align: "center", width: 60 });

      const steps30 = [
        { title: "1. Define the Problem", time: "10 sec", desc: "State the problem in one clear sentence." },
        { title: "2. Present Your Solution", time: "10 sec", desc: "Explain how your startup solves it." },
        { title: "3. Market & Vision", time: "10 sec", desc: "Share market size and your ultimate vision." }
      ];

      let stepX = 145;
      steps30.forEach((s) => {
        doc.font("Inter-Bold").fontSize(8.5).fillColor(COLORS.dark).text(s.title, stepX, 665);
        doc.font("Inter").fontSize(7.5).fillColor(COLORS.text).text(s.desc, stepX, 678, { width: 110 });
        doc.roundedRect(stepX, 710, 45, 12, 6).fill(COLORS.border);
        doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.textLight).text(s.time, stepX, 713, { align: "center", width: 45 });
        stepX += 135;
      });

      // =======================================================================
      // PAGE 3 — PERFORMANCE & DELIVERY ANALYTICS
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Performance & Delivery Analytics");

      // Delivery stats — all computed from the real transcript / live scores.
      // Speaking Pace (WPM) and Average Pause were removed: they require
      // per-utterance audio timing the session does not capture, so we will not
      // fabricate them. Filler Words and Words Spoken are derived from what the
      // founder actually said.
      const dmP3 = computeDeliveryMetrics(report.transcript);
      const scoreDesc = (v: number) => (v >= 70 ? "On Track" : v >= 50 ? "Moderate" : "Needs Improvement");
      const fillerColor =
        dmP3.fillerPct === null ? COLORS.textLight : dmP3.fillerPct <= 5 ? COLORS.emerald : COLORS.amber;
      const statsPace = [
        { title: "Words Spoken", val: isInsufficient || dmP3.founderWords === null ? "N/A" : `${dmP3.founderWords}`, desc: "total, by you", color: COLORS.primary },
        { title: "Filler Words", val: isInsufficient || dmP3.fillerPct === null ? "N/A" : `${dmP3.fillerPct}%`, desc: "Ideal: <5%", color: fillerColor },
        { title: "Questions Asked", val: isInsufficient || dmP3.questionsAsked === null ? "N/A" : `${dmP3.questionsAsked}`, desc: "from the panel", color: COLORS.indigo },
        { title: "Confidence Score", val: isInsufficient ? "N/A" : `${scores.delivery}%`, desc: `${scoreDesc(scores.delivery)} (Ideal: 70%+)`, color: getScoreAccentColor(scores.delivery) },
        { title: "Clarity Score", val: isInsufficient ? "N/A" : `${scores.clarity}%`, desc: `${scoreDesc(scores.clarity)} (Ideal: 70%+)`, color: getScoreAccentColor(scores.clarity) },
      ];

      let statX = 50;
      statsPace.forEach((s) => {
        doc.rect(statX, 80, 90, 80).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
        doc.font("Inter").fontSize(7).fillColor(COLORS.textLight).text(s.title, statX + 5, 88, { width: 80, align: "center" });
        doc.font("Inter-Bold").fontSize(13).fillColor(s.color).text(s.val, statX + 5, 105, { width: 80, align: "center" });
        doc.font("Inter").fontSize(6).fillColor(COLORS.text).text(s.desc, statX + 5, 125, { width: 80, align: "center" });
        statX += 101;
      });

      // Single series only — title matches what is actually plotted, with a Y
      // scale and a one-entry legend.
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.dark).text("CONFIDENCE OVER TIME", 50, 180);
      doc.rect(232, 182, 10, 3).fill(COLORS.primary);
      doc.font("Inter").fontSize(7).fillColor(COLORS.textLight).text("Confidence", 246, 180);
      drawLineChart(doc, 72, 200, 248, 110, timelinePoints, 100, COLORS.primary, { yAxis: true });
      // Axis title placed BELOW the x tick row (ticks render at y+h+5)
      doc.font("Inter").fontSize(7).fillColor(COLORS.textLight).text("Time (minutes)", 72, 326, { width: 248, align: "center" });

      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("QUESTION DIFFICULTY BREAKDOWN", 345, 180);
      const difficultySects = [
        { value: questionDifficulty.easy, color: COLORS.emerald },
        { value: questionDifficulty.medium, color: COLORS.amber },
        { value: questionDifficulty.hard, color: COLORS.rose }
      ];
      drawDonutChart(doc, 400, 245, 35, difficultySects);

      doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.dark).text("Difficulty Breakdown", 455, 215);

      const diffLegendY = 230;
      doc.circle(460, diffLegendY, 3).fill(COLORS.emerald);
      doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(`Easy (${questionDifficulty.easy})`, 468, diffLegendY - 3);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text("Well Answered", 468, diffLegendY + 6);

      doc.circle(460, diffLegendY + 22, 3).fill(COLORS.amber);
      doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(`Medium (${questionDifficulty.medium})`, 468, diffLegendY + 19);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text("Partially Answered", 468, diffLegendY + 28);

      doc.circle(460, diffLegendY + 44, 3).fill(COLORS.rose);
      doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(`Hard (${questionDifficulty.hard})`, 468, diffLegendY + 41);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text("Poorly Answered or Avoided", 468, diffLegendY + 50, { width: 80 });

      doc.font("Inter-Bold").fontSize(8.5).fillColor(COLORS.dark).text("TOUGHEST QUESTIONS", 345, 305);
      // Show exactly as many questions as the "Hard (n)" count so the count and
      // the listed items always agree. Each item advances by its measured height.
      const toughDefaults = [
        "How did you calculate your total addressable market?",
        "What are your unit economics and pricing model?",
        "What makes your product defensible against competitors?",
      ];
      const toughSource = questionsToPrepare.length > 0 ? questionsToPrepare : toughDefaults;
      const nTough = Math.min(Math.max(questionDifficulty.hard, 1), toughSource.length);
      let toughY = 320;
      for (let i = 0; i < nTough; i++) {
        const qText = fitText(doc, `${i + 1}. ${toughSource[i]}`, 195, "Inter", 7.5, 2, 1.5);
        doc.font("Inter").fontSize(7.5).fillColor(COLORS.text).text(qText, 345, toughY, { width: 195, lineGap: 1.5 });
        toughY += doc.heightOfString(qText, { width: 195, lineGap: 1.5 }) + 5;
      }

      // Detailed Category Matrix — start below BOTH the donut/legend and the
      // toughest-questions list so neither can overlap it.
      doc.y = Math.max(350, toughY + 6);
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.dark).text("DETAILED CATEGORY MATRIX", 50, doc.y);

      const tableHeaders = ["Category", "Score", "What Went Well", "What Needs Improvement", "Impact"];
      const colWidths = [80, 45, 145, 155, 60];

      let ty = Math.max(370, doc.y + 16);
      doc.rect(50, ty, 495, 18).fill(COLORS.primary);
      let tx = 55;
      tableHeaders.forEach((th, idx) => {
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.white).text(th, tx, ty + 5);
        tx += colWidths[idx];
      });

      ty += 18;
      const catScoreMap: Record<string, number> = {
        Delivery: scores.delivery, Clarity: scores.clarity,
        Scalability: scores.scalability, Readiness: scores.readiness
      };
      // Pattern A: each row grows to fit its tallest cell (shared drawTableRow)
      categoryMatrixRows.forEach((row, rowIdx) => {
        const catScore = catScoreMap[row.category] ?? 0;
        // Cap the prose cells at 3 lines (Pattern B) so a row grows for normal
        // wrapping but can't blow the table past the page.
        const cells: RowCell[] = [
          { text: row.category, font: "Inter-Bold" },
          { text: `${catScore}/100`, font: "Inter-Bold" },
          { text: fitText(doc, row.went_well, 135, "Inter", 7.5, 5, 1.5) },
          { text: fitText(doc, row.needs_improvement, 145, "Inter", 7.5, 5, 1.5) },
          { text: row.impact },
        ];
        ty = drawTableRow(doc, 50, ty, colWidths, cells, {
          fill: rowIdx % 2 === 0 ? COLORS.bgLight : COLORS.white,
          border: COLORS.border,
          padX: 5,
          padY: 8,
          lineGap: 1.5,
          minHeight: 30,
        });
      });

      // Founder Benchmarking — Improved layout with card background
      ty += 15;
      
      // Card background matching VC INVESTMENT PROBABILITY style
      doc.roundedRect(50, ty, 495, 140, 8).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
      doc.roundedRect(55, ty + 5, 485, 130, 6).fill(COLORS.indigoBg);
      
      doc.font("Inter-Bold").fontSize(8.5).fillColor(COLORS.primaryDark).text("BENCHMARKING AGAINST OTHER FOUNDERS", 65, ty + 15);
      
      // Gauge on left
      const benchGaugeY = ty + 95;
      drawHalfGaugeChart(doc, 125, benchGaugeY, 45, isInsufficient ? 0 : founderPercentile, "", COLORS.primary, 8, COLORS.dark);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text("You scored higher than", 80, benchGaugeY - 28, { width: 90, align: "center" });
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text("of early-stage founders\non PitchNest", 80, benchGaugeY + 8, { width: 90, align: "center" });
      doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.dark).text("0%", 70, benchGaugeY + 2);
      doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.dark).text("100%", 165, benchGaugeY + 2);

      // Vertical Divider
      doc.moveTo(210, ty + 40).lineTo(210, ty + 125).strokeColor(COLORS.border).lineWidth(0.5).stroke();

      // Middle text
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.dark).text("PitchNest analyzes thousands of founder pitches\nacross Africa and globally.", 225, ty + 35, { lineGap: 1.5 });

      // Horizontal bars on right
      const benchmarkData = [
        { label: "Your Overall Score", val: isInsufficient ? 0 : overallScore, color: COLORS.primary },
        { label: "Average Score (All Founders)", val: AVERAGE_FOUNDER_SCORE, color: COLORS.textLight },
        { label: "Top 25% Founders", val: 68, color: COLORS.textLight },
        { label: "Top 10% Founders", val: 80, color: COLORS.textLight }
      ];

      let barY = ty + 65;
      benchmarkData.forEach((b) => {
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.text).text(b.label, 225, barY);
        doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.dark).text(`${b.val}/100`, 430, barY);
        doc.roundedRect(325, barY + 1, 95, 4, 2).fill(COLORS.border);
        if (b.val > 0) {
          doc.roundedRect(325, barY + 1, (b.val / 100) * 95, 4, 2).fill(b.color);
        }
        barY += 15;
      });

      // Percentile Card — same single percentile value/phrasing as page 1
      doc.roundedRect(465, ty + 45, 65, 80, 6).lineWidth(0.5).fillAndStroke(COLORS.white, COLORS.border);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text("Percentile Rank", 465, ty + 55, { width: 65, align: "center" });
      drawIcon(doc, "bar_chart", 488, ty + 70, 16, COLORS.primary);
      const topPct = isInsufficient ? 0 : founderPercentile;
      doc.font("Inter-Bold").fontSize(14).fillColor(COLORS.primaryDark).text(`${topPct}%`, 465, ty + 92, { width: 65, align: "center" });
      doc.font("Inter").fontSize(6).fillColor(COLORS.textLight).text("scored higher than", 465, ty + 108, { width: 65, align: "center" });

      // =======================================================================
      // PAGE 4 — COMPETITIVE LANDSCAPE
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Competitive Landscape");

      // ── Direct Competitors — full-width table ─────────────────────────────
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("DIRECT COMPETITORS", 50, 75);
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.textLight).text("Real competitors in your industry identified by AI analysis (figures are AI estimates)", 50, 87);

      const p4CompColW = [118, 50, 112, 132, 73];
      const p4CompHeaders = ["Company", "Similarity", "Strengths", "Weaknesses", "Est. Size"];
      let p4fty = 106;

      // Pattern A + B: cap each prose cell at 3 lines, then pre-measure each row
      // (tallest of strength/weakness) so both the box and the rows grow with
      // wrapping text but can never overflow the page.
      const p4Cells = competitorList.map((c: any) => ({
        strength: fitText(doc, c.strength, 104, "Inter", 6.5, 3, 1.5),
        weakness: fitText(doc, c.weakness, 104, "Inter", 6.5, 3, 1.5),
      }));
      const p4RowHeights = p4Cells.map((c) =>
        measureRowHeight(
          doc,
          [
            { text: c.strength, fontSize: 6.5 },
            { text: c.weakness, fontSize: 6.5 },
          ],
          [104, 104],
          0,
          5,
          1.5,
          22,
        ),
      );
      const p4RowsTotal = p4RowHeights.reduce((a: number, b: number) => a + b, 0);
      const p4BoxH = p4fty + 15 - 96 + p4RowsTotal + 6;
      doc.roundedRect(50, 96, 495, p4BoxH, 8).strokeColor(COLORS.border).lineWidth(1).stroke();

      let p4ftx = 60;
      p4CompHeaders.forEach((ch, idx) => {
        doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.textLight).text(ch, p4ftx, p4fty);
        p4ftx += p4CompColW[idx];
      });
      doc.moveTo(60, p4fty + 10).lineTo(535, p4fty + 10).strokeColor(COLORS.border).lineWidth(0.5).stroke();

      const p4BgColors = ["#4C6FD1", COLORS.emerald, "#3b82f6", "#374151"];
      let p4RowY = p4fty + 15;
      competitorList.forEach((c: any, cIdx: number) => {
        const rowH = p4RowHeights[cIdx];
        const p4Char = c.name.charAt(0).toUpperCase();
        const p4Bg = p4BgColors[cIdx % p4BgColors.length];
        doc.roundedRect(60, p4RowY, 15, 15, 3).fill(p4Bg);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.white).text(p4Char, 60, p4RowY + 3.5, { align: "center", width: 15 });
        doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.dark).text(c.name, 80, p4RowY, { width: 92 });
        doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primary).text(`${c.similarity}%`, 184, p4RowY + 3);
        doc.circle(240, p4RowY + 7, 4).fill(COLORS.emerald);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text(p4Cells[cIdx].strength, 248, p4RowY, { width: 104, lineGap: 1.5 });
        doc.circle(364, p4RowY + 7, 4).fill(COLORS.rose);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text(p4Cells[cIdx].weakness, 372, p4RowY, { width: 104, lineGap: 1.5 });
        // Est. Size: the "Est." caveat lives in the column header + disclaimer, so
        // the cell shows just the compact range (no per-row "Est." prefix or
        // trailing "ARR") in a wider column that no longer wraps.
        doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.dark).text(compactSize(c.size), 482, p4RowY + 3, { align: "right", width: 58 });
        // Row divider between competitors
        if (cIdx < competitorList.length - 1) {
          doc.moveTo(60, p4RowY + rowH - 3).lineTo(535, p4RowY + rowH - 3).strokeColor(COLORS.border).lineWidth(0.25).stroke();
        }
        p4RowY += rowH;
      });

      // Key takeaway strip
      const p4KtY = p4RowY + 2;
      doc.roundedRect(56, p4KtY, 483, 22, 5).lineWidth(0.5).fillAndStroke("#eff6ff", "#bfdbfe");
      const p4KtText = fitText(doc, strategicRecommendation, 380, "Inter", 7, 1);
      doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.primary).text("Key Takeaway: ", 72, p4KtY + 6, { continued: true });
      doc.font("Inter").fontSize(7).fillColor(COLORS.dark).text(p4KtText, { width: 435, lineBreak: false });

      // ── SWOT Analysis ─────────────────────────────────────────────────────
      const p4SwotTopY = p4KtY + 30;
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text(`SWOT ANALYSIS — ${businessName.toUpperCase()}`, 50, p4SwotTopY);

      const p4SwotItems = [
        { label: "STRENGTHS", color: COLORS.emerald, bg: COLORS.emeraldBg, border: COLORS.emeraldBorder, items: swotData.strengths },
        { label: "WEAKNESSES", color: COLORS.rose, bg: COLORS.roseBg, border: COLORS.roseBorder, items: swotData.weaknesses },
        { label: "OPPORTUNITIES", color: COLORS.primary, bg: COLORS.indigoBg, border: "#bfdbfe", items: swotData.opportunities },
        { label: "THREATS", color: COLORS.amber, bg: COLORS.amberBg, border: COLORS.amberBorder, items: swotData.threats }
      ];
      const p4SwotQH = 100;
      p4SwotItems.forEach((s, idx) => {
        const p4sx = idx % 2 === 0 ? 50 : 300;
        const p4sy = p4SwotTopY + 14 + (idx < 2 ? 0 : p4SwotQH + 8);
        doc.roundedRect(p4sx, p4sy, 245, p4SwotQH, 6).lineWidth(0.75).fillAndStroke(s.bg, s.border);
        doc.font("Inter-Bold").fontSize(8).fillColor(s.color).text(s.label, p4sx + 10, p4sy + 8);
        let p4ItemY = p4sy + 22;
        // Pattern A: advance by each item's measured height (max 2 lines) so a
        // wrapping bullet never overlaps the next.
        s.items.slice(0, 4).forEach((item: string) => {
          const itemText = fitText(doc, item, 211, "Inter", 6.5, 2, 1.5);
          doc.circle(p4sx + 14, p4ItemY + 3.5, 2.5).fill(s.color);
          doc.font("Inter").fontSize(6.5).fillColor(COLORS.text).text(itemText, p4sx + 22, p4ItemY, { width: 211, lineGap: 1.5 });
          const ih = doc.heightOfString(itemText, { width: 211, lineGap: 1.5 });
          p4ItemY += Math.max(14, ih + 4);
        });
      });

      // ── Market Positioning Map — below SWOT ──────────────────────────────
      const p4MapY = p4SwotTopY + 14 + p4SwotQH * 2 + 8 + 16;
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("MARKET POSITIONING MAP", 50, p4MapY);
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.textLight).text("Relative competitive positioning in the market", 50, p4MapY + 12);
      doc.roundedRect(50, p4MapY + 24, 495, 128, 8).strokeColor(COLORS.border).lineWidth(1).stroke();

      const p4ScatterPoints: { name: string; xVal: number; yVal: number; color: string; labelPosition?: "left" | "right" }[] = [
        { name: `${businessName} (You)`, xVal: -30, yVal: 65, color: COLORS.primary, labelPosition: "right" }
      ];
      // Compute scatter coordinates from real AI data (similarity → X,
      // derived market presence → Y) instead of hard-coded positions.
      competitorList.forEach((c, ci) => {
        // X-axis: map similarity (0–100) to plot range (-80..+80)
        const simX = ((c.similarity ?? 50) / 100) * 160 - 80;
        // Y-axis: spread competitors vertically based on index and similarity
        const ySpread = [50, 15, -30, -55];
        const simY = ySpread[ci] ?? (50 - ci * 30);
        p4ScatterPoints.push({ name: c.name, xVal: simX, yVal: simY, color: p4BgColors[ci % p4BgColors.length] });
      });
      drawScatterPlot(doc, 75, p4MapY + 34, 460, 100, p4ScatterPoints);
      // X-axis label on the axis line (bottom of the plot), not floating above it
      doc.font("Inter").fontSize(5.5).fillColor(COLORS.textLight).text("← Lower AI / Innovation Capability  |  Higher AI / Innovation Capability →", 75, p4MapY + 138, { width: 460, align: "center" });
      // Y-axis label, rotated along the left edge
      doc.save();
      doc.translate(66, p4MapY + 84);
      doc.rotate(-90);
      doc.font("Inter").fontSize(5.5).fillColor(COLORS.textLight).text("← Lower Market Presence  |  Higher →", -50, -3, { width: 100, align: "center" });
      doc.restore();

      // =======================================================================
      // PAGE 5 — MARKET INTELLIGENCE
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Market Intelligence");

      // ── Topic Coverage (y=65–200) ──────────────────────────────────────────
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("TOPIC COVERAGE", 50, 65);
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.textLight).text("How well you covered each key pitch topic", 50, 77);
      doc.roundedRect(50, 90, 495, 110, 6).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);

      // The donut, the legend, and the centre number all use the SAME displayed
      // slice, so the centre (their mean) always reconciles with what's listed.
      // We intentionally do NOT use report.topic_coverage_overall here — that is
      // the mean of the full topic array (incl. unlisted Team/Financials/etc.)
      // and would disagree with a 6-item legend.
      const displayedTopics = topicCoverage.slice(0, 6);
      const topicDonutSegments = displayedTopics.map(t => ({ value: t.percentage, color: t.color }));
      const totalCoverage = displayedTopics.length > 0
        ? Math.round(displayedTopics.reduce((s, t) => s + t.percentage, 0) / displayedTopics.length)
        : 0;
      drawDonutChart(doc, 448, 147, 35, topicDonutSegments, `${totalCoverage}%`);
      doc.font("Inter").fontSize(6).fillColor(COLORS.textLight).text("Avg of shown topics", 413, 187, { width: 70, align: "center" });

      let tLegY = 103;
      displayedTopics.forEach((t) => {
        doc.circle(70, tLegY + 3.5, 3).fill(t.color);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(t.topic, 80, tLegY, { width: 145, lineBreak: false });
        doc.font("Inter").fontSize(7.5).fillColor(COLORS.textLight).text(`${t.percentage}%`, 235, tLegY, { align: "right", width: 35 });
        tLegY += 15;
      });

      // ── AI Summary (y=208–278) ─────────────────────────────────────────────
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("AI SUMMARY OF TRANSCRIPT", 50, 208);
      doc.roundedRect(50, 221, 495, 55, 6).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
      const summaryTextP5 = fitTextBySentence(doc, transcriptSummary, 475, "Inter", 7.5, 4, 2);
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.dark).text(summaryTextP5, 60, 228, { width: 475, lineGap: 2 });

      // ── Pre-calculate heights for 2-Column: Market Gap & Companies to Study ──
      const p5Gaps = marketGaps;
      let mgGapHeight = 26; // Title + padding
      p5Gaps.forEach((g) => {
        const gDesc = fitText(doc, g.desc, 215, "Inter", 6.5, 3, 1.5);
        const dh = doc.heightOfString(gDesc, { width: 215, lineGap: 1.5 });
        mgGapHeight += Math.max(26, 10 + dh + 6);
      });

      let p5StudyHeight = 26; // Title + padding
      studiesToShow.forEach((s) => {
        const whyText = fitText(doc, s.why, 218, "Inter", 6.5, 3, 1.5);
        const wh = doc.heightOfString(whyText, { width: 218, lineGap: 1.5 });
        p5StudyHeight += Math.max(22, 9 + wh + 6);
      });

      const colMaxH = Math.max(148, Math.max(mgGapHeight, p5StudyHeight) + 10);

      // ── Draw 2-Column layout ───────────────────────────────────────────────
      doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.primaryDark).text("MARKET GAP ANALYSIS", 50, 287);
      doc.font("Inter").fontSize(7).fillColor(COLORS.textLight).text("Key gaps competitors are not addressing", 50, 298);

      doc.roundedRect(295, 283, 250, colMaxH, 6).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);
      doc.font("Inter-Bold").fontSize(9).fillColor(COLORS.primaryDark).text("COMPANIES TO STUDY", 305, 291);
      doc.font("Inter").fontSize(7).fillColor(COLORS.textLight).text("Competitors and examples worth learning from", 305, 302);

      let mgGapY = 309;
      p5Gaps.forEach((g) => {
        doc.circle(61, mgGapY + 7, 8).fill(COLORS.indigoBg);
        doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.primary).text((g.title || "?").charAt(0).toUpperCase(), 54, mgGapY + 4, { align: "center", width: 14 });
        const gTitle = fitText(doc, g.title, 210, "Inter-Bold", 7.5, 1);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(gTitle, 74, mgGapY, { width: 210 });
        const gDesc = fitText(doc, g.desc, 215, "Inter", 6.5, 3, 1.5);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(gDesc, 74, mgGapY + 10, { width: 215, lineGap: 1.5 });
        const dh = doc.heightOfString(gDesc, { width: 215, lineGap: 1.5 });
        mgGapY += Math.max(26, 10 + dh + 6);
      });

      const p5StudyColors = ["#4C6FD1", "#06b6d4", "#f59e0b", "#3b82f6"];
      let p5StudyY = 314;
      studiesToShow.forEach((s, sIdx) => {
        const p5Char = s.name.charAt(0).toUpperCase();
        const p5Bg = p5StudyColors[sIdx % p5StudyColors.length];
        doc.roundedRect(305, p5StudyY, 16, 16, 3).fill(p5Bg);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.white).text(p5Char, 305, p5StudyY + 4, { align: "center", width: 16 });
        const sName = fitText(doc, s.name, 213, "Inter-Bold", 7.5, 1);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(sName, 326, p5StudyY, { width: 213 });
        const whyText = fitText(doc, s.why, 218, "Inter", 6.5, 3, 1.5);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(whyText, 326, p5StudyY + 9, { width: 218, lineGap: 1.5 });
        const wh = doc.heightOfString(whyText, { width: 218, lineGap: 1.5 });
        p5StudyY += Math.max(22, 9 + wh + 6);
      });

      // ── AI Strategic Recommendation ────────────────────────────────────────
      const p5RecTopY = 283 + colMaxH + 15;
      doc.roundedRect(50, p5RecTopY, 495, 88, 8).lineWidth(1).fillAndStroke(COLORS.bgLight, COLORS.border);
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primary).text("AI STRATEGIC RECOMMENDATION", 65, p5RecTopY + 10);
      doc.font("Inter").fontSize(7).fillColor(COLORS.textLight).text("Based on competitive analysis and market opportunities", 65, p5RecTopY + 21);
      doc.roundedRect(65, p5RecTopY + 32, 40, 35, 6).fill(COLORS.indigoBg);
      drawIcon(doc, "trending_up", 72, p5RecTopY + 36, 26, COLORS.primary);
      const recTextP5 = fitTextBySentence(doc, strategicRecommendation, 230, "Inter", 7.5, 4, 2.5);
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.dark).text(recTextP5, 115, p5RecTopY + 32, { width: 230, lineGap: 2.5 });
      doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.primary).text("Key Focus Areas", 360, p5RecTopY + 10);
      let focusY5 = p5RecTopY + 24;
      keyFocusAreas.slice(0, 4).forEach((f) => {
        drawIcon(doc, "checkmark", 360, focusY5, 10, COLORS.emerald);
        const fText = fitText(doc, f, 162, "Inter", 7, 1);
        doc.font("Inter").fontSize(7).fillColor(COLORS.dark).text(fText, 374, focusY5 + 1, { width: 162 });
        focusY5 += 14;
      });

      // ── Strategic Collaboration ───────────────────────────────────────────
      const p5CollabTopY = p5RecTopY + 88 + 15;
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("STRATEGIC COLLABORATION OPPORTUNITIES", 50, p5CollabTopY);
      const p5CollabItems = collaborationOpportunities;
      let p5CollabY = p5CollabTopY + 15;
      p5CollabItems.forEach((item, idx) => {
        doc.circle(60, p5CollabY + 6, 9).fill(COLORS.primary);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.white).text(`${idx + 1}`, 55, p5CollabY + 3, { width: 10, align: "center" });
        const itemText = fitText(doc, item, 460, "Inter", 7.5, 1);
        doc.font("Inter").fontSize(7.5).fillColor(COLORS.text).text(itemText, 76, p5CollabY + 1, { width: 460, lineBreak: false });
        p5CollabY += 22;
      });

      // =======================================================================
      // PAGE 6 — YOUR ACTION PLAN
      // =======================================================================
      doc.addPage();
      drawHeader(doc, "Your Action Plan");

      // Title & potential score card — subtitle is width-constrained so it never
      // runs under the score box; box contents use explicit, non-overlapping rows.
      doc.font("Inter-Bold").fontSize(10).fillColor(COLORS.primaryDark).text("YOUR ACTION PLAN", 50, 75);
      doc.font("Inter").fontSize(7.5).fillColor(COLORS.textLight).text("A step-by-step plan to strengthen your pitch and increase your investment readiness.", 50, 87, { width: 290 });

      // Potential Score card
      doc.roundedRect(350, 68, 195, 50, 6).lineWidth(1).fillAndStroke(COLORS.bgLight, COLORS.border);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text("Your Potential Score", 360, 75, { width: 130 });
      doc.font("Inter-Bold").fontSize(15).fillColor(COLORS.primaryDark).text("78", 360, 90);
      doc.font("Inter").fontSize(8).fillColor(COLORS.textLight).text("/100", 382, 95);
      drawIcon(doc, "trending_up", 410, 82, 14, COLORS.emerald);
      doc.font("Inter").fontSize(6).fillColor(COLORS.textLight).text("By addressing the key risks, you can reach this score.", 430, 80, { width: 108, lineGap: 1.5 });

      // Priority Improvements
      ensureSpace(doc, 180, "Your Action Plan");
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primaryDark).text("TOP 5 PRIORITY IMPROVEMENTS", 50, 125);

      const p6PriorityIcons = ["target", "dollar", "bar_chart", "user", "trending_up"];

      let cardFigmaX = 50;
      priorityImprovements.forEach((p, pIdx) => {
        const p6IsHigh = p.priority.toLowerCase().includes("high");
        const p6ImpactColor = p.impact === "Very High" || p.impact === "High" ? COLORS.emerald : COLORS.amber;
        doc.roundedRect(cardFigmaX, 140, 92, 148, 6).lineWidth(0.5).fillAndStroke(COLORS.bgLight, COLORS.border);

        doc.circle(cardFigmaX + 16, 154, 8).fill(COLORS.primaryDark);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.white).text(String(pIdx + 1), cardFigmaX + 12, 150.5, { align: "center", width: 8 });

        drawIcon(doc, p6PriorityIcons[pIdx] || "target", cardFigmaX + 60, 145, 18, COLORS.primary);

        const pTitle = fitText(doc, p.title, 78, "Inter-Bold", 7.5, 2, 1.5);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(pTitle, cardFigmaX + 8, 172, { width: 78, lineGap: 1.5 });

        if (p6IsHigh) {
          doc.roundedRect(cardFigmaX + 8, 198, 54, 12, 3).fill(COLORS.rose);
          doc.font("Inter-Bold").fontSize(5.5).fillColor(COLORS.white).text(p.priority, cardFigmaX + 8, 201, { align: "center", width: 54 });
        } else {
          doc.roundedRect(cardFigmaX + 8, 198, 54, 12, 3).lineWidth(0.5).fillAndStroke(COLORS.amberBg, COLORS.amber);
          doc.font("Inter-Bold").fontSize(5.5).fillColor(COLORS.amber).text(p.priority, cardFigmaX + 8, 201, { align: "center", width: 54 });
        }

        // Pattern A: description fits the card, and "Impact" sits AFTER it
        // (not pinned at a fixed Y where long copy would overlap it).
        const pDesc = fitText(doc, p.desc, 82, "Inter", 6.8, 8, 2);
        doc.font("Inter").fontSize(6.8).fillColor(COLORS.textLight).text(pDesc, cardFigmaX + 8, 216, { width: 82, lineGap: 2 });
        const pDescH = doc.heightOfString(pDesc, { width: 82, lineGap: 2 });
        const impactY = Math.min(274, 216 + pDescH + 6);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text("Impact: ", cardFigmaX + 8, impactY, { continued: true });
        doc.font("Inter-Bold").fillColor(p6ImpactColor).text(p.impact);

        cardFigmaX += 101;
      });

      // Questions to Prepare — with larger cards for full text
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primaryDark).text("QUESTIONS TO PREPARE FOR", 50, 298);

      let fqY = 314;
      questionsToPrepare.slice(0, 6).forEach((q, qIdx) => {
        // Taller card for longer questions
        doc.roundedRect(50, fqY - 3, 200, 26, 4).fill(COLORS.cardBg);

        // Dark blue circle with white number
        doc.circle(62, fqY + 8, 8).fill(COLORS.primaryDark);
        doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.white).text(String(qIdx + 1), 55, fqY + 5, { align: "center", width: 14 });

        // Question text — bounded to 3 lines for more space
        const qText = fitText(doc, q, 190, "Inter", 7.5, 3, 1.5);
        doc.font("Inter").fontSize(7.5).fillColor(COLORS.dark).text(qText, 76, fqY + 1, { width: 190, lineGap: 1.5 });
        fqY += 28;
      });

      // Suggested Answer Framework — dynamic from AI
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primaryDark).text("SUGGESTED ANSWER FRAMEWORK", 268, 298);
      doc.roundedRect(268, 312, 277, 158, 4).fill(COLORS.indigoBg);
      const fwQuestion = fitText(doc, frameworkData.question, 250, "Inter-Bold", 6.5, 2);
      doc.font("Inter-Bold").fontSize(6.5).fillColor(COLORS.primary).text(`For: ${fwQuestion}`, 276, 318, { width: 265 });

      const p6FwIcons = ["target", "calculator", "trending_up", "shield", "checkmark"];
      let frameY = 334;
      frameworkData.steps.slice(0, 5).forEach((f: { label: string; text: string }, fIdx: number) => {
        drawIcon(doc, p6FwIcons[fIdx] || "target", 276, frameY, 14, COLORS.primary);
        doc.font("Inter-Bold").fontSize(7).fillColor(COLORS.primary).text(f.label, 294, frameY);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.dark).text(f.text, 294, frameY + 9, { width: 242, lineGap: 1.5 });
        frameY += 28;
      });

      // Practice Drills — with vector icons
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primaryDark).text("PRACTICE DRILLS FOR NEXT SESSION", 50, 480);

      const drillIcons = ["microphone", "network", "dollar", "user"];
      const drillColors = [COLORS.primaryDark, COLORS.primary, COLORS.emerald, COLORS.amber];

      let drillFigmaX = 50;
      practiceDrills.slice(0, 4).forEach((d, dIdx) => {
        doc.roundedRect(drillFigmaX, 496, 119, 105, 6).strokeColor(COLORS.border).lineWidth(1).stroke();

        doc.circle(drillFigmaX + 16, 511, 10).fill(drillColors[dIdx] || COLORS.primary);
        drawIcon(doc, drillIcons[dIdx] || "target", drillFigmaX + 8, 503, 16, COLORS.white);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.textLight).text("Drill", drillFigmaX + 32, 507);

        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(d.title, drillFigmaX + 8, 526, { width: 103, lineGap: 1.5 });

        const drillDesc = fitText(doc, d.desc || "", 103, "Inter", 6.5, 4, 2);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(drillDesc, drillFigmaX + 8, 544, { width: 103, lineGap: 2 });

        doc.moveTo(drillFigmaX + 8, 584).lineTo(drillFigmaX + 111, 584).strokeColor(COLORS.border).lineWidth(0.5).stroke();

        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(d.reps || "", drillFigmaX + 8, 588);
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(d.time || "", drillFigmaX + 80, 588, { align: "right", width: 31 });

        drillFigmaX += 125;
      });

      // Track Your Progress — add spacing and check for overflow
      doc.y = 600;
      ensureSpace(doc, 170, "Your Action Plan");
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primaryDark).text("TRACK YOUR PROGRESS", 50, doc.y);

      doc.rect(50, 615, 14, 2).fill(COLORS.primaryDark);
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text("Projected Overall Score", 68, 612);

      // Short x-labels so the last tick can't collide with the pills below.
      const chartPoints = [
        { xVal: "S1", yVal: 30 },
        { xVal: "S2", yVal: 42 },
        { xVal: "S3", yVal: 55 },
        { xVal: "S4", yVal: 66 },
        { xVal: "Target", yVal: 78 }
      ];
      drawLineChart(doc, 72, 625, 213, 80, chartPoints, 100, COLORS.primaryDark, { yAxis: true });

      // Pills sit clear below the x-axis tick row (ticks at y+h+5 = 710)
      doc.roundedRect(72, 730, 100, 14, 4).fill(COLORS.indigoBg);
      doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.primaryDark).text("78 ", 78, 733, { continued: true });
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.primary).text("Target Score");

      doc.roundedRect(180, 730, 105, 14, 4).fill(COLORS.emeraldBg);
      doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.emerald).text("70% ", 186, 733, { continued: true });
      doc.font("Inter").fontSize(6.5).fillColor(COLORS.emerald).text("Target Confidence");

      // Success Metrics — with proper vector icons
      doc.font("Inter-Bold").fontSize(9.5).fillColor(COLORS.primaryDark).text("SUCCESS METRICS", 300, doc.y > 650 ? doc.y - 100 : 600);

      const successIcons = ["target", "arrow_up", "speech_bubble", "gauge", "trending_up"];
      const figmaMetrics = [
        { label: "Overall Score", sub: "Goal: 78/100", val: isInsufficient ? 0 : overallScore, color: COLORS.primaryDark, display: isInsufficient ? "N/A" : `${overallScore}/100` },
        { label: "Confidence Score", sub: "Goal: 70%+", val: isInsufficient ? 0 : scores.delivery, color: COLORS.emerald, display: isInsufficient ? "N/A" : `${scores.delivery}%` },
        { label: "Clarity Score", sub: "Goal: 70%+", val: isInsufficient ? 0 : scores.clarity, color: COLORS.primary, display: isInsufficient ? "N/A" : `${scores.clarity}%` },
        { label: "Readiness Score", sub: "Goal: 70%+", val: isInsufficient ? 0 : scores.readiness, color: COLORS.amber, display: isInsufficient ? "N/A" : `${scores.readiness}%` },
        { label: "VC Investment Probability", sub: "Goal: 35%+", val: isInsufficient ? 0 : vcInvestmentProbability, color: COLORS.violet, display: isInsufficient ? "N/A" : `${vcInvestmentProbability}%` }
      ];

      let metricFigmaY = 618;
      figmaMetrics.forEach((m, mIdx) => {
        // Proper vector icon
        doc.circle(310, metricFigmaY + 11, 10).fill(COLORS.indigoBg);
        drawIcon(doc, successIcons[mIdx], 302, metricFigmaY + 3, 16, COLORS.primary);

        doc.font("Inter-Bold").fontSize(7.5).fillColor(COLORS.dark).text(m.label, 326, metricFigmaY);
        doc.font("Inter-Bold").fontSize(7.5).fillColor(m.color).text(m.display, 490, metricFigmaY, { align: "right", width: 55 });
        doc.font("Inter").fontSize(6.5).fillColor(COLORS.textLight).text(m.sub, 326, metricFigmaY + 8);

        doc.roundedRect(326, metricFigmaY + 17, 219, 5, 2.5).fill(COLORS.border);
        if (m.val > 0) {
          doc.roundedRect(326, metricFigmaY + 17, (m.val / 100) * 219, 5, 2.5).fill(m.color);
        }
        metricFigmaY += 28;
      });

      // Bottom callout
      doc.roundedRect(50, 752, 495, 20, 6).lineWidth(1).fillAndStroke(COLORS.indigoBg, COLORS.primary);
      doc.font("Inter-Bold").fontSize(8).fillColor(COLORS.dark).text("Next Step: ", 62, 757, { continued: true });
      doc.font("Inter").fontSize(8).fillColor(COLORS.dark).text("Implement this plan, practice consistently, and re-pitch. Your next session could be your breakthrough!", { lineBreak: false });

      // ── Footer loops ───────────────────────────────────────────────────────
      const range = doc.bufferedPageRange();
      const totalPages = range.count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        drawFooter(doc, i + 1, totalPages);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
