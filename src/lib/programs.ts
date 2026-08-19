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
 * Origins the calculator offers.
 *
 * Covers every free-trade-agreement partner, the four Column 2 countries, and
 * the largest sources of US imports. A country absent from this list is not
 * necessarily without preferences — it simply is not enumerated here, and the
 * calculator says so rather than implying Column 1 General is the final answer.
 */
export const COUNTRIES: Country[] = [
  { iso: "AU", name: "Australia", programs: ["AU", "C", "K", "L"] },
  { iso: "BH", name: "Bahrain", programs: ["BH", "K", "L"] },
  { iso: "BD", name: "Bangladesh", programs: [] },
  { iso: "BY", name: "Belarus", programs: [], column2: true },
  { iso: "BR", name: "Brazil", programs: ["C", "K", "L"] },
  { iso: "KH", name: "Cambodia", programs: [] },
  { iso: "CA", name: "Canada", programs: ["S", "S+", "B", "C", "K", "L"] },
  { iso: "CL", name: "Chile", programs: ["CL", "C", "K", "L"] },
  { iso: "CN", name: "China", programs: ["K", "L"] },
  { iso: "CO", name: "Colombia", programs: ["CO", "C", "K", "L"] },
  { iso: "CR", name: "Costa Rica", programs: ["P", "P+", "C", "K", "L"] },
  { iso: "CU", name: "Cuba", programs: [], column2: true },
  { iso: "DO", name: "Dominican Republic", programs: ["P", "P+", "C", "K", "L"] },
  { iso: "EC", name: "Ecuador", programs: ["K", "L"] },
  { iso: "EG", name: "Egypt", programs: ["K", "L"] },
  { iso: "SV", name: "El Salvador", programs: ["P", "P+", "C", "K", "L"] },
  { iso: "ET", name: "Ethiopia", programs: ["D", "K", "L"] },
  { iso: "FR", name: "France", programs: ["C", "K", "L"] },
  { iso: "DE", name: "Germany", programs: ["C", "K", "L"] },
  { iso: "GT", name: "Guatemala", programs: ["P", "P+", "C", "K", "L"] },
  { iso: "HT", name: "Haiti", programs: ["E", "R", "K", "L"] },
  { iso: "HN", name: "Honduras", programs: ["P", "P+", "C", "K", "L"] },
  { iso: "HK", name: "Hong Kong", programs: ["K", "L"] },
  { iso: "IN", name: "India", programs: ["K", "L"] },
  { iso: "ID", name: "Indonesia", programs: ["K", "L"] },
  { iso: "IE", name: "Ireland", programs: ["C", "K", "L"] },
  { iso: "IL", name: "Israel", programs: ["IL", "C", "K", "L"] },
  { iso: "IT", name: "Italy", programs: ["C", "K", "L"] },
  { iso: "JM", name: "Jamaica", programs: ["E", "R", "K", "L"] },
  { iso: "JP", name: "Japan", programs: ["JP", "C", "K", "L"] },
  { iso: "JO", name: "Jordan", programs: ["JO", "K", "L"] },
  { iso: "KE", name: "Kenya", programs: ["D", "K", "L"] },
  { iso: "KR", name: "Korea, South", programs: ["KR", "C", "K", "L"] },
  { iso: "MY", name: "Malaysia", programs: ["K", "L"] },
  { iso: "MX", name: "Mexico", programs: ["S", "S+", "B", "C", "K", "L"] },
  { iso: "MA", name: "Morocco", programs: ["MA", "K", "L"] },
  { iso: "NP", name: "Nepal", programs: ["NP", "K", "L"] },
  { iso: "NL", name: "Netherlands", programs: ["C", "K", "L"] },
  { iso: "NI", name: "Nicaragua", programs: ["P", "P+", "C", "K", "L"] },
  { iso: "NG", name: "Nigeria", programs: ["D", "K", "L"] },
  { iso: "KP", name: "Korea, North", programs: [], column2: true },
  { iso: "OM", name: "Oman", programs: ["OM", "K", "L"] },
  { iso: "PK", name: "Pakistan", programs: ["K", "L"] },
  { iso: "PA", name: "Panama", programs: ["PA", "C", "K", "L"] },
  { iso: "PE", name: "Peru", programs: ["PE", "C", "K", "L"] },
  { iso: "PH", name: "Philippines", programs: ["K", "L"] },
  { iso: "RU", name: "Russia", programs: [], column2: true },
  { iso: "SA", name: "Saudi Arabia", programs: ["K", "L"] },
  { iso: "SG", name: "Singapore", programs: ["SG", "C", "K", "L"] },
  { iso: "ZA", name: "South Africa", programs: ["D", "C", "K", "L"] },
  { iso: "ES", name: "Spain", programs: ["C", "K", "L"] },
  { iso: "LK", name: "Sri Lanka", programs: ["K", "L"] },
  { iso: "CH", name: "Switzerland", programs: ["C", "K", "L"] },
  { iso: "TW", name: "Taiwan", programs: ["K", "L"] },
  { iso: "TH", name: "Thailand", programs: ["K", "L"] },
  { iso: "TR", name: "Turkey", programs: ["K", "L"] },
  { iso: "AE", name: "United Arab Emirates", programs: ["K", "L"] },
  { iso: "GB", name: "United Kingdom", programs: ["C", "K", "L"] },
  { iso: "VN", name: "Vietnam", programs: ["K", "L"] },
];

export const COUNTRY_BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c]));

/** Program codes on a line that the given country can actually claim. */
export function claimableCodes(country: Country, codesOnLine: string[]): string[] {
  return codesOnLine.filter((code) => country.programs.includes(code));
}
