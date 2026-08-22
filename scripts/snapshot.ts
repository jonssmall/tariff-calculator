/**
 * Structural snapshot of the duty calculation.
 *
 * `check-regressions.ts` holds cases whose correct answer is known from an
 * outside source. This is the other half: it does not know what is right, it
 * knows what the app said last time. Every silent defect so far — rates zeroed
 * by a programme granted too widely, an apparel table attributed to the wrong
 * heading, Section 301 headings stacking to 618% — changed numbers without
 * changing anything visible. A committed snapshot turns that into a diff.
 *
 * Cases are chosen by structure, not at random, so every distinct path through
 * the calculation is represented: a list remedy, a blanket remedy, both at once,
 * an exemption, Column 2, a claimed preference, compound and specific duties, a
 * rate that cannot be computed, an inherited rate, and a line with no remedy at
 * all. Selection is deterministic, so a diff means behaviour moved rather than
 * the sample.
 *
 *   npm run snapshot            compare against tests/snapshot.json
 *   npm run snapshot -- --update  rewrite it after an intended change
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { calculate } from "../src/lib/calc.ts";
import { matchRemedies, type RemedyData } from "../src/lib/remedies.ts";
import { parseRate } from "../src/lib/rates.ts";
import type { Country } from "../src/lib/programs.ts";
import type { Entry } from "../src/lib/hts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const SNAPSHOT = join(ROOT, "tests", "snapshot.json");

const remedyData = JSON.parse(readFileSync(join(DATA, "remedies.json"), "utf8")) as RemedyData;
const countries = JSON.parse(readFileSync(join(DATA, "countries.json"), "utf8")) as Country[];
const byIso = new Map(countries.map((c) => [c.iso, c]));
const entries: Entry[] = readdirSync(join(DATA, "chapter"))
  .sort()
  .flatMap((f) => JSON.parse(readFileSync(join(DATA, "chapter", f), "utf8")) as Entry[]);

/** Origins chosen to exercise different treatment, not for importance. */
const ORIGINS = ["CN", "CA", "MX", "DE", "VN", "RU", "KR", "BR", "IN"];

interface Sample {
  id: string;
  code: string;
  iso: string;
  category: string;
}

/** How many examples to keep per structural category. */
const PER_CATEGORY = 4;

function pick(): Sample[] {
  const chosen: Sample[] = [];
  const counts = new Map<string, number>();

  /*
   * At most one example per category per chapter.
   *
   * Without this the whole sample came from chapter 01, because the scan runs
   * in code order and stops once the categories fill. A snapshot drawn entirely
   * from live animals would not have noticed the apparel or vehicle defects.
   */
  const seen = new Set<string>();
  const take = (category: string, code: string, iso: string): void => {
    const n = counts.get(category) ?? 0;
    if (n >= PER_CATEGORY) return;
    const chapter = code.slice(0, 2);
    if (seen.has(`${category}/${chapter}`)) return;
    seen.add(`${category}/${chapter}`);
    counts.set(category, n + 1);
    chosen.push({ id: `${category}/${code}/${iso}`, code, iso, category });
  };

  // Deterministic order so the sample only moves when the data does.
  const sorted = [...entries].sort((a, b) => a.code.localeCompare(b.code));

  for (const entry of sorted) {
    if (!entry.leaf) continue;
    const rate = parseRate(entry.general);

    for (const iso of ORIGINS) {
      const country = byIso.get(iso);
      if (!country) continue;
      const matches = matchRemedies(remedyData, entry.code, country);
      const confirmed = matches.filter((m) => m.confidence === "confirmed");
      const blanket = matches.filter((m) => m.remedy.kind === "blanket");
      const exempt = matches.filter((m) => m.exemptions.length > 0);

      if (country.column2) take("column-2", entry.code, iso);
      else if (confirmed.length > 0 && blanket.length > 0) take("list-and-blanket", entry.code, iso);
      else if (confirmed.length > 1) take("stacked-list", entry.code, iso);
      else if (confirmed.length === 1) take("single-list", entry.code, iso);
      else if (exempt.length > 0) take("exemption-available", entry.code, iso);
      else if (blanket.length > 0) take("blanket-only", entry.code, iso);
      else if (matches.length === 0 && rate.free) take("free-no-remedy", entry.code, iso);

      if (!rate.computable && !rate.free) take("uncomputable-rate", entry.code, iso);
      else if (rate.terms.some((t) => t.kind === "specific") && rate.terms.length > 1)
        take("compound-duty", entry.code, iso);
      else if (rate.terms.some((t) => t.kind === "specific")) take("specific-duty", entry.code, iso);
      if (entry.rateFrom) take("inherited-rate", entry.code, iso);
      if (entry.special.includes("Free (") && !country.column2) take("preference-possible", entry.code, iso);
    }
    // Stop once every category is full.
    if ([...counts.values()].every((n) => n >= PER_CATEGORY) && counts.size >= 11) break;
  }
  return chosen.sort((a, b) => a.id.localeCompare(b.id));
}

interface Row {
  id: string;
  column: string;
  rate: string;
  duty: number | null;
  remedyRate: number;
  fees: number;
  total: number | null;
  effective: number | null;
  confirmed: number;
  possible: number;
  headings: string;
}

function run(samples: Sample[]): Row[] {
  return samples.map((s) => {
    const entry = entries.find((e) => e.code === s.code)!;
    const country = byIso.get(s.iso)!;
    const remedies = matchRemedies(remedyData, s.code, country);
    // A fixed quantity so specific duties produce a number rather than a gap.
    const quantities: Record<string, number> = {};
    for (const m of [parseRate(entry.general), parseRate(entry.other)]) {
      for (const t of m.terms) if (t.kind === "specific") quantities[t.per] = 1000;
    }
    const r = calculate({
      entry, country, customsValue: 10_000, quantities, mode: "ocean", remedies,
    });
    const round = (n: number | null): number | null => (n === null ? null : Number(n.toFixed(2)));
    return {
      id: s.id,
      column: r.columnLabel,
      rate: r.rate.text,
      duty: round(r.dutyTotal),
      remedyRate: Number((r.remedyRate * 100).toFixed(2)),
      fees: round(r.feeTotal)!,
      total: round(r.grandTotal),
      effective: r.effectiveRate === null ? null : Number((r.effectiveRate * 100).toFixed(2)),
      confirmed: remedies.filter((m) => m.confidence === "confirmed").length,
      possible: remedies.filter((m) => m.confidence === "possible").length,
      headings: remedies.map((m) => m.remedy.heading).sort().join(" "),
    };
  });
}

const update = process.argv.includes("--update");
const rows = run(pick());

if (update || !existsSync(SNAPSHOT)) {
  writeFileSync(SNAPSHOT, JSON.stringify(rows, null, 2) + "\n");
  process.stdout.write(`wrote ${rows.length} cases to tests/snapshot.json\n`);
  process.exit(0);
}

const previous = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Row[];
const before = new Map(previous.map((r) => [r.id, r]));
const after = new Map(rows.map((r) => [r.id, r]));
const changed: string[] = [];

for (const [id, now] of after) {
  const then = before.get(id);
  if (!then) {
    changed.push(`+ ${id} (new case)`);
    continue;
  }
  for (const key of Object.keys(now) as (keyof Row)[]) {
    if (key === "id") continue;
    if (String(then[key]) !== String(now[key])) {
      changed.push(`~ ${id}\n    ${key}: ${String(then[key])}  ->  ${String(now[key])}`);
    }
  }
}
for (const id of before.keys()) if (!after.has(id)) changed.push(`- ${id} (case no longer produced)`);

process.stdout.write(`${rows.length} cases, ${changed.length} differences\n`);
if (changed.length > 0) {
  process.stdout.write(changed.join("\n") + "\n");
  process.stdout.write(
    "\nIf these changes are intended (a USITC revision, or a deliberate fix), " +
      "re-run with --update and commit the new snapshot.\n",
  );
  process.exit(1);
}
process.stdout.write("no drift\n");
