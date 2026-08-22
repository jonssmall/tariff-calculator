/**
 * Chapter 99 and General Note parsing.
 *
 * These read legal prose written for people, and every case here is a shape
 * that broke the parser at some point. The fixtures are trimmed from the real
 * documents rather than invented, so they stay honest about the formatting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHeadingCoverage,
  parseHeadingScopes,
  parseNoteRefs,
  parseUplift,
  classifyCoverage,
  digitsOf,
} from "../scripts/parse-ch99.ts";
import { resolveCountry, parseCountryList } from "../scripts/parse-notes.ts";

test("uplift forms", () => {
  assert.equal(parseUplift("The duty provided in the applicable subheading + 25%"), 0.25);
  assert.equal(parseUplift("The duty provided in the applicable subheading plus 25%"), 0.25);
  assert.equal(parseUplift("The duty provided in the applicable subheading"), 0);
  assert.equal(parseUplift("16.5%"), null);
});

// Regression: exemption headings are written "No change" and were dropped,
// taking the carve-outs that make blanket duties correct with them.
test("no change is an exemption, not an unparseable rate", () => {
  assert.equal(parseUplift("No change"), 0);
});

test("note references in both written forms", () => {
  assert.deepEqual(parseNoteRefs("as provided for in U.S. note 20(f) to this subchapter"), ["20(f)"]);
  assert.deepEqual(parseNoteRefs("provided for in subdivision (f) of U.S. note 37"), ["37(f)"]);
});

// Regression: the notes write 10-digit codes without the final dot.
test("codes normalize across both spellings", () => {
  assert.equal(digitsOf("9403.60.8093"), digitsOf("9403.60.80.93"));
});

test("blanket and list shapes are told apart", () => {
  assert.equal(classifyCoverage("Except as provided in headings 9903.88.13, articles the product of China"), "blanket");
  assert.equal(classifyCoverage("Completed kitchen cabinets provided for in subdivision (f) of U.S. note 37"), "list");
});

/*
 * Coverage attribution.
 *
 * The heading is named one level above its table and the markers are indented
 * identically, so nesting is signalled by the trailing colon. Reading it by
 * indentation dropped the heading and leaked the table onto whichever heading
 * was seen last.
 */
const NESTED_NOTE = `
20.  (a)   For the purposes of heading 9903.88.01, products of China shall be subject to duty.

     (s)      Heading 9903.88.15 applies to:

     (i)     all products of China that are classified in the following 8-digit subheadings:

                      6109.10.00   6109.90.10          6109.90.15
                      6110.11.00   6110.12.20          6110.19.00
`;

test("a nested subdivision inherits the heading named above it", () => {
  const coverage = parseHeadingCoverage(NESTED_NOTE);
  const codes = coverage.get("9903.88.15");
  assert.ok(codes, "expected 9903.88.15 to receive the nested table");
  assert.equal(codes.has("61091000"), true);
  assert.equal(codes.has("61101100"), true);
  // The table belongs to 9903.88.15, never to the heading mentioned earlier.
  assert.equal(coverage.get("9903.88.01"), undefined);
});

const PLURAL_NOTE = `
37.
     (f)      the rates of duty set forth in headings 9903.76.03, 9903.76.20, and 9903.76.24 apply to all
              imported completed kitchen cabinets classified under the provisions listed in this subdivision:

                                   9403.40.9060
                                   9403.60.8093
`;

test("a subdivision naming several headings gives the table to each", () => {
  const coverage = parseHeadingCoverage(PLURAL_NOTE);
  for (const heading of ["9903.76.03", "9903.76.20", "9903.76.24"]) {
    assert.equal(coverage.get(heading)?.has("9403608093"), true, `${heading} missing the code`);
  }
});

test("a table with no named heading is skipped rather than guessed", () => {
  const orphan = `
     (b)      the following provisions are relevant:

                      1234.56.78   2345.67.89
`;
  assert.equal(parseHeadingCoverage(orphan).size, 0);
});

/*
 * Scope attribution.
 *
 * One sentence often introduces several headings that share a coverage list but
 * not a country. Reading scope from such a sentence gave a UK-only heading
 * worldwide scope and charged 10% to every origin.
 */
const SCOPE_NOTE = `
     (e)      heading 9903.76.03 provides the ordinary customs duty treatment of completed kitchen cabinets,
              applicable to products of all countries other than: the United Kingdom, the member nations of the
              European Union, South Korea, Japan, and Taiwan.

     (f)      the rates of duty set forth in headings 9903.76.03, 9903.76.20 apply to all imported cabinets.

     (h)      heading 9903.76.20 provides the ordinary customs duty treatment of wood products of the
              United Kingdom described in subdivisions (d) and (f) of this note.
`;

test("scope comes from the sentence about that heading", () => {
  const scopes = parseHeadingScopes(SCOPE_NOTE, ["9903.76.03", "9903.76.20"]);
  const broad = scopes.get("9903.76.03");
  assert.equal(broad?.kind, "all-except");
  assert.ok(broad?.kind === "all-except" && broad.names.some((n) => /United Kingdom/.test(n)));

  // The UK-only heading must not inherit the other's scope.
  const uk = scopes.get("9903.76.20");
  assert.equal(uk?.kind, "country");
  assert.equal(uk?.kind === "country" && /United Kingdom/.test(uk.name), true);
});

test("country names resolve through formal and variant spellings", () => {
  assert.equal(resolveCountry("Republic of Angola"), "AO");
  assert.equal(resolveCountry("Federal Republic of Nigeria"), "NG");
  assert.equal(resolveCountry("Gambia, The"), "GM");
  assert.equal(resolveCountry("Côte d'Ivoire"), "CI");
  assert.equal(resolveCountry("South Korea"), "KR");
  assert.equal(resolveCountry("Nowhereistan"), undefined);
});

test("multi-column country lists parse, including wrapped names", () => {
  const note = `
             Angola                                     Gabon                       Pakistan
             Saint Vincent and the                      Ghana                       Paraguay
             Grenadines
`;
  const { found } = parseCountryList(note);
  assert.equal(found.has("AO"), true);
  assert.equal(found.has("GA"), true);
  assert.equal(found.has("PK"), true);
  assert.equal(found.has("VC"), true, "wrapped name should join with the line below");
});
