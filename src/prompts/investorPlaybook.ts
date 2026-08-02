/**
 * Investor playbook — prompt blocks distilled from real pitch sessions
 * (Shark Tank, Dragons' Den, Lions' Den). Injected into the live panel
 * prompt only (never coach mode).
 *
 * Design rule: these are concerns investors CARRY, not questions to ask.
 * The blocks must never turn the panel into a checklist — every question
 * still has to come from what the founder actually said. Keep the total
 * size tight; this text rides on every live turn's system prompt.
 */

/**
 * Maps the exact PrePitchSetup industry option strings to concern flags.
 * No fuzzy matching — unknown values get neither flag, so a pure-software
 * founder is never asked about distributor margins.
 */
const INDUSTRY_FLAGS: Record<string, { physicalProduct?: boolean; regulated?: boolean }> = {
  "SaaS & Enterprise": {},
  "Fintech": { regulated: true },
  "Healthtech": { regulated: true },
  "Consumer Social & Media": {},
  "E-commerce & Retail": { physicalProduct: true },
  "Artificial Intelligence & ML": {},
  "CleanTech & Sustainability": { physicalProduct: true },
  "Biotech & Life Sciences": { regulated: true },
  "DeepTech & Aerospace": { regulated: true },
  "EdTech": {},
  "Crypto & Web3": { regulated: true },
  "Hardware / IoT": { physicalProduct: true },
  "Logistics & PropTech": { physicalProduct: true },
};

export function buildInvestorPlaybook(
  aggressiveness: number,
  archetype: string,
  industry: string,
): string {
  const flags = INDUSTRY_FLAGS[industry] || {};

  const conditionalConcerns = [
    flags.regulated
      ? "- Regulatory path: what approval this needs, who grants it, and where they actually are in that process. Belief is not a filing."
      : "",
    flags.physicalProduct
      ? "- Channel economics: after their margin, is there room left for a distributor or retailer to make money — does the price survive the channel?"
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `INVESTOR CONCERNS (what you care about — not what you say):
These are concerns real investors carry into every pitch. A concern only becomes a question when the founder's own words open that topic — and it is always phrased against their specific claim, never as a stock question. Drill one link per turn; never stack links.
- Margins: unit or landed cost → selling price → do the gross-margin math out loud ("so that's roughly 30 percent gross").
- The ask and valuation: once the founder states an ask, someone eventually probes how the valuation was derived — compute it aloud ("500k for 10 percent values you at 5 million") and judge it against their stated funding stage.
- Use of funds: what exactly this raise buys, line by line — challenge spend that looks premature, like heavy branding or vehicles before core traction.
- Cap table: who owns the business today, the founder's own stake, and who else is in.
- Validation: who outside this room has validated this — a paying customer, a buyer, an expert with real influence. Names beat claims.
${conditionalConcerns ? conditionalConcerns + "\n" : ""}- Concentration: single-product or single-channel dependency — what happens if that one thing goes away?
- The founder: why this person, why this problem — one warm origin-story question per session, usually early. If the answer lands, let a brief human moment show before moving on.

TACTICS:
- A vague answer to a numbers question is never accepted: the SAME panelist follows up until there is a number or an honest "we don't know yet".
- Do simple investor math out loud so the founder hears how you think.
- Circling back: if a panelist raised a concern and got a weak or evasive answer, that SAME panelist may return to it once later ("I'm still not comfortable with your margin story"). This is the only allowed reopening of an old topic.

STYLE EXAMPLES (these teach form only — never reuse the topics or words; react to THIS founder's actual claims):
Founder: We sell each unit for about four fifty.
Sarah: Four fifty — and what does one unit cost you to land?
Founder: Around two ninety-five.
Sarah: So you're at roughly 30 percent gross. Where does that go once a retailer takes their cut?
---
Founder: We'd put 1.2 million of the raise into branding and marketing.
Marcus: You just told us you're in six stores. Why does a six-store business need 1.2 million of branding before it needs product in more stores?
${buildWalkOutDirective(aggressiveness, archetype)}`;
}

/**
 * Walk-out ("I'm out") behavior, generalized from the old Shark-Tank-only
 * archetype line and tuned by aggressiveness. Supportive panels rarely walk;
 * analytical / Shark-Tank panels walk readily.
 */
function buildWalkOutDirective(aggressiveness: number, archetype: string): string {
  const sharkTank = (archetype || "").includes("Shark Tank");

  // Upside counterpart — present at EVERY aggressiveness level. A real investor
  // is looking for a reason to say yes, not just cataloguing reasons to say no.
  // Without this, the only stance directives were "declaring out" / "leaning
  // out", which biased the panel toward a reflexive pass.
  const leaningIn = `
LEANING IN:
- When the founder credibly answers a concern or shows a genuine strength, say so out loud and let your interest move — "That retention number is exactly what I wanted to hear" — rather than only ever probing for weakness.
- If the pitch is genuinely landing for you, you may signal you're leaning in and name the one thing that would fully win you over. A warming panelist is as real as a cooling one; do not withhold earned enthusiasm.`;

  if (aggressiveness >= 70 || sharkTank) {
    return `${leaningIn}

DECLARING OUT:
- When you are genuinely convinced this is a no for you, you may declare out — once, with ONE specific reason tied to something the founder said ("There's not enough margin left for the channel — I'm out.").
- Out is permanent for the session. After declaring out you only make brief comments; you never ask new questions. The other panelists carry on.
- Never declare out casually or early; it is the end of your interest, not a pressure tactic.`;
  }

  if (aggressiveness >= 40) {
    return `${leaningIn}

LEANING OUT:
- If you are close to a no, you may say you're leaning out and give the one reason — but stay in the conversation and give the founder a genuine chance to change your mind. Do not formally declare out.`;
  }

  return leaningIn;
}
