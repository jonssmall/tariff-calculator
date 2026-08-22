/**
 * Panel interaction.
 *
 * Two halves. The state transitions are pure and tested directly; the DOM
 * plumbing that feeds them — finding which exclusion list a checkbox belongs to
 * after the panel has been re-rendered from a string — needs a real document,
 * so those cases run in jsdom.
 *
 * This is the layer that let the collapse-on-uncheck bug through: the
 * calculation was right, the markup was right, and the state was wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { defaultsFor, toggleChecked, toggleDisclosure, emptyPanel } from "../src/ui/panel-state.ts";
import { renderRemedies } from "../src/ui/render.ts";
import type { RemedyMatch, Remedy } from "../src/lib/remedies.ts";

const remedy = (over: Partial<Remedy> = {}): Remedy => ({
  heading: "9903.88.03",
  uplift: 0.25,
  rateText: "The duty provided in the applicable subheading + 25%",
  description: "Articles the product of China",
  noteRefs: [],
  scope: { kind: "country", name: "China" },
  exceptHeadings: [],
  kind: "list",
  ...over,
});

const exclusion = remedy({ heading: "9903.88.13", uplift: 0, description: "An exclusion" });

const match = (over: Partial<RemedyMatch> = {}): RemedyMatch => ({
  remedy: remedy(),
  confidence: "confirmed",
  reason: "",
  matchedOn: "94036080",
  exemptions: [exclusion],
  ...over,
});

/* ----------------------------------------------------------- transitions */

test("confirmed matches start applied, possible ones do not", () => {
  const state = defaultsFor([
    match(),
    match({ remedy: remedy({ heading: "9903.01.10" }), confidence: "possible" }),
  ]);
  assert.equal(state.applied.has("9903.88.03"), true);
  assert.equal(state.applied.has("9903.01.10"), false);
  assert.equal(state.expanded.size, 0);
});

// Regression: unchecking the last exemption collapsed the list being used.
test("toggling an exemption keeps its list open in both directions", () => {
  let state = emptyPanel();
  state = toggleChecked(state, "9903.88.13", true, "9903.88.03");
  assert.equal(state.expanded.has("9903.88.03"), true);
  assert.equal(state.applied.has("9903.88.13"), true);

  state = toggleChecked(state, "9903.88.13", false, "9903.88.03");
  assert.equal(state.applied.has("9903.88.13"), false, "should be unchecked");
  assert.equal(state.expanded.has("9903.88.03"), true, "but the list must stay open");
});

/*
 * The precise regression.
 *
 * A list can be open because an exemption is claimed, without the user ever
 * having expanded it — so `expanded` is empty while the disclosure shows open.
 * Unchecking then removes the only reason it was open, and unless the toggle
 * records the expansion the list collapses under the user. Seeding `expanded`
 * first hides this, which is how the first version of this test passed against
 * the bug.
 */
test("unchecking a list opened only by its claim keeps it open", () => {
  const openBecauseClaimed = {
    applied: new Set(["9903.88.03", "9903.88.13"]),
    expanded: new Set<string>(),
  };
  const after = toggleChecked(openBecauseClaimed, "9903.88.13", false, "9903.88.03");
  assert.equal(after.applied.has("9903.88.13"), false);
  assert.equal(
    after.expanded.has("9903.88.03"),
    true,
    "the disclosure must be recorded as expanded, or it collapses on re-render",
  );
});

test("a disclosure the user closes stays closed", () => {
  let state = toggleDisclosure(emptyPanel(), "9903.88.03", true);
  state = toggleDisclosure(state, "9903.88.03", false);
  assert.equal(state.expanded.has("9903.88.03"), false);
});

test("disclosures are tracked per heading", () => {
  let state = toggleDisclosure(emptyPanel(), "9903.88.03", true);
  state = toggleDisclosure(state, "9903.88.04", true);
  state = toggleDisclosure(state, "9903.88.03", false);
  assert.deepEqual([...state.expanded], ["9903.88.04"]);
});

test("transitions do not mutate the state passed in", () => {
  const before = emptyPanel();
  toggleChecked(before, "9903.88.03", true);
  assert.equal(before.applied.size, 0);
});

test("selecting a new line clears expansion from the previous one", () => {
  const carried = toggleDisclosure(emptyPanel(), "9903.88.03", true);
  assert.equal(carried.expanded.size, 1);
  assert.equal(defaultsFor([match()]).expanded.size, 0);
});

/* ------------------------------------------------------------------ jsdom */

const mount = (html: string) => {
  const dom = new JSDOM(`<div id="out">${html}</div>`);
  return dom.window.document;
};

test("an exemption checkbox resolves the list it belongs to", () => {
  const doc = mount(
    renderRemedies({ matches: [match()], applied: new Set(["9903.88.03"]), expanded: new Set(["9903.88.03"]), customsValue: 10_000 }),
  );
  const box = doc.querySelector<HTMLInputElement>("details.remedy-exempt input[data-heading]");
  assert.ok(box, "expected an exemption checkbox");
  const owner = box.closest("details.remedy-exempt")?.getAttribute("data-for");
  assert.equal(owner, "9903.88.03", "closest() must find the owning heading");
});

test("a duty checkbox has no owning list", () => {
  const doc = mount(
    renderRemedies({ matches: [match()], applied: new Set(), expanded: new Set(), customsValue: 10_000 }),
  );
  const box = doc.querySelector<HTMLInputElement>(".remedy > input[data-heading]");
  assert.equal(box?.closest("details.remedy-exempt"), null);
});

/*
 * The full cycle that broke: render, uncheck an exemption, re-render from the
 * resulting state, and confirm the disclosure survived.
 */
test("the list survives a re-render after unchecking", () => {
  let state = { applied: new Set(["9903.88.03", "9903.88.13"]), expanded: new Set(["9903.88.03"]) };
  let doc = mount(renderRemedies({ matches: [match()], ...state, customsValue: 10_000 }));
  assert.equal(doc.querySelector("details.remedy-exempt")?.hasAttribute("open"), true);

  const box = doc.querySelector<HTMLInputElement>("details input[data-heading]")!;
  box.checked = false;
  const owner = box.closest("details.remedy-exempt")?.getAttribute("data-for") ?? undefined;
  state = toggleChecked(state, box.dataset["heading"]!, box.checked, owner) as typeof state;

  doc = mount(renderRemedies({ matches: [match()], ...state, customsValue: 10_000 }));
  const details = doc.querySelector("details.remedy-exempt");
  assert.equal(details?.hasAttribute("open"), true, "must still be open after re-render");
  assert.equal(
    doc.querySelector<HTMLInputElement>("details input[data-heading]")?.checked,
    false,
    "and the box must be unchecked",
  );
});

/*
 * The amount column must not be content-sized.
 *
 * Swapping "$2,500.00" for "exempt" changed an `auto` column's width, which
 * shifted the body column and narrowed the exclusion list the user was
 * scrolling. jsdom has no layout engine so the effect cannot be measured here;
 * asserting the declaration is a cheap guard against someone restoring `auto`.
 */
test("the remedy grid pins its amount column to a fixed width", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\.remedy \{[^}]*grid-template-columns:([^;]+);/);
  assert.ok(rule, "expected a grid-template-columns on .remedy");
  const columns = rule[1]!.trim();
  assert.ok(
    !/\bauto\s*$/.test(columns),
    `the last column must be a fixed size, got "${columns}"`,
  );
});

test("rendered markup parses without the browser repairing it", () => {
  const html = renderRemedies({
    matches: [match(), match({ remedy: remedy({ heading: "9903.88.04" }) })],
    applied: new Set(), expanded: new Set(), customsValue: 10_000,
  });
  const doc = mount(html);
  const rows = doc.querySelectorAll(".remedy");
  assert.equal(rows.length, 2);
  // If a row failed to close, the parser nests the second inside the first.
  for (const row of rows) assert.equal(row.querySelector(".remedy"), null, "rows must not nest");
});
