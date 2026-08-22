/**
 * The duty stack and remedy matching.
 *
 * Synthetic fixtures rather than the real dataset, so these run without
 * `npm run data` and test behaviour rather than today's tariff schedule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculate, FEES } from "../src/lib/calc.ts";
import { matchRemedies, type RemedyData, type Remedy } from "../src/lib/remedies.ts";
import type { Entry } from "../src/lib/hts.ts";
import type { Country } from "../src/lib/programs.ts";

const entry = (over: Partial<Entry> = {}): Entry => ({
  code: "1234.56.78.90",
  desc: "Test goods",
  path: [],
  units: [],
  general: "10%",
  special: "",
  other: "50%",
  leaf: true,
  ...over,
});

const country = (over: Partial<Country> = {}): Country => ({
  iso: "XX",
  name: "Testland",
  programs: [],
  ...over,
});

const remedy = (over: Partial<Remedy> = {}): Remedy => ({
  heading: "9903.00.01",
  uplift: 0.25,
  rateText: "The duty provided in the applicable subheading + 25%",
  description: "Articles the product of Testland",
  noteRefs: [],
  scope: { kind: "country", name: "Testland" },
  exceptHeadings: [],
  kind: "list",
  ...over,
});

const run = (over: Parameters<typeof calculate>[0] extends infer T ? Partial<T> : never = {}) =>
  calculate({
    entry: entry(), country: country(), customsValue: 10_000, quantities: {}, mode: "ocean", ...over,
  });

test("ad valorem duty on the general column", () => {
  const r = run();
  assert.equal(r.column, "general");
  assert.equal(r.dutyTotal, 1000);
});

test("merchandise processing fee floor applies to small shipments", () => {
  const r = run({ customsValue: 500 });
  const mpf = r.charges.find((c) => c.label.includes("Merchandise"))!;
  assert.equal(mpf.amount, FEES.mpfMin);
});

test("merchandise processing fee is capped on large shipments", () => {
  const r = run({ customsValue: 5_000_000 });
  const mpf = r.charges.find((c) => c.label.includes("Merchandise"))!;
  assert.equal(mpf.amount, FEES.mpfMax);
});

test("harbor maintenance fee is ocean only", () => {
  assert.ok(run({ mode: "ocean" }).charges.some((c) => c.label.includes("Harbor")));
  assert.ok(!run({ mode: "air" }).charges.some((c) => c.label.includes("Harbor")));
  assert.ok(!run({ mode: "other" }).charges.some((c) => c.label.includes("Harbor")));
});

test("fees are charged even when the goods are duty free", () => {
  const r = run({ entry: entry({ general: "Free" }) });
  assert.equal(r.dutyTotal, 0);
  assert.ok(r.feeTotal > 0);
});

test("a non-NTR origin gets Column 2", () => {
  const r = run({ country: country({ column2: true }) });
  assert.equal(r.column, "column2");
  assert.equal(r.dutyTotal, 5000);
});

test("a claimable preference beats the general rate", () => {
  const r = run({
    entry: entry({ special: "Free (ZZ)" }),
    country: country({ programs: ["ZZ"] }),
  });
  assert.equal(r.column, "special");
  assert.equal(r.dutyTotal, 0);
  assert.equal(r.claimedCode, "ZZ");
});

test("a preference the origin cannot claim is ignored", () => {
  const r = run({ entry: entry({ special: "Free (ZZ)" }), country: country({ programs: [] }) });
  assert.equal(r.column, "general");
});

test("specific duties wait for a quantity rather than assuming zero", () => {
  const withoutQty = run({ entry: entry({ general: "5¢/kg" }) });
  assert.equal(withoutQty.dutyTotal, null);
  assert.deepEqual(withoutQty.missingUnits, ["kg"]);

  const withQty = run({ entry: entry({ general: "5¢/kg" }), quantities: { kg: 1000 } });
  assert.equal(withQty.dutyTotal, 50);
});

test("an uncomputable rate still reports fees, with no duty total", () => {
  const r = run({ entry: entry({ general: "The rate applicable to each garment in the ensemble" }) });
  assert.equal(r.dutyTotal, null);
  assert.ok(r.feeTotal > 0);
  assert.ok(r.notices.some((n) => n.title.includes("not calculated")));
});

test("Chapter 99 uplifts stack additively on the base duty", () => {
  const matches = [
    { remedy: remedy({ heading: "9903.00.01", uplift: 0.25 }), confidence: "confirmed" as const, reason: "", matchedOn: "x", exemptions: [] },
    { remedy: remedy({ heading: "9903.00.02", uplift: 0.5 }), confidence: "confirmed" as const, reason: "", matchedOn: "x", exemptions: [] },
  ];
  const r = run({ remedies: matches });
  assert.equal(r.remedyRate, 0.75);
  assert.equal(r.dutyTotal, 1000 + 7500);
});

test("a claimed exemption waives the duty entirely", () => {
  const waiver = remedy({ heading: "9903.00.99", uplift: 0, description: "Goods under General Note 11" });
  const match = {
    remedy: remedy({ uplift: 0.35, exceptHeadings: ["9903.00.99"] }),
    confidence: "confirmed" as const, reason: "", matchedOn: "origin", exemptions: [waiver],
  };
  const applied = run({ remedies: [match], appliedHeadings: new Set(["9903.00.01", "9903.00.99"]) });
  assert.equal(applied.remedyTotal, 0);

  const notClaimed = run({ remedies: [match], appliedHeadings: new Set(["9903.00.01"]) });
  assert.equal(notClaimed.remedyTotal, 3500);
});

/*
 * Carve-outs do not all mean "free".
 *
 * The 35% on Canadian goods excepts crude oil and potash to 10%. Treating every
 * carve-out as an exemption hid 103 reduced-rate provisions and would understate
 * those entries by ten points.
 */
test("a reduced-rate carve-out substitutes its rate instead of waiving", () => {
  const reduced = remedy({ heading: "9903.01.13", uplift: 0.1, description: "Crude oil" });
  const match = {
    remedy: remedy({ heading: "9903.01.10", uplift: 0.35, exceptHeadings: ["9903.01.13"] }),
    confidence: "confirmed" as const, reason: "", matchedOn: "origin", exemptions: [reduced],
  };
  const claimed = run({ remedies: [match], appliedHeadings: new Set(["9903.01.10", "9903.01.13"]) });
  assert.equal(claimed.remedyTotal, 1000, "10% of 10,000, not 0 and not 3,500");
  assert.equal(claimed.remedyRate, 0.1);

  const unclaimed = run({ remedies: [match], appliedHeadings: new Set(["9903.01.10"]) });
  assert.equal(unclaimed.remedyTotal, 3500);
});

test("the cheapest claimed carve-out wins", () => {
  const free = remedy({ heading: "9903.01.14", uplift: 0, description: "USMCA" });
  const reduced = remedy({ heading: "9903.01.13", uplift: 0.1, description: "Crude oil" });
  const match = {
    remedy: remedy({ heading: "9903.01.10", uplift: 0.35, exceptHeadings: ["9903.01.13", "9903.01.14"] }),
    confidence: "confirmed" as const, reason: "", matchedOn: "origin", exemptions: [reduced, free],
  };
  const r = run({ remedies: [match], appliedHeadings: new Set(["9903.01.10", "9903.01.13", "9903.01.14"]) });
  assert.equal(r.remedyTotal, 0, "the free provision should win over the 10% one");
});

test("a carve-out charge is labelled with the provision it came from", () => {
  const reduced = remedy({ heading: "9903.01.13", uplift: 0.1 });
  const r = run({
    remedies: [{
      remedy: remedy({ heading: "9903.01.10", uplift: 0.35, exceptHeadings: ["9903.01.13"] }),
      confidence: "confirmed" as const, reason: "", matchedOn: "origin", exemptions: [reduced],
    }],
    appliedHeadings: new Set(["9903.01.10", "9903.01.13"]),
  });
  const charge = r.charges.find((c) => c.kind === "remedy")!;
  assert.ok(charge.label.includes("9903.01.13"));
  assert.ok(charge.formula.includes("replacing"));
});

/*
 * Replacement rates.
 *
 * A bare percentage on a Chapter 99 heading sets the total rate rather than
 * adding to it — how the schedule writes a negotiated ceiling. Heading
 * 9903.94.41 is "15%" for Japanese vehicles whose ordinary rate is below 15%.
 * Read as an uplift it would report 17.5% on a 2.5% car; ignored entirely, as
 * it was before, it reported 2.5%.
 */
test("a replacement heading sets the total rate, not an addition", () => {
  const flat = {
    remedy: remedy({ heading: "9903.94.41", uplift: 0, replaces: 0.15 }),
    confidence: "confirmed" as const, reason: "", matchedOn: "87032301", exemptions: [],
  };
  const r = run({ entry: entry({ general: "2.5%" }), remedies: [flat], appliedHeadings: new Set(["9903.94.41"]) });
  assert.equal(r.dutyTotal, 1500, "15% of 10,000 — not 250 and not 1,750");
  const duty = r.charges.find((c) => c.kind === "duty")!;
  assert.ok(duty.label.includes("9903.94.41"));
});

test("a replacement rate leaves the fees alone", () => {
  const flat = {
    remedy: remedy({ heading: "9903.94.41", uplift: 0, replaces: 0.15 }),
    confidence: "confirmed" as const, reason: "", matchedOn: "x", exemptions: [],
  };
  const r = run({ remedies: [flat], appliedHeadings: new Set(["9903.94.41"]), mode: "ocean" });
  assert.ok(r.charges.some((c) => c.label.includes("Merchandise")));
  assert.ok(r.charges.some((c) => c.label.includes("Harbor")));
  assert.ok(r.feeTotal > 0);
});

test("a replacement supersedes other uplifts rather than stacking", () => {
  const flat = {
    remedy: remedy({ heading: "9903.94.41", uplift: 0, replaces: 0.15 }),
    confidence: "confirmed" as const, reason: "", matchedOn: "x", exemptions: [],
  };
  const extra = {
    remedy: remedy({ heading: "9903.88.03", uplift: 0.25 }),
    confidence: "confirmed" as const, reason: "", matchedOn: "x", exemptions: [],
  };
  const r = run({
    entry: entry({ general: "2.5%" }),
    remedies: [extra, flat],
    appliedHeadings: new Set(["9903.94.41", "9903.88.03"]),
  });
  assert.equal(r.dutyTotal, 1500);
});

/*
 * Chapter 98.
 *
 * A valid claim is one of the few things that removes an IEEPA duty outright,
 * and the notes say so for eight headings. It is offered as a claim rather than
 * applied automatically because the waiver is conditional on CBP accepting it.
 */
test("a Chapter 98 claim waives the duties the notes say it waives", () => {
  const waivable = {
    remedy: remedy({ heading: "9903.01.10", uplift: 0.35, chapter98Waives: true }),
    confidence: "confirmed" as const, reason: "", matchedOn: "origin", exemptions: [],
  };
  assert.equal(run({ remedies: [waivable], chapter98: true }).remedyTotal, 0);
  assert.equal(run({ remedies: [waivable], chapter98: false }).remedyTotal, 3500);
});

test("a Chapter 98 claim leaves other duties alone", () => {
  const notWaivable = {
    remedy: remedy({ heading: "9903.88.03", uplift: 0.25 }),
    confidence: "confirmed" as const, reason: "", matchedOn: "x", exemptions: [],
  };
  assert.equal(run({ remedies: [notWaivable], chapter98: true }).remedyTotal, 2500);
});

test("a Chapter 98 claim explains that the value is not adjusted", () => {
  const r = run({ chapter98: true });
  const notice = r.notices.find((n) => n.title.includes("Chapter 98"));
  assert.ok(notice, "expected a Chapter 98 notice");
  assert.ok(notice.body.includes("does not adjust the customs value"));
});

/* -------------------------------------------------------------- matching */

const data = (remedies: Remedy[], coverage: Record<string, string[]> = {}): RemedyData => ({ remedies, coverage });

test("only provisions cheaper than the parent count as carve-outs", () => {
  const dearer = remedy({ heading: "9903.99.99", uplift: 0.5 });
  const cheaper = remedy({ heading: "9903.88.13", uplift: 0 });
  const parent = remedy({ heading: "9903.11.11", uplift: 0.25, exceptHeadings: ["9903.99.99", "9903.88.13"] });
  const d = data([parent, dearer, cheaper], { "12345678": ["9903.11.11"] });
  const m = matchRemedies(d, "1234.56.78.90", country());
  assert.deepEqual(m[0]?.exemptions.map((e) => e.heading), ["9903.88.13"]);
});

/*
 * Threshold pairs.
 *
 * A negotiated ceiling is written as two headings gated on the ordinary rate,
 * one for rates at or above the threshold and one below. Exactly one applies,
 * and the base rate settles which — offering both asks the user to decide what
 * the data already answers.
 */
test("the base rate settles which half of a threshold pair applies", () => {
  const above = remedy({ heading: "9903.94.40", uplift: 0, threshold: { op: "gte", rate: 0.15 } });
  const below = remedy({ heading: "9903.94.41", uplift: 0, replaces: 0.15, threshold: { op: "lt", rate: 0.15 } });
  const d = data([above, below], { "12345678": ["9903.94.40", "9903.94.41"] });

  const cheap = matchRemedies(d, "1234.56.78.90", country(), 0.025);
  assert.deepEqual(cheap.map((m) => m.remedy.heading), ["9903.94.41"]);

  const dear = matchRemedies(d, "1234.56.78.90", country(), 0.2);
  assert.deepEqual(dear.map((m) => m.remedy.heading), ["9903.94.40"]);
});

test("without a base rate neither half is ruled out", () => {
  const above = remedy({ heading: "9903.94.40", uplift: 0, threshold: { op: "gte", rate: 0.15 } });
  const below = remedy({ heading: "9903.94.41", uplift: 0, replaces: 0.15, threshold: { op: "lt", rate: 0.15 } });
  const d = data([above, below], { "12345678": ["9903.94.40", "9903.94.41"] });
  assert.equal(matchRemedies(d, "1234.56.78.90", country()).length, 2);
});

test("a list heading matches through the 8-digit parent", () => {
  const d = data([remedy({ heading: "9903.11.11" })], { "12345678": ["9903.11.11"] });
  const m = matchRemedies(d, "1234.56.78.90", country());
  assert.equal(m.length, 1);
  assert.equal(m[0]?.matchedOn, "12345678");
  assert.equal(m[0]?.confidence, "confirmed");
});

test("a list heading scoped to another country does not match", () => {
  const d = data([remedy({ heading: "9903.11.11", scope: { kind: "country", name: "Elsewhere" } })], {
    "12345678": ["9903.11.11"],
  });
  assert.equal(matchRemedies(d, "1234.56.78.90", country()).length, 0);
});

// Blanket headings overlap and are alternatives, not addends; auto-applying
// them produced 165% for goods that mostly owe nothing.
test("blanket headings are surfaced but never applied automatically", () => {
  const d = data([remedy({ heading: "9903.01.10", kind: "blanket", uplift: 0.35 })]);
  const m = matchRemedies(d, "1234.56.78.90", country());
  assert.equal(m.length, 1);
  assert.equal(m[0]?.confidence, "possible");
  assert.equal(m[0]?.matchedOn, "origin");

  // Defaulting the applied set must leave it out.
  const r = run({ remedies: m });
  assert.equal(r.remedyRate, 0);
});

/*
 * Displacement.
 *
 * The notes resolve overlap where they bother to: heading 9903.01.10 reaches
 * Canadian goods "other than products described in headings … 9903.76.01,
 * 9903.76.02 and 9903.76.03". A Canadian kitchen cabinet matches the Section
 * 232 cabinet duty, so the 35% blanket must drop out rather than sit alongside
 * it inviting the user to add them together.
 */
test("a heading displaced by another that matched is dropped", () => {
  const blanket = remedy({
    heading: "9903.01.10", uplift: 0.35, kind: "blanket",
    displacedBy: ["9903.76.03"],
  });
  const specific = remedy({ heading: "9903.76.03", uplift: 0.25, scope: { kind: "all" } });
  const d = data([blanket, specific], { "12345678": ["9903.76.03"] });

  const m = matchRemedies(d, "1234.56.78.90", country());
  assert.deepEqual(m.map((x) => x.remedy.heading), ["9903.76.03"]);
});

test("a displacing heading that did not match leaves the blanket in place", () => {
  const blanket = remedy({
    heading: "9903.01.10", uplift: 0.35, kind: "blanket",
    scope: { kind: "all" }, displacedBy: ["9903.76.03"],
  });
  // 9903.76.03 exists but covers nothing this line is in.
  const specific = remedy({ heading: "9903.76.03", uplift: 0.25 });
  const d = data([blanket, specific], {});

  const m = matchRemedies(d, "1234.56.78.90", country());
  assert.deepEqual(m.map((x) => x.remedy.heading), ["9903.01.10"]);
});

test("an all-except scope excludes the countries it names", () => {
  const d = data([
    remedy({ heading: "9903.22.22", kind: "blanket", scope: { kind: "all-except", names: ["Testland"] } }),
  ]);
  assert.equal(matchRemedies(d, "1234.56.78.90", country()).length, 0);
  assert.equal(matchRemedies(d, "1234.56.78.90", country({ name: "Otherland" })).length, 1);
});

test("an EU bloc exclusion covers member states", () => {
  const d = data([
    remedy({
      heading: "9903.33.33", kind: "blanket",
      scope: { kind: "all-except", names: ["the member nations of the European Union"] },
    }),
  ]);
  const germany = country({ iso: "DE", name: "Germany" });
  const vietnam = country({ iso: "VN", name: "Vietnam" });
  assert.equal(matchRemedies(d, "1234.56.78.90", germany).length, 0);
  assert.equal(matchRemedies(d, "1234.56.78.90", vietnam).length, 1);
});

test("unreadable scope yields a match that is shown but not applied", () => {
  const d = data([remedy({ heading: "9903.44.44", scope: { kind: "unknown", text: "" } })], {
    "12345678": ["9903.44.44"],
  });
  const m = matchRemedies(d, "1234.56.78.90", country());
  assert.equal(m[0]?.confidence, "possible");
});
