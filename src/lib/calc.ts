/**
 * The duty stack: which rate column applies, what the duty comes to, and the
 * federal fees that ride alongside it.
 *
 * Order matters and follows how an entry summary is actually built:
 *   1. Pick the rate column from the country's trade status.
 *   2. Apply the ad valorem and specific components of that rate.
 *   3. Add the merchandise processing fee, with its floor and cap.
 *   4. Add the harbor maintenance fee, ocean arrivals only.
 *
 * What this does not model is as important as what it does. Antidumping and
 * countervailing duties are producer-specific and frequently exceed the
 * ordinary duty by an order of magnitude; there is no way to derive a deposit
 * rate from the tariff schedule, so the calculator flags the risk and declines
 * to invent a number. Chapter 99 trade-remedy provisions (Sections 201, 232 and
 * 301, and the IEEPA-based actions) are likewise additive to the rates below
 * and are not applied automatically, because whether a given line is covered
 * depends on annexes that are not part of this dataset.
 */
import type { Entry } from "./hts.ts";
import { parseRate, parseSpecial, requiredUnits, unitLabel, unitLabelSingular, type ParsedRate } from "./rates.ts";
import { PROGRAMS, type Country } from "./programs.ts";
import type { RemedyMatch } from "./remedies.ts";

/**
 * CBP user fees, fiscal year 2026 (effective 1 October 2025, CBP Dec. 25-10).
 * CBP adjusts the COBRA fees for inflation every year — re-check these each
 * October rather than assuming they carry forward.
 */
export const FEES = {
  mpfRate: 0.003464,
  mpfMin: 33.58,
  mpfMax: 651.5,
  hmfRate: 0.00125,
  fiscalYear: "FY2026",
} as const;

export type Column = "general" | "special" | "column2";
export type Mode = "ocean" | "air" | "other";

export interface Quantities {
  [unit: string]: number;
}

export interface CalcInput {
  entry: Entry;
  country: Country;
  customsValue: number;
  quantities: Quantities;
  mode: Mode;
  /** Chapter 99 headings that reach these goods and this origin. */
  remedies?: RemedyMatch[];
  /** Which of those the user has applied. Defaults to the confirmed ones. */
  appliedHeadings?: Set<string>;
}

export interface Charge {
  label: string;
  amount: number;
  /** How the number was arrived at. */
  formula: string;
  kind: "duty" | "remedy" | "fee";
}

export interface Notice {
  tone: "info" | "warn" | "credit";
  title: string;
  body: string;
}

export interface CalcResult {
  column: Column;
  columnLabel: string;
  /** The rate that was applied. */
  rate: ParsedRate;
  /** Program code claimed, when the special column was used. */
  claimedCode?: string;
  /** Units the rate needs but the user has not supplied. */
  missingUnits: string[];
  charges: Charge[];
  dutyTotal: number | null;
  feeTotal: number;
  grandTotal: number | null;
  /** Duty and fees as a share of customs value. */
  effectiveRate: number | null;
  notices: Notice[];
  /** The General-column outcome, for comparison when a preference applied. */
  generalDuty: number | null;
  /** Chapter 99 additional duty applied, in dollars. */
  remedyTotal: number;
  /** Combined additive rate of the applied Chapter 99 headings. */
  remedyRate: number;
}

const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (n: number): string => `${(n * 100).toFixed(4).replace(/\.?0+$/, "")}%`;

/**
 * Per-unit duty amounts are written the way the schedule writes them. Rounding
 * 9.9¢/kg to "$0.10 per kilogram" both loses precision and stops matching the
 * published rate the user is checking against.
 */
const unitRate = (usd: number): string =>
  usd < 1 ? `${Number((usd * 100).toFixed(4))}¢` : money(usd);

/** Evaluate a parsed rate against a value and a set of quantities. */
function applyRate(
  rate: ParsedRate,
  customsValue: number,
  quantities: Quantities,
): { charges: Charge[]; total: number | null; missing: string[] } {
  if (rate.free) {
    return {
      charges: [{ label: "Duty", amount: 0, formula: "Free — no duty at this rate", kind: "duty" }],
      total: 0,
      missing: [],
    };
  }
  if (!rate.computable) return { charges: [], total: null, missing: [] };

  const missing = requiredUnits(rate).filter((u) => !(quantities[u]! > 0));
  if (missing.length > 0) return { charges: [], total: null, missing };

  const charges: Charge[] = [];
  let total = 0;
  for (const term of rate.terms) {
    if (term.kind === "advalorem") {
      const amount = customsValue * term.fraction;
      total += amount;
      charges.push({
        label: `Duty — ${pct(term.fraction)} of value`,
        amount,
        formula: `${money(customsValue)} × ${pct(term.fraction)}`,
        kind: "duty",
      });
    } else {
      const qty = quantities[term.per] ?? 0;
      const amount = qty * term.amountUsd;
      total += amount;
      charges.push({
        label: `Duty — ${unitRate(term.amountUsd)} per ${unitLabelSingular(term.per)}`,
        amount,
        formula: `${qty.toLocaleString("en-US")} ${unitLabel(term.per)} × ${unitRate(term.amountUsd)}`,
        kind: "duty",
      });
    }
  }
  return { charges, total, missing: [] };
}

/**
 * Choose the rate column and, where a preference is available, the specific
 * program clause that applies to this origin.
 *
 * A country can appear in several clauses of the Special cell; the schedule
 * gives each clause its own rate, so the best claimable one wins. Clauses whose
 * rate text is a cross-reference ("See 9822.04.01") are quota provisions that
 * cannot be resolved from this data and are surfaced as notices instead.
 */
function selectColumn(entry: Entry, country: Country): {
  column: Column;
  rate: ParsedRate;
  claimedCode?: string;
  notices: Notice[];
} {
  const notices: Notice[] = [];

  if (country.column2) {
    return {
      column: "column2",
      rate: parseRate(entry.other),
      notices: [
        {
          tone: "warn",
          title: `${country.name} is subject to Column 2 rates`,
          body: "Column 2 applies to countries that do not hold normal trade relations status with the United States. These rates are the statutory 1930 Act rates and are typically several times the Column 1 General rate. Confirm that the goods are not also subject to sanctions or an import prohibition, which are separate from the tariff.",
        },
      ],
    };
  }

  const general = parseRate(entry.general);
  const clauses = parseSpecial(entry.special);

  let best: { rate: ParsedRate; code: string } | undefined;
  for (const clause of clauses) {
    const applicable = clause.codes.filter((c) => c === "*" || country.programs.includes(c));
    if (applicable.length === 0) continue;

    const code = applicable[0]!;
    const program = PROGRAMS[code];

    if (/^see\b/i.test(clause.rateText)) {
      notices.push({
        tone: "info",
        title: `${program?.name ?? code}: quota provision`,
        body: `The schedule directs this origin to "${clause.rateText}" rather than stating a rate. That is a tariff-rate quota in Chapter 98 or 99 — the preferential rate applies only within a quantity limit, and over-quota entries pay the rate shown above. Check the quota status before relying on the preferential figure.`,
      });
      continue;
    }

    if (program?.lapsed) {
      notices.push({
        tone: "warn",
        title: `${program.name} is not currently in force`,
        body: program.lapsed,
      });
      continue;
    }

    const parsed = parseRate(clause.rateText);
    if (!parsed.computable && !parsed.free) continue;

    // Prefer the lowest available preferential rate.
    if (!best) best = { rate: parsed, code };
    else if (parsed.free && !best.rate.free) best = { rate: parsed, code };
  }

  if (best) {
    const program = PROGRAMS[best.code];
    notices.push({
      tone: "credit",
      title: `Preference applied: ${program?.name ?? best.code}`,
      body: `${country.name} is eligible under Special-column code ${best.code}${program?.note ? ` (${program.note})` : ""}. The preference is a claim, not an entitlement — it requires that the goods meet the agreement's rules of origin and that the importer hold the certification the agreement specifies. Without that support the General rate applies.${best.code.endsWith("*") ? " The asterisk on this code means specific countries are excluded from the preference on this line; verify that this origin is not one of them." : ""}`,
    });
    return { column: "special", rate: best.rate, claimedCode: best.code, notices };
  }

  return { column: "general", rate: general, notices };
}

export function calculate(input: CalcInput): CalcResult {
  const { entry, country, customsValue, quantities, mode, remedies = [] } = input;
  const applied =
    input.appliedHeadings ??
    new Set(remedies.filter((m) => m.confidence === "confirmed").map((m) => m.remedy.heading));
  const selected = selectColumn(entry, country);
  const notices = [...selected.notices];

  const appliedRate = applyRate(selected.rate, customsValue, quantities);
  const charges = [...appliedRate.charges];

  /*
   * Chapter 99 additional duties.
   *
   * These are separate headings declared alongside the ordinary classification,
   * and their rate text reads "The duty provided in the applicable subheading
   * + 25%" — the uplift is ad valorem on customs value and additive with both
   * the ordinary duty and each other. Section 301 and Section 232 stack: goods
   * can carry both, which is how a Free-rated line ends up at 50%.
   */
  let remedyTotal = 0;
  let remedyRate = 0;
  for (const match of remedies) {
    if (!applied.has(match.remedy.heading)) continue;
    const amount = customsValue * match.remedy.uplift;
    remedyTotal += amount;
    remedyRate += match.remedy.uplift;
    charges.push({
      label: `${match.remedy.heading} — ${match.remedy.uplift === 0 ? "no additional duty" : `+${pct(match.remedy.uplift)}`}`,
      amount,
      formula:
        match.remedy.uplift === 0
          ? "Heading applies but imposes no additional duty"
          : `${money(customsValue)} × ${pct(match.remedy.uplift)}`,
      kind: "remedy",
    });
  }

  // Merchandise processing fee — ad valorem with a floor and a cap, charged on
  // formal entries regardless of the duty outcome. Free-rate goods still pay it.
  const rawMpf = customsValue * FEES.mpfRate;
  const mpf = Math.min(Math.max(rawMpf, FEES.mpfMin), FEES.mpfMax);
  const mpfFormula =
    rawMpf < FEES.mpfMin
      ? `${money(customsValue)} × ${pct(FEES.mpfRate)} = ${money(rawMpf)}, raised to the ${money(FEES.mpfMin)} minimum`
      : rawMpf > FEES.mpfMax
        ? `${money(customsValue)} × ${pct(FEES.mpfRate)} = ${money(rawMpf)}, capped at ${money(FEES.mpfMax)}`
        : `${money(customsValue)} × ${pct(FEES.mpfRate)}`;
  charges.push({
    label: `Merchandise processing fee (${FEES.fiscalYear})`,
    amount: mpf,
    formula: mpfFormula,
    kind: "fee",
  });

  let hmf = 0;
  if (mode === "ocean") {
    hmf = customsValue * FEES.hmfRate;
    charges.push({
      label: "Harbor maintenance fee",
      amount: hmf,
      formula: `${money(customsValue)} × ${pct(FEES.hmfRate)} — ocean arrivals only`,
      kind: "fee",
    });
  }

  const feeTotal = mpf + hmf;
  // A non-computable ordinary rate does not prevent the Chapter 99 uplift from
  // being known, but the two cannot be summed, so the total stays null.
  const dutyTotal = appliedRate.total === null ? null : appliedRate.total + remedyTotal;
  const grandTotal = dutyTotal === null ? null : dutyTotal + feeTotal;

  if (!selected.rate.computable && !selected.rate.free) {
    notices.push({
      tone: "warn",
      title: "This rate is not calculated",
      body: `${selected.rate.note ?? "The rate could not be interpreted."} The published text is "${selected.rate.text}". Fees below are still shown because they do not depend on the duty rate.`,
    });
  }
  if (appliedRate.missing.length > 0) {
    notices.push({
      tone: "info",
      title: "Quantity needed",
      body: `This line carries a specific duty, so the duty depends on quantity as well as value. Enter ${appliedRate.missing.map(unitLabel).join(" and ")} to complete the calculation.`,
    });
  }
  if (entry.rateFrom) {
    notices.push({
      tone: "info",
      title: `Rate inherited from ${entry.rateFrom}`,
      body: `Duty rates are set at the 8-digit subheading. ${entry.code} is a 10-digit statistical breakout of ${entry.rateFrom} and carries that subheading's rates; its own purpose is trade-statistics reporting.`,
    });
  }
  if (entry.additional) {
    notices.push({
      tone: "warn",
      title: "Additional duties noted on this line",
      body: entry.additional,
    });
  }

  const unresolved = remedies.filter((m) => m.confidence === "possible");
  if (unresolved.length > 0) {
    notices.push({
      tone: "warn",
      title: `${unresolved.length} additional-duty heading${unresolved.length === 1 ? "" : "s"} could not be confirmed`,
      body: `These goods appear in the coverage list for ${unresolved.map((m) => m.remedy.heading).join(", ")}, but the notes state the country scope in prose this tool could not read. They are listed above, switched off. Read the heading before deciding.`,
    });
  }

  if (remedies.length === 0) {
    notices.push({
      tone: "warn",
      title: "No additional duties matched — this is not proof there are none",
      body: "Nothing in the Chapter 99 coverage lists this tool could read reaches this classification and origin. Those lists are mined from the U.S. Notes, which state coverage in prose, and the extraction is incomplete: many headings' coverage could not be attributed automatically. Section 301, Section 232 and IEEPA duties frequently apply to lines that show nothing here. Check the Chapter 99 headings directly before relying on this.",
    });
  }

  notices.push({
    tone: "warn",
    title: "AD/CVD is not included, and Chapter 99 coverage is partial",
    body: "Antidumping and countervailing duty deposits are set per producer, frequently exceed the ordinary duty many times over, and cannot be derived from the tariff schedule — check the ITA's orders for the specific goods and producer. The Chapter 99 additional duties shown here are read from the U.S. Notes, which state coverage as lists and scope as prose; lists parse reliably, scope does not always. Treat the headings above as a starting point for verification, not a filing.",
  });

  const generalApplied = applyRate(parseRate(entry.general), customsValue, quantities);

  return {
    column: selected.column,
    columnLabel:
      selected.column === "column2"
        ? "Column 2 (non-NTR)"
        : selected.column === "special"
          ? "Column 1 Special"
          : "Column 1 General",
    rate: selected.rate,
    ...(selected.claimedCode ? { claimedCode: selected.claimedCode } : {}),
    missingUnits: appliedRate.missing,
    charges,
    dutyTotal,
    feeTotal,
    grandTotal,
    effectiveRate: grandTotal === null || customsValue <= 0 ? null : grandTotal / customsValue,
    notices,
    generalDuty: generalApplied.total,
    remedyTotal,
    remedyRate,
  };
}
