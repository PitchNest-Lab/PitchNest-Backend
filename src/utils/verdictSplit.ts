/**
 * Splits the single verdict-turn response ("Marcus: … Sarah: … Chen: …") into
 * one text per panelist.
 *
 * A speaker boundary is a panelist name followed by a colon at the start of the
 * response, a line, or a sentence. The previous splitter treated ANY mention of
 * a name followed by a space as a boundary, so "Marcus: I agree with Sarah that
 * margins are thin — I'm in" cut Marcus's verdict to "I agree with" and handed
 * the rest to Sarah, which also flipped the in/out classification.
 *
 * If the model drops the "Name:" colons entirely, falls back to the original
 * loose name matching so the founder still gets verdicts rather than none.
 *
 * Returns a map of name → verdict text. Names the model never prefixed are
 * absent; the caller decides how to handle them (e.g. single-panelist coach
 * mode uses the whole response).
 */
export function splitVerdictsBySpeaker(
  response: string,
  names: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (!response || names.length === 0) return out;

  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const boundary = new RegExp(
    `(^|\\n|[.!?]["')\\]]?\\s+)\\s*\\**(${escaped.join("|")})(?:\\s*:\\**|\\**\\s*:)`,
    "gi",
  );

  const marks: Array<{ name: string; textStart: number; markStart: number }> = [];
  for (const m of response.matchAll(boundary)) {
    if (m.index === undefined) continue;
    const canonical = names.find((n) => n.toLowerCase() === m[2].toLowerCase());
    if (!canonical) continue;
    marks.push({
      name: canonical,
      markStart: m.index + m[1].length,
      textStart: m.index + m[0].length,
    });
  }

  for (let i = 0; i < marks.length; i++) {
    const { name, textStart } = marks[i];
    if (out.has(name)) continue; // first verdict per panelist wins
    const end = i + 1 < marks.length ? marks[i + 1].markStart : response.length;
    const text = response.slice(textStart, end).trim();
    if (text) out.set(name, text);
  }
  return out.size > 0 ? out : splitVerdictsLoose(response, names, escaped);
}

function splitVerdictsLoose(response: string, names: string[], escaped: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < names.length; i++) {
    const m = response.match(
      new RegExp(`${escaped[i]}[:\\s]+(.+?)(?=(?:${escaped.join("|")})[:\\s]|$)`, "is"),
    );
    const text = m?.[1]?.trim();
    if (text) out.set(names[i], text);
  }
  return out;
}
