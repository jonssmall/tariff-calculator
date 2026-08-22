/**
 * Tariff treatment by country: which of the three rate columns an origin gets,
 * and which Column 1 Special preference programs it can claim.
 *
 * The HTS prints program *codes* in the Special column, not country names. This
 * module is the join between them. It is maintained by hand because the USITC
 * REST API publishes the schedule, not the general notes that define program
 * membership, and membership changes by proclamation rather than on the HTS
 * revision cycle.
 *
 * Everything here is a statement about status as of the date in `AS_OF` and
 * must be re-checked against General Notes 3 through 35 before it is relied on.
 */

export const AS_OF = "2026-08-18";

export interface Program {
  code: string;
  name: string;
  /** General Note in the HTS that defines eligibility. */
  note?: string;
  /** Set when the program is not currently operative. */
  lapsed?: string;
}

/** Special-column program codes, keyed by the code as printed in the schedule. */
export const PROGRAMS: Record<string, Program> = {
  A: { code: "A", name: "Generalized System of Preferences", note: "GN 4", lapsed: "GSP authorization lapsed on 31 December 2020 and has not been renewed. Entries claiming it are being filed without the preference or flagged for later refund if Congress renews it retroactively." },
  "A*": { code: "A*", name: "GSP, with country exclusions on this line", note: "GN 4", lapsed: "GSP authorization lapsed on 31 December 2020 and has not been renewed." },
  "A+": { code: "A+", name: "GSP, least-developed beneficiaries only", note: "GN 4", lapsed: "GSP authorization lapsed on 31 December 2020 and has not been renewed." },
  AU: { code: "AU", name: "United States–Australia Free Trade Agreement", note: "GN 28" },
  B: { code: "B", name: "Automotive Products Trade Act", note: "GN 5" },
  BH: { code: "BH", name: "United States–Bahrain Free Trade Agreement", note: "GN 30" },
  C: { code: "C", name: "Agreement on Trade in Civil Aircraft", note: "GN 6" },
  CA: { code: "CA", name: "NAFTA — Canada (superseded by USMCA)", lapsed: "NAFTA was replaced by the USMCA on 1 July 2020. Canadian goods claim USMCA under code S." },
  CL: { code: "CL", name: "United States–Chile Free Trade Agreement", note: "GN 26" },
  CO: { code: "CO", name: "United States–Colombia Trade Promotion Agreement", note: "GN 34" },
  D: { code: "D", name: "African Growth and Opportunity Act", note: "GN 16" },
  E: { code: "E", name: "Caribbean Basin Economic Recovery Act", note: "GN 7" },
  "E*": { code: "E*", name: "CBERA, with country exclusions on this line", note: "GN 7" },
  IL: { code: "IL", name: "United States–Israel Free Trade Area", note: "GN 8" },
  J: { code: "J", name: "Andean Trade Preference Act", lapsed: "ATPA expired on 31 July 2013." },
  "J*": { code: "J*", name: "ATPA, with exclusions", lapsed: "ATPA expired on 31 July 2013." },
  JO: { code: "JO", name: "United States–Jordan Free Trade Agreement", note: "GN 18" },
  JP: { code: "JP", name: "United States–Japan Trade Agreement", note: "GN 36" },
  K: { code: "K", name: "Agreement on Trade in Pharmaceutical Products", note: "GN 13" },
  KR: { code: "KR", name: "United States–Korea Free Trade Agreement", note: "GN 33" },
  L: { code: "L", name: "Uruguay Round concessions on intermediate chemicals for dyes", note: "GN 14" },
  MA: { code: "MA", name: "United States–Morocco Free Trade Agreement", note: "GN 27" },
  MX: { code: "MX", name: "NAFTA — Mexico (superseded by USMCA)", lapsed: "NAFTA was replaced by the USMCA on 1 July 2020. Mexican goods claim USMCA under code S." },
  NP: { code: "NP", name: "Nepal Preference Program", note: "GN 35" },
  OM: { code: "OM", name: "United States–Oman Free Trade Agreement", note: "GN 31" },
  P: { code: "P", name: "Dominican Republic–Central America FTA", note: "GN 29" },
  "P+": { code: "P+", name: "CAFTA-DR, additional eligibility set", note: "GN 29" },
  PA: { code: "PA", name: "United States–Panama Trade Promotion Agreement", note: "GN 35" },
  PE: { code: "PE", name: "United States–Peru Trade Promotion Agreement", note: "GN 32" },
  R: { code: "R", name: "Caribbean Basin Trade Partnership Act", note: "GN 17" },
  S: { code: "S", name: "United States–Mexico–Canada Agreement", note: "GN 11" },
  "S+": { code: "S+", name: "USMCA, additional eligibility set", note: "GN 11" },
  SG: { code: "SG", name: "United States–Singapore Free Trade Agreement", note: "GN 25" },
};

export interface Country {
  /** ISO 3166-1 alpha-2. */
  iso: string;
  name: string;
  /** Special-column codes this country can claim. */
  programs: string[];
  /** True when the country does not have normal trade relations — Column 2. */
  column2?: boolean;
}

/**
 * EU member states, for Chapter 99 notes that scope by the bloc rather than by
 * country ("all countries other than ... the member nations of the European
 * Union").
 */
export const EU_MEMBERS = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/**
 * The country table is generated at build time into `public/data/countries.json`
 * and loaded at runtime — every ISO country, with preference-programme
 * membership read from the General Notes where they publish a roster and stated
 * in `scripts/parse-notes.ts` where they do not. It is not a constant here
 * because membership changes by proclamation, not on the HTS revision cycle.
 */

/** Program codes on a line that the given country can actually claim. */
export function claimableCodes(country: Country, codesOnLine: string[]): string[] {
  return codesOnLine.filter((code) => country.programs.includes(code));
}
