/**
 * Matching a classification and an origin to the Chapter 99 additional duties
 * that stack on top of the ordinary rate.
 *
 * The data behind this is mined from the Chapter 99 U.S. Notes, which are prose
 * written for people. Coverage lists parse cleanly; country scope does not
 * always. Every match therefore carries a confidence, and only `confirmed`
 * matches are applied without being asked for — an over-applied 25% is as wrong
 * as a missing one, and both are invisible to a user who trusts the total.
 */
import type { Country } from "./programs.ts";
import { EU_MEMBERS } from "./programs.ts";

export type Scope =
  | { kind: "country"; name: string }
  | { kind: "all-except"; names: string[] }
  | { kind: "all" }
  | { kind: "unknown"; text: string };

export interface Remedy {
  heading: string;
  uplift: number;
  rateText: string;
  description: string;
  noteRefs: string[];
  scope: Scope;
  exceptHeadings: string[];
  /** "list" covers enumerated codes; "blanket" covers an origin wholesale. */
  kind: "blanket" | "list";
  /** Headings that take precedence over this one, per the U.S. Notes. */
  displacedBy?: string[];
  /** True when a Chapter 98 claim waives this duty. */
  chapter98Waives?: boolean;
  /**
   * A flat rate that replaces the ordinary duty instead of adding to it — how
   * the schedule writes a negotiated floor, such as the 15% on Japanese cars.
   */
  replaces?: number;
  /** Condition on the ordinary rate that gates this heading. */
  threshold?: { op: "gte" | "lt"; rate: number };
}

export interface RemedyData {
  remedies: Remedy[];
  /** digits-only HTS code -> heading codes */
  coverage: Record<string, string[]>;
}

export interface RemedyMatch {
  remedy: Remedy;
  /**
   * `confirmed` — the notes name this origin, or name an exclusion list this
   * origin is not on. Applied by default.
   * `possible` — the goods are covered but the scope text could not be read.
   * Shown, not applied.
   */
  confidence: "confirmed" | "possible";
  /** Why it matched, for display. */
  reason: string;
  /** The code that matched, or "origin" for a blanket heading. */
  matchedOn: string;
  /**
   * Carve-outs that reduce or remove this duty if the importer can claim one.
   *
   * Duties are written as "everything from X except ...", and the exceptions
   * are where most real shipments land — most Canadian and Mexican goods
   * qualify under USMCA and owe nothing.
   *
   * Not all of them waive the duty. A carve-out can substitute a lower rate
   * instead: the 35% on Canadian goods excepts crude oil and potash to 10%.
   * Treating only zero-rate provisions as carve-outs hid 103 of these, so an
   * importer of Canadian crude saw 35% with no sign the energy rate existed.
   * Any provision cheaper than its parent qualifies.
   */
  exemptions: Remedy[];
}

/**
 * Country names as the notes write them, mapped to the table in programs.ts.
 * The notes are not consistent with the schedule ("South Korea" against
 * "Korea, South"; "the Russian Federation" against "Russia").
 */
const NAME_ALIASES: Record<string, string> = {
  "south korea": "Korea, South",
  "north korea": "Korea, North",
  "republic of korea": "Korea, South",
  "russian federation": "Russia",
  "united states": "United States",
  "hong kong sar": "Hong Kong",
  "the united kingdom": "United Kingdom",
};

const canonical = (name: string): string => {
  const key = name.toLowerCase().replace(/^the\s+/, "").trim();
  return NAME_ALIASES[key] ?? name.replace(/^the\s+/i, "").trim();
};

/** Does a scope name refer to this country? Handles the EU as a bloc. */
function nameMatches(scopeName: string, country: Country): boolean {
  const name = canonical(scopeName);
  if (/member nations of the european union|european union/i.test(scopeName)) {
    return EU_MEMBERS.has(country.iso);
  }
  return name.toLowerCase() === country.name.toLowerCase();
}

const digits = (code: string): string => code.replace(/\D/g, "");

/** Does a heading's scope reach this origin? */
function scopeReaches(scope: Scope, country: Country): boolean {
  switch (scope.kind) {
    case "country":
      return nameMatches(scope.name, country);
    case "all-except":
      return !scope.names.some((n) => nameMatches(n, country));
    case "all":
      return true;
    default:
      return false;
  }
}

/**
 * Find every additional-duty heading that reaches this code and origin.
 *
 * Coverage is looked up at both the entry code and its 8-digit subheading,
 * because the notes are inconsistent about which they list: note 37 names
 * 10-digit statistical codes, note 20 names 8-digit subheadings, and a good
 * imported under a 10-digit code is reached by either.
 */
export function matchRemedies(
  data: RemedyData,
  entryCode: string,
  country: Country,
  /**
   * The line's ordinary ad valorem rate, when it is a plain percentage.
   *
   * Some headings are gated on it — a negotiated ceiling is written as a pair,
   * one for rates at or above the threshold and one for rates below. Given the
   * base rate exactly one of the pair survives; without it both are offered and
   * the user is asked to decide what the data already settles. Left undefined
   * for compound or specific duties, whose ad valorem equivalent depends on
   * quantity, and then neither is filtered out.
   */
  baseRate?: number,
): RemedyMatch[] {
  const byHeading = new Map(data.remedies.map((r) => [r.heading, r]));
  const full = digits(entryCode);
  const parent = full.slice(0, 8);

  const found = new Map<string, string>(); // heading -> matched code
  for (const key of full === parent ? [full] : [full, parent]) {
    for (const heading of data.coverage[key] ?? []) {
      if (!found.has(heading)) found.set(heading, key);
    }
  }

  // Blanket headings reach an origin wholesale, so they are found by scope
  // rather than by code.
  for (const remedy of data.remedies) {
    if (remedy.kind !== "blanket" || remedy.uplift <= 0) continue;
    if (found.has(remedy.heading)) continue;
    if (scopeReaches(remedy.scope, country)) found.set(remedy.heading, "origin");
  }

  const matches: RemedyMatch[] = [];
  for (const [heading, matchedOn] of found) {
    const remedy = byHeading.get(heading);
    if (!remedy) continue;

    // Drop the half of a threshold pair the base rate rules out.
    if (remedy.threshold && baseRate !== undefined) {
      const satisfied =
        remedy.threshold.op === "lt" ? baseRate < remedy.threshold.rate : baseRate >= remedy.threshold.rate;
      if (!satisfied) continue;
    }

    const exemptions = remedy.exceptHeadings
      .map((h) => byHeading.get(h))
      .filter((r): r is Remedy => {
        if (!r) return false;
        // A replacement provision is a carve-out whenever it can come out
        // cheaper; whether it actually does depends on the base rate, which is
        // not known here.
        if (r.replaces !== undefined) return true;
        return r.uplift < remedy.uplift;
      });

    let confidence: RemedyMatch["confidence"] = "possible";
    let reason: string;

    /*
     * Blanket headings are surfaced but never applied automatically.
     *
     * Several usually reach the same origin at once — Canada matches a 35%, a
     * 40% and two transshipment provisions — and they are alternatives keyed to
     * dates, conditions and CBP determinations rather than duties that sum.
     * Adding them gives 165% for goods that mostly owe nothing once USMCA is
     * claimed. Showing them switched off fixes the real defect, which was that
     * Canada looked clean, without inventing a total.
     */
    if (remedy.kind === "blanket") {
      if (!scopeReaches(remedy.scope, country)) continue;
      matches.push({
        remedy,
        confidence: "possible",
        reason:
          "This heading applies to goods of this origin generally rather than to a list of classifications. Several such headings often overlap and are alternatives rather than additions, so none is applied automatically. Check which is in force for your entry date and goods.",
        matchedOn,
        exemptions,
      });
      continue;
    }

    switch (remedy.scope.kind) {
      case "country": {
        if (!nameMatches(remedy.scope.name, country)) continue; // wrong origin entirely
        confidence = "confirmed";
        reason = `The notes apply this heading to products of ${remedy.scope.name}.`;
        break;
      }
      case "all-except": {
        const excluded = remedy.scope.names.some((n) => nameMatches(n, country));
        if (excluded) continue;
        confidence = "confirmed";
        reason = `This heading applies to all countries except ${remedy.scope.names.join(", ")}. ${country.name} is not excluded.`;
        break;
      }
      case "all":
        confidence = "confirmed";
        reason = "This heading applies to products of any country.";
        break;
      default:
        reason =
          "The goods are within this heading's coverage list, but the notes state its country scope in prose this tool could not read. Check the heading before applying it.";
    }

    matches.push({ remedy, confidence, reason, matchedOn, exemptions });
  }

  /*
   * Drop any heading the notes say is displaced by another that also matched.
   *
   * A Canadian kitchen cabinet matches the Section 232 cabinet duty and, being
   * Canadian, the 35% IEEPA blanket. Note 2(j) says the blanket does not reach
   * goods the 232 headings already cover, so listing both overstates the
   * position and invites the user to add them together.
   */
  const matchedHeadings = new Set(matches.map((m) => m.remedy.heading));
  const surviving = matches.filter(
    (m) => !(m.remedy.displacedBy ?? []).some((h) => matchedHeadings.has(h)),
  );
  matches.length = 0;
  matches.push(...surviving);

  // Carve-outs: a heading listed as an exception to another is more specific,
  // so surface the specific one first.
  matches.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "confirmed" ? -1 : 1;
    return b.remedy.uplift - a.remedy.uplift;
  });
  return matches;
}
