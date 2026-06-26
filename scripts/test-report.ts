// Acceptance-test fixture: a deliberately weak, below-average, LONG-text session.
// Long descriptions trigger the layout patterns; the low score triggers the
// percentile invariant. Run: npx tsx scripts/test-report.ts
import fs from "fs";
import path from "path";
import { generatePitchReportPDF } from "../src/services/pdfService.ts";
import {
  computeFounderPercentile,
  computeOverallScore,
  AVERAGE_FOUNDER_SCORE,
} from "../src/services/aiService.ts";

const long = (s: string) => s.repeat(3).trim();

const scores = { delivery: 30, clarity: 35, scalability: 22, readiness: 28 };
const overall = computeOverallScore(scores);
const topic = [
  { topic: "Problem Definition", percentage: 90 },
  { topic: "Solution Overview", percentage: 80 },
  { topic: "Market Size", percentage: 30 },
  { topic: "Business Model", percentage: 20 },
  { topic: "Go-to-Market", percentage: 10 },
  { topic: "Traction", percentage: 0 },
];
const topicMean = Math.round(topic.reduce((s, t) => s + t.percentage, 0) / topic.length);

const evaluation_report = {
  evaluationStatus: "complete",
  scores,
  summary: long("This founder showed early passion but the pitch lacked the substance investors need to move forward, with major gaps across market sizing, unit economics, and technical feasibility that were never addressed. "),
  strengths: [
    long("Demonstrated genuine domain passion and a clear personal connection to the problem of delayed diagnosis in underserved regions which made the narrative compelling and defensible. "),
    long("Articulated an ambitious continental vision for African founders that resonates with the underserved market opportunity and could scale meaningfully if executed with discipline. "),
    long("Showed willingness to engage with tough investor questions even when unprepared, signalling coachability and resilience under real pressure. "),
  ],
  risks: [
    long("Projected market size of five million founders lacks any methodology, sourcing, or bottom-up breakdown, undermining the credibility of every downstream revenue projection in the model. "),
    long("No clarity whatsoever on customer acquisition cost, pricing tiers, gross margin, or the broader go-to-market motion that would make this a defensible venture-scale business. "),
    long("No information on the AI architecture, data strategy, model evaluation, or scalability approach, leaving deep uncertainty about technical feasibility and moat. "),
  ],
  next_steps: [
    { title: "Develop Detailed Market Analysis", priority: "High Priority", desc: long("Provide a clear bottom-up breakdown of the total addressable market with credible sources and realistic capture projections over a defined time horizon. ") },
    { title: "Clarify Unit Economics and GTM", priority: "High Priority", desc: long("Outline customer acquisition costs, pricing model, contribution margin, and the specific channels you will use to reach your first thousand paying customers. ") },
    { title: "Present Technical Infrastructure Plan", priority: "Medium Priority", desc: "Detail the AI system architecture, data pipeline, and scalability approach." },
  ],
  sentiments: [
    { persona: "Marcus (Lead Investor)", quote: long("The market sizing feels overly optimistic without any clear evidence of demand or a defensible wedge against incumbents who already serve adjacent needs. ") },
    { persona: "Sarah (Partner)", quote: long("The unit economics and customer acquisition strategy were simply not addressed, which makes it impossible for me to gauge financial viability at this stage. ") },
    { persona: "Chen (Tech Investor)", quote: "The technical details and infrastructure plans were missing, so I'm unsure about feasibility." },
  ],
  topic_coverage: topic,
  topic_coverage_overall: topicMean,
  transcript_summary: long("The founder introduced the concept and core features with enthusiasm, but the market size claim lacked justification, and key areas such as unit economics, go-to-market strategy, traction, team composition, and technical infrastructure were never meaningfully addressed during the session. "),
  questions_to_prepare: [
    "How did you calculate your total addressable market and what sources back it up?",
    "What is your pricing model and what are the underlying unit economics?",
    "How will you acquire your first one thousand paying customers cost-effectively?",
    "What makes your product defensible against well-funded global competitors?",
  ],
  competitive_landscape: {
    swot: {
      strengths: [long("AI-powered investor and accelerator panel simulation tuned for local context. "), "Built specifically for African founders and investors", "Affordable and accessible pricing model for early teams", "Addresses a large and structurally underserved market"],
      weaknesses: [long("Limited brand awareness, no meaningful early traction, and an unproven retention story across cohorts. "), "No clear unit economics yet", "Small team and limited engineering resources", "Lack of enterprise integrations"],
      opportunities: ["Rapidly growing startup ecosystem across the continent", "Partnerships with accelerators and VC funds", "Expansion into other emerging markets", "Add fundraising analytics and benchmarking"],
      threats: [long("Large global incumbents could trivially enter and replicate the core feature set with far greater distribution. "), "Feature replication is easy", "Downturn may reduce startup funding", "Acquisition costs may rise over time"],
    },
    strategic_recommendation: long("PitchNest is addressing a real and underserved need with a credible value proposition, and the Africa-first focus is a genuine differentiator; however, to compete with well-funded global players you must show concrete traction, refine unit economics, and lock in distribution partnerships with local accelerators and funds before raising. "),
    key_focus_areas: [long("Validate real market demand with paying users before scaling spend. "), "Prove unit economics and retention", "Build strategic distribution partnerships", "Strengthen the technical roadmap and moat"],
  },
  practice_drills: [
    { title: "Elevator Pitch (60 sec)", desc: long("Practice a clear, concise pitch that covers the problem, solution, and value proposition without jargon or filler. "), reps: "3 Reps", time: "5 min" },
    { title: "Market Size Breakdown", desc: long("Present your TAM, SAM, and SOM with clear numbers, credible sources, and a bottom-up derivation. "), reps: "2 Reps", time: "7 min" },
    { title: "Unit Economics Pitch", desc: "Explain pricing, CAC, LTV, and why the model is sustainable.", reps: "2 Reps", time: "6 min" },
    { title: "Investor Q&A Simulation", desc: "Answer tough investor questions with clarity and confidence.", reps: "5 Qs", time: "10 min" },
  ],
  market_gaps: [
    { title: "Geographic Focus", desc: long("Most incumbent tools focus on US and European founders, leaving African founders without tailored guidance. ") },
    { title: "Investor Simulation", desc: long("Few platforms simulate local investor dynamics, term expectations, or regional diligence norms. ") },
    { title: "Localized Insights", desc: "No localized templates or guidance for African founders." },
    { title: "Affordability", desc: "Competitors are too expensive for early-stage founders." },
  ],
  collaboration_opportunities: [
    long("Partner with African accelerators and incubators for distribution and co-marketing across cohorts and demo days. "),
    "Collaborate with VC firms to provide portfolio company training",
    "Build integrations with pitch deck tools like Tome and Beautiful.ai",
    "Establish university partnerships for entrepreneurship programs",
  ],
  question_difficulty: { easy: 2, medium: 3, hard: 3 },
  vc_investment_probability: 14,
  competitors: [
    { name: "Competitor Alpha", similarity: 80, strength: long("Strong brand presence and an established content engine that drives consistent inbound. "), weakness: long("Limited geographic focus with no localized investor data for emerging markets. "), size: "$15M+", estimated: true },
    { name: "Competitor Beta", similarity: 72, strength: "Great UX and onboarding", weakness: long("Higher price point that prices out the earliest-stage founders this product targets. "), size: "Est. ~$10M ARR", estimated: true },
    { name: "Competitor Gamma", similarity: 65, strength: "Large existing user base", weakness: "No AI features", size: "N/A", estimated: true },
    { name: "Competitor Delta", similarity: 55, strength: "Backed by top-tier VCs", weakness: "Poor customer support", size: "approx. mid-market", estimated: true },
  ],
  competitors_disclaimer: "Competitor figures are AI-generated estimates, not verified data.",
  companies_to_study: [
    { name: "Y Combinator", why: long("Best-in-class founder education, a powerful alumni network, and a brand that compounds trust over time. ") },
    { name: "Stripe", why: long("Exceptional developer experience and relentless product-led growth that set the bar for infrastructure. ") },
    { name: "Canva", why: "Mastered freemium conversion at global scale." },
    { name: "Notion", why: "Viral growth through templates and community sharing." },
  ],
  top_priorities: [
    { title: "Strengthen Market Size", desc: long("Provide a detailed bottom-up breakdown of your market with realistic capture projections and credible sources. "), priority: "High Priority", impact: "Very High" },
    { title: "Clarify Unit Economics", desc: long("Define your pricing model, CAC, LTV, and gross margin to demonstrate financial viability under scrutiny. "), priority: "High Priority", impact: "Very High" },
    { title: "Present Technical Scale", desc: "Explain your architecture, data pipeline, and scalability strategy clearly.", priority: "High Priority", impact: "High" },
    { title: "Build Traction and Proof", desc: "Show early user adoption, testimonials, and partnership evidence.", priority: "Medium Priority", impact: "High" },
    { title: "Refine Go-to-Market", desc: "Outline acquisition channels, partnerships, and a clear growth plan.", priority: "Medium Priority", impact: "Medium" },
  ],
  answer_framework: {
    question: "How did you calculate your total addressable market and what credible sources back up that figure?",
    steps: [
      { label: "Start with the Big Picture", text: "Reference total industry size using credible third-party sources." },
      { label: "Show Your Calculation", text: "Break TAM into SAM and SOM with clear logical steps and assumptions." },
      { label: "Market Capture Plan", text: "State a realistic capture percentage and the timeline to reach it." },
      { label: "Back It Up with Data", text: "Cite sources like Statista, World Bank, or named industry reports." },
      { label: "Close with Confidence", text: "Restate the conservative estimate and the levers to expand it." },
    ],
  },
  category_matrix: [
    { category: "Delivery", went_well: long("Opened with conviction and a clear personal hook that drew the panel in. "), needs_improvement: long("Pace became inconsistent and rushed under financial questioning, losing the thread. "), impact: "Moderate" },
    { category: "Clarity", went_well: "Problem statement was clearly framed.", needs_improvement: long("Market sizing was asserted rather than derived, leaving the core claim unsupported. "), impact: "High" },
    { category: "Scalability", went_well: "Large market segment identified.", needs_improvement: "No clear scaling or distribution plan was articulated.", impact: "High" },
    { category: "Readiness", went_well: "Passionate about the long-term vision.", needs_improvement: "Unit economics and use of funds were undefined.", impact: "High" },
  ],
  confidence_timeline: [
    { time: "0:00", value: 70 },
    { time: "1:30", value: 55 },
    { time: "3:00", value: 40 },
    { time: "4:30", value: 32 },
    { time: "6:00", value: 38 },
  ],
  duration: 372,
  // Real transcript so delivery metrics (words spoken, filler %, questions
  // asked, talk ratio) are computed, not faked. Includes a $50M raise the
  // founder NEVER states — used to confirm the raise-figure guard.
  transcript: [
    { type: "model", speaker: "Marcus", text: "Welcome. Whenever you're ready, go ahead and give us your pitch." },
    { type: "user", inputMethod: "voice", text: "We help elderly people in Nigeria monitor their health with AI.", fullText: "Um, so, like, HealthMate AI is basically a mobile app that, uh, helps elderly people in Nigeria monitor their health using AI. You know, a lot of older folks in underserved areas, um, don't get timely diagnosis, so we, like, give them daily check-ins and alerts." },
    { type: "model", speaker: "Sarah", text: "How did you calculate your total addressable market?" },
    { type: "user", inputMethod: "voice", text: "There are about 5 million elderly people we could reach.", fullText: "Uh, well, there are like 5 million elderly people in Nigeria, um, and we figure we can reach a good chunk of them, you know, over time." },
    { type: "model", speaker: "Sarah", text: "What is your pricing model and what are the unit economics behind it?" },
    { type: "user", inputMethod: "voice", text: "We haven't finalized pricing yet.", fullText: "Hmm, actually we, uh, haven't really finalized pricing yet, but it'll be, like, a subscription probably." },
    { type: "model", speaker: "Chen", text: "Can you walk me through the AI architecture and your data strategy?" },
    { type: "user", inputMethod: "chat", text: "It's still early, we're using off-the-shelf models for now." },
    { type: "model", speaker: "Marcus", text: "Thanks, that gives us a clear picture of where you are." },
  ],
};

const session = {
  business_name: "HealthMate AI",
  created_at: new Date().toISOString(),
  evaluation_report,
};

(async () => {
  console.log("Overall score:", overall, "(avg benchmark:", AVERAGE_FOUNDER_SCORE + ")");
  const pct = computeFounderPercentile(overall);
  console.log("Founder percentile (scored higher than):", pct + "%", pct < 50 ? "✓ below-average" : "✗ ABOVE-AVERAGE BUG");
  console.log("Topic coverage mean (donut center):", topicMean + "%");
  console.log("Hard question count:", evaluation_report.question_difficulty.hard);

  const buf = await generatePitchReportPDF(session);
  const out = path.resolve(process.cwd(), "test-report.pdf");
  fs.writeFileSync(out, buf);
  console.log(`\nPDF generated OK: ${buf.length} bytes → ${out}`);
})().catch((e) => {
  console.error("PDF generation FAILED:", e);
  process.exit(1);
});
