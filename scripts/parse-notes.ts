/**
 * Preference-programme membership from the HTS General Notes.
 *
 * The REST API publishes the schedule but not the General Notes, which are what
 * define who may claim each Special-column code. Those notes are PDFs on the
 * same release endpoint, so membership for the multi-country programmes is read
 * from them here rather than maintained by hand.
 *
 * Single-country agreements (Australia, Korea, Singapore and the rest) are not
 * parsed: the code *is* the country, and a curated constant is both shorter and
 * more reliable than reading a paragraph to rediscover that KR means Korea. The
 * notes are used only where membership is a list that changes — AGOA, CBERA,
 * CBTPA, CAFTA-DR, USMCA and GSP.
 *
 * Names in the notes are formal and inconsistent with ISO ("Republic of
 * Angola", "Gambia, The", "Côte d'Ivoire"), and they are printed in two or
 * three columns with long names wrapped across lines. Anything that cannot be
 * resolved to an ISO code is reported rather than dropped silently, and the
 * curated table underneath means a parse failure narrows coverage instead of
 * losing a country.
 */
import { fetchDocumentText } from "./parse-ch99.ts";

/** Programmes whose membership is a list worth parsing, and their note. */
export const LIST_PROGRAMS: Record<string, { note: string; codes: string[] }> = {
  GSP: { note: "General Note 4", codes: ["A", "A*", "A+"] },
  CBERA: { note: "General Note 7", codes: ["E", "E*"] },
  AGOA: { note: "General Note 16", codes: ["D"] },
};

/**
 * Membership that is not parsed, because the note does not contain a list.
 *
 * General Notes 11, 17 and 29 are rules-of-origin text, not rosters — parsing
 * them returned nothing usable for USMCA and one bogus hit for CAFTA-DR. These
 * memberships are short, stable and legislated, so they are stated here. Single-
 * country agreements are here for the same reason: the code is the country, and
 * reading a paragraph to rediscover that KR means Korea would be worse.
 */
export const CURATED: Record<string, string[]> = {
  AU: ["AU"], BH: ["BH"], CL: ["CL"], CO: ["CO"], IL: ["IL"], JO: ["JO"],
  JP: ["JP"], KR: ["KR"], MA: ["MA"], OM: ["OM"], PA: ["PA"], PE: ["PE"],
  SG: ["SG"],
  // USMCA (GN 11) and its additional eligibility set.
  S: ["CA", "MX"], "S+": ["CA", "MX"],
  // Legacy NAFTA codes, retained because they still appear in the schedule.
  CA: ["CA"], MX: ["MX"],
  // CAFTA-DR (GN 29).
  P: ["CR", "DO", "SV", "GT", "HN", "NI"], "P+": ["CR", "DO", "SV", "GT", "HN", "NI"],
  // CBTPA (GN 17) — the CBERA beneficiaries separately designated for it.
  R: ["BB", "BZ", "GY", "HT", "JM", "TT"],
  // Nepal Preference Program (GN 35).
  NP: ["NP"],
};

/** Countries without normal trade relations; Column 2 applies (GN 3(b)). */
export const COLUMN_2: string[] = ["CU", "KP", "RU", "BY"];

/**
 * Programmes open to any origin, since eligibility turns on the goods rather
 * than the country: civil aircraft, pharmaceuticals, and dye intermediates.
 */
export const GOODS_BASED: string[] = ["C", "K", "L", "B"];

/** Formal or variant names in the notes that ISO spells differently. */
const ALIASES: Record<string, string> = {
  "gambia the": "GM",
  "bahamas the": "BS",
  // ICU names these "Congo - Brazzaville" and "Congo - Kinshasa", which no
  // note uses, and the two are one prefix apart — they must be pinned.
  "congo": "CG",
  "republic of congo": "CG",
  "congo brazzaville": "CG",
  "democratic republic of the congo": "CD",
  "congo kinshasa": "CD",
  "drc": "CD",
  "cote divoire": "CI",
  "ivory coast": "CI",
  "cabo verde": "CV",
  "cape verde": "CV",
  "east timor": "TL",
  "timor leste": "TL",
  "burma": "MM",
  "myanmar burma": "MM",
  "republic of yemen": "YE",
  "swaziland": "SZ",
  "eswatini": "SZ",
  "macedonia": "MK",
  "north macedonia": "MK",
  "russia": "RU",
  "russian federation": "RU",
  "south korea": "KR",
  "north korea": "KP",
  "korea republic of": "KR",
  "tanzania": "TZ",
  "united republic of tanzania": "TZ",
  "bolivia": "BO",
  "venezuela": "VE",
  "moldova": "MD",
  "laos": "LA",
  "lao peoples democratic republic": "LA",
  "syria": "SY",
  "vietnam": "VN",
  "viet nam": "VN",
  "brunei": "BN",
  "czech republic": "CZ",
  "czechia": "CZ",
  "turkiye": "TR",
  "turkey": "TR",
  "sao tome and principe": "ST",
  "st lucia": "LC",
  "st vincent and the grenadines": "VC",
  "st kitts and nevis": "KN",
};

/**
 * Light normalization: case, accents, punctuation and abbreviation only.
 *
 * Used for the first lookup pass, and deliberately does not strip formal
 * prefixes. "Democratic Republic of the Congo" and "Republic of Congo" are
 * different countries, and a normalizer aggressive enough to match "Republic of
 * Angola" to "Angola" collapses those two onto one code.
 */
function lightName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/&/g, " ")
    .replace(/[^a-z ]/g, " ")
    .replace(/\b(and|the|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Aggressive normalization: also strips the formal prefixes the notes use
 * ("Republic of", "Federal Republic of", "Union of the"). Only consulted when
 * the light pass finds nothing, so it cannot override a precise match.
 */
function normalizeName(raw: string): string {
  return lightName(raw)
    .replace(
      /^(federal |democratic |islamic |united |great |independent |plurinational |bolivarian |socialist |oriental |cooperative |co operative |union |kingdom |republic |state |states |principality |sultanate |commonwealth )+/g,
      "",
    )
    .replace(/\brepublic\b|\bkingdom\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ISO alpha-2 codes, used to build the name index and the country list. */
export const ISO_CODES: string[] = "AD AE AF AG AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VC VE VN VU WS YE ZA ZM ZW".split(" ");

const display = new Intl.DisplayNames(["en"], { type: "region" });

/** Human name for an ISO code. */
export function isoName(code: string): string {
  try {
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Precise index: exact names and hand-written aliases. */
const EXACT_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const code of ISO_CODES) index.set(lightName(isoName(code)), code);
  for (const [name, code] of Object.entries(ALIASES)) index.set(lightName(name), code);
  return index;
})();

/** Loose index: prefix-stripped ISO names, for the notes' formal style. */
const LOOSE_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const code of ISO_CODES) {
    const key = normalizeName(isoName(code));
    // First writer wins, so an ambiguous stripped form cannot steal a code.
    if (!index.has(key)) index.set(key, code);
  }
  return index;
})();

export function resolveCountry(name: string): string | undefined {
  return EXACT_INDEX.get(lightName(name)) ?? LOOSE_INDEX.get(normalizeName(name));
}

/**
 * Pull country names out of a General Note.
 *
 * The lists are printed in two or three columns, so each line is split on runs
 * of whitespace and every cell tried independently. Long names wrap, so a cell
 * that does not resolve is retried joined to the cell below it in the same
 * column before being given up on.
 */
export function parseCountryList(text: string): { found: Set<string>; unresolved: string[] } {
  const found = new Set<string>();
  const unresolved: string[] = [];
  const lines = text
    .split("\n")
    .filter((l) => !/Harmonized Tariff Schedule|Annotated for Statistical|^\s*GN\s|^\s*\d+\s*$/.test(l));

  const cellsOf = (line: string): string[] =>
    line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => /^[A-Za-zÀ-ÿ' ,.\-]{3,60}$/.test(c));

  for (let i = 0; i < lines.length; i++) {
    const cells = cellsOf(lines[i]!);
    const next = i + 1 < lines.length ? cellsOf(lines[i + 1]!) : [];
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]!;
      const iso = resolveCountry(cell);
      if (iso) {
        found.add(iso);
        continue;
      }
      // A wrapped name: "Saint Vincent and the" / "Grenadines".
      const joined = next[c] ? `${cell} ${next[c]}` : undefined;
      const wrapped = joined ? resolveCountry(joined) : undefined;
      if (wrapped) found.add(wrapped);
      else if (cell.length > 3) unresolved.push(cell);
    }
  }
  return { found, unresolved };
}

/** Fetch and parse every list programme's membership. */
export async function fetchProgramMembership(
  release: string,
): Promise<{ membership: Map<string, Set<string>>; report: { program: string; found: number; unresolved: number }[] }> {
  const membership = new Map<string, Set<string>>();
  const report: { program: string; found: number; unresolved: number }[] = [];

  for (const [program, { note, codes }] of Object.entries(LIST_PROGRAMS)) {
    try {
      const text = await fetchDocumentText(release, note);
      const { found, unresolved } = parseCountryList(text);
      for (const code of codes) membership.set(code, found);
      report.push({ program, found: found.size, unresolved: unresolved.length });
    } catch {
      report.push({ program, found: 0, unresolved: 0 });
    }
  }
  return { membership, report };
}
