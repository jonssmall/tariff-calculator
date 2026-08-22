/**
 * Duty rate grammar.
 *
 * The rate cells are prose and the schedule uses a wide grammar. Several cases
 * here are bugs that shipped and were found by rebuilding the whole dataset and
 * reading output — a forty-second loop for something a millisecond test catches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRate, parseSpecial, normalizeUnit, unitLabel, requiredUnits } from "../src/lib/rates.ts";

/**
 * Compare rate terms with a tolerance.
 *
 * Dividing cents by 100 leaves binary floating-point noise — 4.4¢ becomes
 * 0.044000000000000004 — which is invisible once multiplied by a quantity and
 * rounded for display, but makes exact structural comparison useless.
 */
const assertTerms = (actual: unknown, expected: { kind: string; amountUsd?: number; fraction?: number; per?: string }[]): void => {
  const terms = actual as { kind: string; amountUsd?: number; fraction?: number; per?: string }[];
  assert.equal(terms.length, expected.length);
  terms.forEach((term, i) => {
    const want = expected[i]!;
    assert.equal(term.kind, want.kind);
    if (want.per !== undefined) assert.equal(term.per, want.per);
    if (want.amountUsd !== undefined) assert.ok(Math.abs(term.amountUsd! - want.amountUsd) < 1e-9);
    if (want.fraction !== undefined) assert.ok(Math.abs(term.fraction! - want.fraction) < 1e-9);
  });
};

test("free rates", () => {
  const r = parseRate("Free");
  assert.equal(r.free, true);
  assert.equal(r.computable, true);
  assert.deepEqual(r.terms, []);
});

test("ad valorem", () => {
  const r = parseRate("16.5%");
  assertTerms(r.terms, [{ kind: "advalorem", fraction: 0.165 }]);
  assert.equal(r.free, false);
});

test("specific duty in cents", () => {
  const r = parseRate("4.4¢/kg");
  assertTerms(r.terms, [{ kind: "specific", amountUsd: 0.044, per: "kg" }]);
});

test("specific duty in dollars", () => {
  assertTerms(parseRate("$1.035/kg").terms, [{ kind: "specific", amountUsd: 1.035, per: "kg" }]);
});

test("compound duty keeps both components", () => {
  const r = parseRate("9.9¢/kg + 6.4%");
  assert.equal(r.computable, true);
  assertTerms(r.terms, [
    { kind: "specific", amountUsd: 0.099, per: "kg" },
    { kind: "advalorem", fraction: 0.064 },
  ]);
});

test("per-unit duties without a slash", () => {
  assertTerms(parseRate("20¢ each").terms, [{ kind: "specific", amountUsd: 0.2, per: "each" }]);
});

// Regression: the unit pattern excluded digits, so "$1.13/m3" did not parse.
test("units containing a digit", () => {
  const r = parseRate("$1.13/m3");
  assert.equal(r.computable, true);
  assertTerms(r.terms, [{ kind: "specific", amountUsd: 1.13, per: "m3" }]);
});

// Regression: the schedule spells the same unit both ways, which produced two
// separate quantity inputs for one duty.
test("abbreviating period spacing is normalized", () => {
  assert.equal(normalizeUnit("pf. liter"), normalizeUnit("pf.liter"));
});

test("unit aliases collapse to one key", () => {
  assert.equal(normalizeUnit("No."), "each");
  assert.equal(normalizeUnit("doz."), "doz");
  assert.equal(normalizeUnit("m²"), "m2");
});

// A qualified weight must stay distinct: the duty is owed on that basis, and
// charging it against gross weight overstates it, often severely.
test("qualified weights are not folded into kilograms", () => {
  assert.notEqual(normalizeUnit("kg on lead content"), "kg");
  assert.equal(unitLabel("kg on lead content"), "kg on lead content");
});

test("uncomputable forms are refused rather than guessed", () => {
  for (const text of [
    "The duty provided in the applicable subheading + 25%",
    "The rate applicable to each garment in the ensemble if separately entered",
    "30.9¢/kg less 3.5¢/kg for each degree under 40 degrees",
    "See 9903.88.03",
    "No change",
  ]) {
    const r = parseRate(text);
    assert.equal(r.computable, false, `expected "${text}" to be refused`);
    assert.deepEqual(r.terms, []);
  }
});

test("required units are deduplicated", () => {
  assert.deepEqual(requiredUnits(parseRate("2¢/kg + 3¢/kg + 5%")), ["kg"]);
});

test("special column splits into per-programme clauses", () => {
  const clauses = parseSpecial("Free (AU,BH,CL) 3.5% (JP)");
  assert.equal(clauses.length, 2);
  assert.deepEqual(clauses[0], { rateText: "Free", codes: ["AU", "BH", "CL"] });
  assert.deepEqual(clauses[1], { rateText: "3.5%", codes: ["JP"] });
});

test("special column tolerates the schedule's stray whitespace", () => {
  const [clause] = parseSpecial("Free (AU,BH, CL,CO,E*,IL)");
  assert.deepEqual(clause?.codes, ["AU", "BH", "CL", "CO", "E*", "IL"]);
});

test("quota cross-references are preserved as text", () => {
  const clauses = parseSpecial("Free (BH,CL) See 9822.04.01-9822.04.03 (AU)");
  assert.equal(clauses.at(-1)?.rateText, "See 9822.04.01-9822.04.03");
});
