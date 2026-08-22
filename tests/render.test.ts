/**
 * Rendering, tested as strings.
 *
 * Three of the four UI defects that reached the browser are caught here without
 * a DOM: an unclosed `<div>` that nested every remedy row inside the previous
 * one, exclusion text truncated for no reason, and a disclosure whose open
 * state was derived from the wrong thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRemedies, renderOutput, cleanDescription, escapeHtml } from "../src/ui/render.ts";
import type { RemedyMatch, Remedy } from "../src/lib/remedies.ts";
import { calculate } from "../src/lib/calc.ts";
import type { Entry } from "../src/lib/hts.ts";
import type { Country } from "../src/lib/programs.ts";

const remedy = (over: Partial<Remedy> = {}): Remedy => ({
  heading: "9903.88.03",
  uplift: 0.25,
  rateText: "The duty provided in the applicable subheading + 25%",
  description: "Articles the product of China",
  noteRefs: ["20(f)"],
  scope: { kind: "country", name: "China" },
  exceptHeadings: [],
  kind: "list",
  ...over,
});

const match = (over: Partial<RemedyMatch> = {}): RemedyMatch => ({
  remedy: remedy(),
  confidence: "confirmed",
  reason: "The notes apply this heading to products of China.",
  matchedOn: "94036080",
  exemptions: [],
  ...over,
});

const view = (over: Partial<Parameters<typeof renderRemedies>[0]> = {}) => ({
  matches: [match()],
  applied: new Set(["9903.88.03"]),
  expanded: new Set<string>(),
  customsValue: 10_000,
  ...over,
});

/** Count opening and closing tags of one element name. */
function tagBalance(html: string, tag: string): { open: number; close: number } {
  return {
    open: (html.match(new RegExp(`<${tag}(?=[\\s>])`, "g")) ?? []).length,
    close: (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length,
  };
}

/*
 * Regression: changing the row wrapper from <label> to <div> dropped its
 * closing tag, so every row nested inside the previous one and each rendered
 * narrower and taller than the last.
 */
test("every element the remedy band opens is closed", () => {
  const html = renderRemedies(view({ matches: [match(), match(), match()] }));
  for (const tag of ["div", "span", "details", "label", "summary"]) {
    const { open, close } = tagBalance(html, tag);
    assert.equal(open, close, `<${tag}> opened ${open} times, closed ${close}`);
  }
});

test("remedy rows are siblings, never nested", () => {
  const html = renderRemedies(view({ matches: [match(), match()] }));
  // Match only row wrappers: `remedy-block` and `remedy-exempt` share the prefix.
  const ROW = /<div class="remedy(?: remedy-on)?">/g;
  const starts = [...html.matchAll(ROW)].map((m) => m.index!);
  assert.equal(starts.length, 2, "expected two rows");

  // The first row must close before the second opens, so the slice between them
  // is balanced. Nesting would leave it one <div> short.
  const between = html.slice(starts[0]!, starts[1]!);
  const { open, close } = tagBalance(between, "div");
  assert.equal(open, close, "the first row must close before the next begins");
});

// Regression: exclusion text was cut at 110 characters for no reason — the
// list already scrolls inside a capped container.
test("exclusion descriptions are not truncated", () => {
  const long =
    "Articles the product of China, as provided for in U.S. note 20(p) to this subchapter, each covered by an exclusion granted by the U.S. Trade Representative and effective for the stated period";
  const html = renderRemedies(
    view({ matches: [match({ exemptions: [remedy({ heading: "9903.88.13", uplift: 0, description: long })] })] }),
  );
  assert.ok(html.includes(escapeHtml(cleanDescription(long))), "full exclusion text should be present");
  assert.ok(!html.includes("…</span></label>"), "no ellipsis inside an exclusion label");
});

/*
 * Regression: `open` was derived from whether an exemption was claimed, so
 * unchecking the last one collapsed the list the user was working in.
 */
test("disclosure state follows `expanded`, not what is claimed", () => {
  const withExemption = match({
    exemptions: [remedy({ heading: "9903.88.13", uplift: 0, description: "An exclusion" })],
  });

  const collapsed = renderRemedies(view({ matches: [withExemption], expanded: new Set() }));
  assert.ok(!/<details[^>]*\sopen/.test(collapsed), "should start collapsed");

  const expanded = renderRemedies(
    view({ matches: [withExemption], expanded: new Set(["9903.88.03"]) }),
  );
  assert.ok(/<details[^>]*\sopen/.test(expanded), "expanded set should open it");

  // Nothing claimed, but expanded: it must stay open. This is the exact state
  // after a user unchecks the last exemption.
  const afterUncheck = renderRemedies(
    view({ matches: [withExemption], applied: new Set(["9903.88.03"]), expanded: new Set(["9903.88.03"]) }),
  );
  assert.ok(/<details[^>]*\sopen/.test(afterUncheck), "must stay open once unchecked");
});

/*
 * No truncation anywhere.
 *
 * These are legal descriptions and a customs user needs the whole sentence —
 * "as provided for in the subheadings enumerated in U.S. note 20…" tells them
 * nothing. Cutting text also hid which note a heading pointed at, which is the
 * one thing they would look up next.
 */
test("nothing in the remedy band is truncated", () => {
  const long =
    "Articles the product of China, as provided for in U.S. note 20(g) to this subchapter and as " +
    "provided for in the subheadings enumerated in U.S. note 20(h), except as further provided in " +
    "headings enumerated in the applicable subdivision of that note and any successor provision.";
  const html = renderRemedies(
    view({
      matches: [
        match({
          remedy: remedy({ description: long }),
          exemptions: [remedy({ heading: "9903.88.13", uplift: 0, description: long })],
        }),
      ],
      expanded: new Set(["9903.88.03"]),
    }),
  );
  assert.ok(!html.includes("…"), "no ellipsis should appear in the band");
  // The tail of the sentence must survive, not just the head.
  assert.ok(html.includes(escapeHtml("any successor provision.")));
});

test("the whole panel renders without truncating anything", () => {
  const long = "A description that runs well past any previous slice limit, ".repeat(6);
  const result = calculate({
    entry, country: china, customsValue: 10_000, quantities: {}, mode: "ocean",
    remedies: [match({ remedy: remedy({ description: long }) })],
  });
  const html = renderOutput({
    ...view({ matches: [match({ remedy: remedy({ description: long }) })] }),
    result,
  });
  assert.ok(!html.includes("…"));
});

test("a claimed exemption shows as exempt rather than an amount", () => {
  const waiver = remedy({ heading: "9903.88.13", uplift: 0, description: "An exclusion" });
  const html = renderRemedies(
    view({
      matches: [match({ exemptions: [waiver] })],
      applied: new Set(["9903.88.03", "9903.88.13"]),
    }),
  );
  assert.ok(html.includes(">exempt<"));
  assert.ok(!html.includes("$2,500.00"));
});

test("a reduced-rate carve-out shows its amount, not the word exempt", () => {
  const reduced = remedy({ heading: "9903.01.13", uplift: 0.1, description: "Crude oil" });
  const html = renderRemedies(
    view({
      matches: [match({ remedy: remedy({ heading: "9903.01.10", uplift: 0.35 }), exemptions: [reduced] })],
      applied: new Set(["9903.01.10", "9903.01.13"]),
    }),
  );
  assert.ok(html.includes("$1,000.00"), "should show 10% of the value");
  assert.ok(!html.includes(">exempt<"), "10% is a reduction, not an exemption");
});

test("each carve-out shows its own rate in the list", () => {
  const html = renderRemedies(
    view({
      matches: [match({
        exemptions: [
          remedy({ heading: "9903.01.13", uplift: 0.1, description: "Crude oil" }),
          remedy({ heading: "9903.01.14", uplift: 0, description: "USMCA" }),
        ],
      })],
      expanded: new Set(["9903.88.03"]),
    }),
  );
  assert.ok(html.includes("+10%"));
  assert.ok(html.includes(">free<"));
});

test("an unapplied heading is still listed, with no amount", () => {
  const html = renderRemedies(view({ applied: new Set() }));
  assert.ok(html.includes("9903.88.03"), "the heading must remain visible");
  assert.ok(html.includes(">—<"));
});

test("a possible match is flagged for verification", () => {
  const html = renderRemedies(view({ matches: [match({ confidence: "possible", matchedOn: "origin" })] }));
  assert.ok(html.includes("remedy-flag"));
  assert.ok(html.includes("applies to all goods of this origin"));
});

test("no matches renders nothing at all", () => {
  assert.equal(renderRemedies(view({ matches: [] })), "");
});

test("exclusion citations are stripped from descriptions", () => {
  const raw = "Except as provided in headings 9903.88.13, 9903.88.18, or 9903.88.33, articles the product of China";
  assert.equal(cleanDescription(raw), "Articles the product of China");
});

test("user-supplied text is escaped", () => {
  const html = renderRemedies(
    view({ matches: [match({ remedy: remedy({ description: '<script>alert("x")</script>' }) })] }),
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

/* ------------------------------------------------------------ whole panel */

const entry: Entry = {
  code: "9403.60.80.93", desc: "Other", path: [], units: [],
  general: "Free", special: "", other: "40%", leaf: true,
};
const china: Country = { iso: "CN", name: "China", programs: [] };

test("the results panel is balanced and carries the total", () => {
  const result = calculate({
    entry, country: china, customsValue: 10_000, quantities: {}, mode: "ocean",
    remedies: [match()],
  });
  const html = renderOutput({ ...view(), result });
  for (const tag of ["div", "span", "details", "label", "p"]) {
    const { open, close } = tagBalance(html, tag);
    assert.equal(open, close, `<${tag}> unbalanced: ${open} open, ${close} close`);
  }
  assert.ok(html.includes("$2,547.14"), "expected the computed grand total");
});

test("a failed remedy load is announced rather than silently ignored", () => {
  const result = calculate({ entry, country: china, customsValue: 10_000, quantities: {}, mode: "ocean" });
  const html = renderOutput({ ...view(), matches: [], result, remedyError: "404" });
  assert.ok(html.includes("Additional duties could not be loaded"));
  assert.ok(html.includes("understates"));
});
