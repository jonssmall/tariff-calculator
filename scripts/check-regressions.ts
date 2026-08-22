/**
 * Regression cases for the duty calculation.
 *
 * Every case here was added because it caught a real defect: rates inherited
 * from the wrong level, a UK-only heading applied worldwide, an apparel table
 * attributed to an industrial-goods heading, Section 301 headings treated as
 * blanket and stacking to 618%. They are cheap to run and they are what stands
 * between a parser change and a silently wrong number.
 *
 * Run with `npm run check` after `npm run data`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { calculate } from "../src/lib/calc.ts";
import { matchRemedies, type RemedyData } from "../src/lib/remedies.ts";
import type { Country } from "../src/lib/programs.ts";
import type { Entry } from "../src/lib/hts.ts";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");

interface Case {
  code: string;
  iso: string;
  /** Effective rate as a percentage of customs value, to two decimals. */
  expect: number;
  why: string;
}

const CASES: Case[] = [
  { code: "9403.60.80.93", iso: "CN", expect: 50.47, why: "Section 232 cabinets + Section 301 List 3" },
  { code: "9403.60.80.93", iso: "VN", expect: 25.47, why: "Section 232 only; no Section 301" },
  // Note 37(e) excludes the EU from 9903.76.03, but 37(j) covers it under
  // 9903.76.22 at a flat 15%. This case expected 0.47% while that heading's
  // bare "15%" rate went unparsed and the provision was silently dropped.
  { code: "9403.60.80.93", iso: "DE", expect: 15.47, why: "EU wood products under 9903.76.22 at a flat 15%" },
  { code: "6109.10.00.12", iso: "CN", expect: 24.47, why: "16.5% base + Section 301 List 4A at 7.5%" },
  { code: "6109.10.00.12", iso: "KR", expect: 0.47, why: "KORUS preference, Free" },
  { code: "6109.10.00.12", iso: "RU", expect: 90.47, why: "Column 2, non-NTR" },
  { code: "8507.60.00.90", iso: "CN", expect: 28.87, why: "lithium batteries, 2024 Section 301 tranche" },
  { code: "8703.80.00.20", iso: "CN", expect: 102.97, why: "electric vehicles at 100%" },
  { code: "8541.10.00.80", iso: "CN", expect: 50.47, why: "semiconductors at 50%" },
  { code: "8471.30.01.00", iso: "CN", expect: 0.47, why: "laptops: Free and not covered by Section 301" },
];

const remedyData = JSON.parse(readFileSync(join(DATA, "remedies.json"), "utf8")) as RemedyData;
const countries = JSON.parse(readFileSync(join(DATA, "countries.json"), "utf8")) as Country[];
const COUNTRY_BY_ISO = new Map(countries.map((c) => [c.iso, c]));
const entries: Entry[] = readdirSync(join(DATA, "chapter")).flatMap(
  (f) => JSON.parse(readFileSync(join(DATA, "chapter", f), "utf8")) as Entry[],
);

let failed = 0;
for (const c of CASES) {
  const entry = entries.find((e) => e.code === c.code);
  const country = COUNTRY_BY_ISO.get(c.iso);
  if (!entry || !country) {
    process.stdout.write(`FAIL  ${c.code} ${c.iso}: not found in the dataset\n`);
    failed++;
    continue;
  }
  const remedies = matchRemedies(remedyData, c.code, country);
  const result = calculate({
    entry, country, customsValue: 10_000, quantities: {}, mode: "ocean", remedies,
  });
  const actual = Number((((result.effectiveRate ?? 0) * 100)).toFixed(2));
  const ok = Math.abs(actual - c.expect) < 0.01;
  if (!ok) failed++;
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"}  ${c.code.padEnd(15)} ${country.name.padEnd(14)} ` +
      `${String(actual).padStart(7)}%  expected ${String(c.expect).padStart(7)}%  ${c.why}\n`,
  );
}

process.stdout.write(`\n${CASES.length - failed}/${CASES.length} passed\n`);
if (failed > 0) process.exit(1);
