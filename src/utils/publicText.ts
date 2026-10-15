/**
 * Cleaning and validation for user-written text that is shown publicly
 * (comments, business updates, community posts). React escapes it on render;
 * this layer removes invisible characters, normalises whitespace, and enforces
 * length and link limits so the text reads honestly and can't hide content.
 */

// C0 controls except tab and newline, DEL, zero-width marks, line/paragraph
// separators, bidi overrides, word joiners and the BOM. Expressed as numeric
// code-point ranges so no literal invisible character ever sits in source.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x007f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];

export function stripInvisible(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (!INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high)) out += char;
  }
  return out;
}

export function cleanPublicText(value: string): string {
  return stripInvisible(value.normalize("NFKC").replace(/\r\n?/g, "\n"))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countLinks(value: string): number {
  return value.match(/\bhttps?:\/\/|\bwww\./gi)?.length ?? 0;
}

export interface PublicTextRules {
  min: number;
  max: number;
  maxLinks: number;
  /** Lower-case noun for messages, e.g. "comment" or "update". */
  noun: string;
}

/** Returns the cleaned text, or an error message suitable for the user. */
export function validatePublicText(
  raw: unknown,
  rules: PublicTextRules,
): { text: string; error?: string } {
  if (typeof raw !== "string") return { text: "", error: `Your ${rules.noun} must be text.` };
  const text = cleanPublicText(raw);
  if (text.length < rules.min) return { text, error: `Write at least ${rules.min} characters.` };
  if (text.length > rules.max) {
    return { text, error: `${capitalise(rules.noun)}s can be up to ${rules.max} characters.` };
  }
  if (countLinks(text) > rules.maxLinks) {
    return { text, error: `${capitalise(rules.noun)}s can include at most ${rules.maxLinks} links.` };
  }
  return { text };
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
