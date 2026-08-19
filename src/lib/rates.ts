/**
 * Parsing for HTS duty rate text.
 *
 * The rate cells are prose, not numbers, and the schedule uses a wide grammar:
 * "Free", "16.5%", "2.6¢/kg", "4.4¢/kg + 8.5%", "$1.035/kg", "20¢ each + 3.5%",
 * and a long tail of one-off constructions ("30.9¢/kg less 3.5¢/kg for each
 * degree under 40 degrees...", watch duties split across case, strap and
 * battery, "The duty provided in the applicable subheading").
 *
 * The first four forms cover the overwhelming majority of lines and are
 * evaluated exactly. Everything else is reported as not computable and its
 * literal text is shown instead. That distinction is deliberate: a landed-cost
 * number that silently drops half of a compound duty is worse than no number,
 * because it looks authoritative.
 */

/** A single additive component of a duty rate. */
export type RateTerm =
  | { kind: "advalorem"; fraction: number }
  | { kind: "specific"; amountUsd: number; per: string };

export interface ParsedRate {
  /** The text exactly as USITC published it. */
  text: string;
  /** True when the rate is unconditionally free. */
  free: boolean;
  /** Additive components, when the whole expression was understood. */
  terms: RateTerm[];
  /**
   * False when the text contains a construction this parser will not evaluate.
   * The caller must show `text` rather than a computed figure.
   */
  computable: boolean;
  /** Why it could not be computed, for display. */
  note?: string;
}

const NOT_COMPUTABLE: RegExp[] = [
  /duty provided in the applicable subheading/i,
  /rate applicable to each/i,
  /^see\b/i,
  /less .* for each degree/i,
  /on the case|on the strap|on the battery|on the movement/i,
  /\bper\b.*\bcontained\b/i,
  /but not less than|but not more than/i,
  /under bond/i,
  /no change/i,
  /^variable$/i,
];

/**
 * Unit aliases. The specific-duty denominator and the line's reporting unit are
 * written differently ("¢/kg" against a unit of "kg", "each" against "No."), so
 * both sides normalize to one key before they are matched.
 */
const UNIT_ALIASES: Record<string, string> = {
  kg: "kg",
  "clean kg": "kg",
  "kg cmsc": "kg",
  g: "g",
  t: "t",
  each: "each",
  "no.": "each",
  no: "each",
  pcs: "each",
  article: "each",
  head: "each",
  doz: "doz",
  "doz.": "doz",
  dozen: "doz",
  pr: "pr",
  "pr.": "pr",
  prs: "pr",
  "prs.": "pr",
  liter: "liter",
  liters: "liter",
  "pf.liter": "pf.liter",
  "pf.liters": "pf.liter",
  pf: "pf.liter",
  bbl: "bbl",
  gross: "gross",
  m: "m",
  "m²": "m2",
  "m³": "m3",
  thousand: "thousand",
  jewel: "jewel",
  line: "line",
};

/** Normalize a unit token from either the rate text or the units column. */
export function normalizeUnit(raw: string): string {
  const key = raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    // "pf. liter" and "pf.liter" are the same unit spelled two ways in the
    // schedule; collapse the space that follows an abbreviating period.
    .replace(/\.\s+/g, ".")
    .replace(/\bm2\b/g, "m²")
    .replace(/\bm3\b/g, "m³")
    .trim();
  return UNIT_ALIASES[key] ?? key;
}

/** Human label for a normalized unit key. */
export const UNIT_LABELS: Record<string, string> = {
  kg: "kilograms",
  g: "grams",
  t: "metric tons",
  each: "units",
  doz: "dozens",
  pr: "pairs",
  liter: "liters",
  "pf.liter": "proof liters",
  bbl: "barrels",
  gross: "gross (144)",
  m: "meters",
  m2: "square meters",
  m3: "cubic meters",
  thousand: "thousands",
  jewel: "jewels",
  line: "lines",
};

/**
 * Parse one duty rate cell.
 *
 * Terms are additive and separated by "+". Each is either a percentage of
 * customs value or a money amount per unit of quantity.
 */
export function parseRate(input: string): ParsedRate {
  const text = (input ?? "").replace(/\s+/g, " ").trim();

  if (!text) {
    return { text, free: false, terms: [], computable: false, note: "No rate published for this line." };
  }
  if (/^free$/i.test(text)) {
    return { text, free: true, terms: [], computable: true };
  }
  for (const pattern of NOT_COMPUTABLE) {
    if (pattern.test(text)) {
      return {
        text,
        free: false,
        terms: [],
        computable: false,
        note: "This rate is conditional or cross-references another provision, so it is shown as published rather than calculated.",
      };
    }
  }

  const terms: RateTerm[] = [];
  for (const rawPart of text.split(/\s*\+\s*/)) {
    const part = rawPart.trim();
    if (!part) continue;

    // Ad valorem: "16.5%"
    const adv = part.match(/^([\d.]+)\s*%$/);
    if (adv) {
      terms.push({ kind: "advalorem", fraction: Number.parseFloat(adv[1]!) / 100 });
      continue;
    }

    // Cents per unit: "2.6¢/kg", "20¢ each", "5.1¢/doz."
    const cents = part.match(/^([\d.]+)\s*¢\s*(?:\/\s*|each\b|per\s+)?([a-z0-9.²³ ]*)$/i);
    if (cents) {
      const unit = cents[2]!.trim() || "each";
      terms.push({ kind: "specific", amountUsd: Number.parseFloat(cents[1]!) / 100, per: normalizeUnit(unit) });
      continue;
    }

    // Dollars per unit: "$1.035/kg", "$2.50 each"
    const dollars = part.match(/^\$\s*([\d.]+)\s*(?:\/\s*|each\b|per\s+)?([a-z0-9.²³ ]*)$/i);
    if (dollars) {
      const unit = dollars[2]!.trim() || "each";
      terms.push({ kind: "specific", amountUsd: Number.parseFloat(dollars[1]!), per: normalizeUnit(unit) });
      continue;
    }

    return {
      text,
      free: false,
      terms: [],
      computable: false,
      note: `The component "${part}" is not in a form this calculator evaluates.`,
    };
  }

  if (terms.length === 0) {
    return { text, free: false, terms: [], computable: false, note: "Rate text could not be interpreted." };
  }
  return { text, free: false, terms, computable: true };
}

/**
 * Display label for a unit key.
 *
 * Qualified weights ("kg on drained weight", "kg on lead content") are left
 * intact rather than folded into plain kilograms. The distinction is the whole
 * point: the duty is owed on the drained or metal-content weight, and charging
 * it against gross weight would overstate the duty, often severely.
 */
export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

/** Singular form, for "per kilogram" rather than "per kilograms". */
const UNIT_SINGULAR: Record<string, string> = {
  kg: "kilogram",
  g: "gram",
  t: "metric ton",
  each: "unit",
  doz: "dozen",
  pr: "pair",
  liter: "liter",
  "pf.liter": "proof liter",
  bbl: "barrel",
  gross: "gross",
  m: "meter",
  m2: "square meter",
  m3: "cubic meter",
  thousand: "thousand",
  jewel: "jewel",
  line: "line",
};

export function unitLabelSingular(unit: string): string {
  return UNIT_SINGULAR[unit] ?? unit;
}

/** Every distinct quantity unit a parsed rate needs in order to be evaluated. */
export function requiredUnits(rate: ParsedRate): string[] {
  return [...new Set(rate.terms.filter((t) => t.kind === "specific").map((t) => t.per))];
}

/**
 * One clause of the Column 1 Special cell: a rate that applies to the listed
 * program codes. `Free (AU,BH,CL) 3.5% (JP)` yields two clauses.
 */
export interface SpecialClause {
  rateText: string;
  codes: string[];
}

/**
 * Split the Special column into per-program clauses.
 *
 * Codes carry qualifiers: `A*` means the program applies but specific countries
 * are excluded for this line, `S+` and `P+` are separate USMCA/CAFTA-DR
 * eligibility sets. The suffix is preserved so the caller can flag it.
 */
export function parseSpecial(input: string): SpecialClause[] {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  const clauses: SpecialClause[] = [];
  // Each clause is rate text followed by a parenthesised code list.
  const pattern = /([^()]+?)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const rateText = match[1]!.trim().replace(/^,\s*/, "");
    const codes = match[2]!
      .split(",")
      .map((c) => c.replace(/\s+/g, "").trim())
      .filter(Boolean);
    if (rateText && codes.length > 0) clauses.push({ rateText, codes });
  }

  // A bare "Free" with no code list applies to every program on the line.
  if (clauses.length === 0 && /^free$/i.test(text)) return [{ rateText: "Free", codes: ["*"] }];
  return clauses;
}
