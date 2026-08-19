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
  /** The code that matched: the entry code or its 8-digit parent. */
  matchedOn: string;
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

  const matches: RemedyMatch[] = [];
  for (const [heading, matchedOn] of found) {
    const remedy = byHeading.get(heading);
    if (!remedy) continue;

    let confidence: RemedyMatch["confidence"] = "possible";
    let reason: string;

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

    matches.push({ remedy, confidence, reason, matchedOn });
  }

  // Carve-outs: a heading listed as an exception to another is more specific,
  // so surface the specific one first.
  matches.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "confirmed" ? -1 : 1;
    return b.remedy.uplift - a.remedy.uplift;
  });
  return matches;
}
