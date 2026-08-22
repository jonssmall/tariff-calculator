/**
 * UI wiring.
 *
 * One module, no framework: the app has a single screen and one piece of state
 * worth the name (the selected line), so a framework would be more machinery
 * than the problem needs. Rendering is a full redraw of the output panel on
 * every input change, which at this size is cheaper than reconciling.
 */
import { search, getEntry, loadMeta, loadRemedies, loadCountries, type Entry, type Hit } from "./lib/hts.ts";
import { parseRate, parseSpecial, requiredUnits, unitLabel } from "./lib/rates.ts";
import { calculate, type Mode } from "./lib/calc.ts";
import { matchRemedies, type RemedyData, type RemedyMatch } from "./lib/remedies.ts";
import { AS_OF, type Country } from "./lib/programs.ts";
import { renderOutput, renderSpecial, escapeHtml as escape } from "./ui/render.ts";
import { defaultsFor, toggleChecked, toggleDisclosure, emptyPanel, type PanelState } from "./ui/panel-state.ts";

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const searchInput = $<HTMLInputElement>("#search-input");
const leafOnly = $<HTMLInputElement>("#leaf-only");
const resultsList = $<HTMLUListElement>("[data-results]");
const resultCount = $("[data-result-count]");
const searchEmpty = $("[data-search-empty]");
const placeholder = $("[data-placeholder]");
const detail = $("[data-detail]");
const form = $<HTMLFormElement>("[data-form]");
const countryInput = $<HTMLInputElement>("#country");
const countryList = $<HTMLUListElement>("#country-list");
const valueInput = $<HTMLInputElement>("#value");
const chapter98Input = $<HTMLInputElement>("#chapter98");
const quantitiesBlock = $("[data-quantities]");
const quantityFields = $("[data-quantity-fields]");
const output = $("[data-output]");

let selected: Entry | undefined;
let remedyData: RemedyData | undefined;
/** Set when the Chapter 99 dataset could not be loaded. */
let remedyError: string | undefined;
let remedyMatches: RemedyMatch[] = [];
/** Applied headings and expanded exclusion lists. See ui/panel-state.ts. */
let panel: PanelState = emptyPanel();

/*
 * A failure here must be loud.
 *
 * Without a catch this rejected silently: `remedyData` stayed undefined,
 * `remedyMatches` stayed empty, and every line reported no Chapter 99 duties
 * with no error anywhere. That is not a degraded result, it is a wrong one that
 * looks right — a Chinese EV reads 2.5% instead of 102.5%. It happened on the
 * first deploy, where remedies.json was missing and nothing on the page said so.
 */
void loadRemedies()
  .then((data) => {
    remedyData = data;
    remedyError = undefined;
  })
  .catch((error: unknown) => {
    remedyError = error instanceof Error ? error.message : String(error);
    remedyData = undefined;
  })
  .finally(() => {
    if (selected) {
      refreshRemedies();
      render();
    }
  });

/**
 * Recompute which Chapter 99 headings reach the current line and origin, and
 * reset the applied set to the confirmed ones. The reset is deliberate: a
 * heading the user switched on for China must not silently carry over when the
 * origin changes to Germany, where it may not apply at all.
 */
function refreshRemedies(): void {
  const country = selectedCountry;
  if (!remedyData || !selected || !country) {
    remedyMatches = [];
    panel = emptyPanel();
    return;
  }
  // Only a plain ad valorem rate can settle a threshold condition; a compound
  // or specific duty's ad valorem equivalent depends on quantity.
  const base = parseRate(selected.general);
  const baseRate =
    base.computable && base.terms.length === 1 && base.terms[0]?.kind === "advalorem"
      ? base.terms[0].fraction
      : base.free
        ? 0
        : undefined;
  remedyMatches = matchRemedies(remedyData, selected.code, country, baseRate);
  panel = defaultsFor(remedyMatches);
}

/* ---------------------------------------------------------------- provenance */

void loadMeta().then((meta) => {
  const fetched = new Date(meta.fetchedAt);
  const stamp = fetched.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  $("[data-provenance]").textContent = `${meta.entries.toLocaleString("en-US")} lines · USITC data retrieved ${stamp}`;
  renderAudit(meta);
  $("[data-footer-provenance]").innerHTML =
    `Tariff data retrieved from the <strong>${escape(meta.source)}</strong> on ${escape(stamp)} ` +
    `(${meta.rows.toLocaleString("en-US")} rows, ${meta.entries.toLocaleString("en-US")} priceable lines) via ` +
    `<code>${escape(meta.endpoint)}</code>. The schedule is revised several times a year and this snapshot ` +
    `is refreshed by re-running the project's data script. Trade programme membership and fee amounts are ` +
    `stated as of ${escape(AS_OF)}.`;
});

/**
 * Coverage audit.
 *
 * Published on the page rather than kept in the build log, because the gaps are
 * the part a user most needs to know about. Coverage clusters by remedy family,
 * and the only reason the Canada gap surfaced at all was someone noticing a
 * wrong number — a standing report is what makes that visible without waiting
 * for a complaint.
 */
function renderAudit(meta: Awaited<ReturnType<typeof loadMeta>>): void {
  const rows = meta.audit ?? [];
  if (rows.length === 0) return;
  const live = rows.reduce((a, r) => a + r.live, 0);
  const covered = rows.reduce((a, r) => a + r.covered, 0);

  $("[data-audit]").innerHTML =
    `<p class="mb-2">Chapter 99 headings that impose a duty, and whether this tool can reach them. ` +
    `<strong>${covered} of ${live}</strong> reachable. "List" headings name the classifications they cover, so they ` +
    `are applied automatically when they match. "Blanket" headings cover an origin wholesale and overlap with one ` +
    `another, so they are shown for review rather than applied.</p>` +
    `<table class="w-full text-left"><thead><tr>` +
    `<th class="py-1 pr-3 font-semibold">Family</th><th class="py-1 pr-3 font-semibold">Duties</th>` +
    `<th class="py-1 pr-3 font-semibold">Reachable</th><th class="py-1 font-semibold">Shape</th></tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr class="border-t border-rule"><td class="py-1 pr-3 font-mono">${escape(r.family)}</td>` +
          `<td class="py-1 pr-3">${r.live}</td><td class="py-1 pr-3">${r.covered}</td>` +
          `<td class="py-1">${r.blanket > 0 ? `${r.blanket} blanket` : ""}${r.blanket > 0 && r.list > 0 ? ", " : ""}${r.list > 0 ? `${r.list} list` : ""}</td></tr>`,
      )
      .join("") +
    `</tbody></table>` +
    renderUnreachable(meta.unreachable ?? []);
}

/**
 * The headings this tool cannot reach, named rather than counted.
 *
 * A number says there is a gap; the list says which goods fall in it. These are
 * duties a user could owe and the calculator will never raise on its own, so
 * they belong on the page rather than in a build log.
 */
function renderUnreachable(rows: { heading: string; uplift: number; description: string }[]): string {
  if (rows.length === 0) return "";
  return (
    `<details class="mt-3"><summary class="cursor-pointer font-medium">` +
    `${rows.length} duty-imposing headings this tool cannot match to a classification</summary>` +
    `<p class="mt-2">Their coverage lists could not be read from the U.S. Notes. If your goods fall under one of ` +
    `these, the duty is owed and will not appear above.</p>` +
    `<ul class="mt-2 space-y-1">` +
    rows
      .map(
        (r) =>
          `<li><span class="font-mono">${escape(r.heading)}</span> ` +
          `<strong>+${(r.uplift * 100).toFixed(0)}%</strong> — ${escape(r.description)}</li>`,
      )
      .join("") +
    `</ul></details>`
  );
}

/* -------------------------------------------------------------------- search */

let searchToken = 0;

async function runSearch(): Promise<void> {
  const query = searchInput.value;
  const token = ++searchToken;
  if (!query.trim()) {
    resultsList.innerHTML = "";
    resultCount.textContent = "";
    searchEmpty.classList.add("hidden");
    return;
  }

  const hits = await search(query, { leafOnly: leafOnly.checked, limit: 150 });
  if (token !== searchToken) return; // A later keystroke already won.

  resultCount.textContent = hits.length > 0 ? `${hits.length}${hits.length === 150 ? "+" : ""} matches` : "";
  searchEmpty.classList.toggle("hidden", hits.length > 0);
  if (hits.length === 0) {
    searchEmpty.textContent = `Nothing matches "${query}". Try fewer or more general terms, or search by HTS number.`;
  }
  renderResults(hits);
}

function renderResults(hits: Hit[]): void {
  const frag = document.createDocumentFragment();
  for (const hit of hits) {
    const li = document.createElement("li");
    const parts = hit.text.split(" > ");
    const context = parts.slice(0, -1).join(" › ");
    const rate = parseRate(hit.general);

    li.className = "result";
    li.setAttribute("role", "option");
    li.tabIndex = 0;
    li.dataset["code"] = hit.code;
    li.setAttribute("aria-selected", String(selected?.code === hit.code));
    li.innerHTML =
      `<div><span class="result-code">${escape(hit.code)}</span>` +
      `<div class="result-desc">${escape(hit.desc)}</div>` +
      (context ? `<div class="result-path">${escape(context)}</div>` : "") +
      `</div>` +
      `<span class="result-rate" data-free="${rate.free}">${escape(rate.free ? "Free" : hit.general || "—")}</span>`;
    frag.append(li);
  }
  resultsList.replaceChildren(frag);
}

resultsList.addEventListener("click", (event) => {
  const li = (event.target as Element).closest<HTMLElement>(".result");
  if (li?.dataset["code"]) void select(li.dataset["code"]);
});
resultsList.addEventListener("keydown", (event) => {
  const li = (event.target as Element).closest<HTMLElement>(".result");
  if (!li) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (li.dataset["code"]) void select(li.dataset["code"]);
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const sibling = event.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling;
    (sibling as HTMLElement | null)?.focus();
  }
});

let debounce: number | undefined;
searchInput.addEventListener("input", () => {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void runSearch(), 140);
});
leafOnly.addEventListener("change", () => void runSearch());

/* ------------------------------------------------------------------ selection */

async function select(code: string): Promise<void> {
  const entry = await getEntry(code);
  if (!entry) return;
  selected = entry;

  for (const li of resultsList.querySelectorAll<HTMLElement>(".result")) {
    li.setAttribute("aria-selected", String(li.dataset["code"] === code));
  }

  placeholder.hidden = true;
  detail.hidden = false;

  $("[data-code]").textContent = entry.code;
  // A compliance user should be able to check any figure here against the
  // authoritative schedule in one click.
  const verify = $<HTMLAnchorElement>("[data-verify]");
  verify.href = `https://hts.usitc.gov/search?query=${encodeURIComponent(entry.code)}`;
  $("[data-desc]").textContent = entry.desc;
  $("[data-path]").textContent = entry.path.join(" › ");

  const general = parseRate(entry.general);
  const generalEl = $("[data-rate-general]");
  generalEl.textContent = entry.general || "—";
  generalEl.style.color = general.free ? "var(--color-free)" : "";

  $("[data-rate-special]").innerHTML = renderSpecial(entry.special);
  $("[data-rate-other]").textContent = entry.other || "—";

  renderQuantityFields(entry);
  refreshRemedies();
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  render();
}


/**
 * Build a quantity input for every unit any of the three columns could need.
 *
 * The units are taken from the rate text rather than the line's reporting units
 * because the two do not always agree, and it is the rate that decides what the
 * duty is actually multiplied by.
 */
function renderQuantityFields(entry: Entry): void {
  const units = new Set<string>();
  for (const text of [entry.general, entry.other, ...parseSpecial(entry.special).map((c) => c.rateText)]) {
    for (const unit of requiredUnits(parseRate(text))) units.add(unit);
  }
  if (units.size === 0) {
    quantitiesBlock.classList.add("hidden");
    quantityFields.replaceChildren();
    return;
  }

  quantitiesBlock.classList.remove("hidden");
  const frag = document.createDocumentFragment();
  for (const unit of units) {
    const id = `qty-${unit.replace(/\W+/g, "-")}`;
    const wrap = document.createElement("div");
    wrap.innerHTML =
      `<label for="${id}" class="text-xs text-ink-600">${escape(unitLabel(unit))}</label>` +
      `<input id="${id}" type="number" min="0" step="any" value="0" class="field mt-1 w-full" data-unit="${escape(unit)}" />`;
    frag.append(wrap);
  }
  quantityFields.replaceChildren(frag);
}

/* ---------------------------------------------------------------- calculation */

/* ------------------------------------------------------------ origin combobox */

/**
 * 197 origins is too many for a plain select, and the names people reach for do
 * not match the list ("South Korea" against ISO's "Korea, South"). This is a
 * filtered combobox over the generated country table: type to narrow, arrows
 * and Enter to choose, and the selection is held as an ISO code rather than the
 * text in the box so a half-typed name can never be mistaken for a country.
 */
let countries: Country[] = [];
let countryByIso = new Map<string, Country>();
let selectedCountry: Country | undefined;
let highlighted = -1;

void loadCountries().then((list) => {
  countries = list;
  countryByIso = new Map(list.map((c) => [c.iso, c]));
  selectedCountry = countryByIso.get("CN") ?? list[0];
  if (selectedCountry) countryInput.value = selectedCountry.name;
  if (selected) {
    refreshRemedies();
    render();
  }
});

function countryMatches(query: string): Country[] {
  const q = query.trim().toLowerCase();
  if (!q) return countries;
  const starts = countries.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = countries.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || c.iso.toLowerCase() === q),
  );
  return [...starts, ...contains];
}

function openCountryList(query: string): void {
  const matches = countryMatches(query).slice(0, 60);
  highlighted = -1;
  countryList.innerHTML = matches
    .map(
      (c, i) =>
        `<li class="combo-option" role="option" id="country-opt-${i}" aria-selected="false" data-iso="${escape(c.iso)}">` +
        `<span>${escape(c.name)}</span>` +
        `<span class="combo-tag" data-col2="${Boolean(c.column2)}">${
          c.column2 ? "Column 2" : c.programs.filter((p) => !["C", "K", "L", "B"].includes(p)).join(" ") || ""
        }</span></li>`,
    )
    .join("");
  countryList.hidden = matches.length === 0;
  countryInput.setAttribute("aria-expanded", String(!countryList.hidden));
}

function closeCountryList(): void {
  countryList.hidden = true;
  countryInput.setAttribute("aria-expanded", "false");
  highlighted = -1;
}

function highlight(index: number): void {
  const options = [...countryList.querySelectorAll<HTMLElement>(".combo-option")];
  if (options.length === 0) return;
  highlighted = (index + options.length) % options.length;
  options.forEach((o, i) => o.setAttribute("aria-selected", String(i === highlighted)));
  options[highlighted]!.scrollIntoView({ block: "nearest" });
}

function chooseCountry(iso: string): void {
  const country = countryByIso.get(iso);
  if (!country) return;
  selectedCountry = country;
  countryInput.value = country.name;
  closeCountryList();
  refreshRemedies();
  render();
}

countryInput.addEventListener("input", () => openCountryList(countryInput.value));
countryInput.addEventListener("focus", () => openCountryList(""));
countryInput.addEventListener("blur", () => {
  // Restore the last valid selection; a half-typed name is not a country.
  window.setTimeout(() => {
    if (selectedCountry) countryInput.value = selectedCountry.name;
    closeCountryList();
  }, 120);
});
countryInput.addEventListener("keydown", (event) => {
  if (countryList.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    openCountryList(countryInput.value);
    return;
  }
  if (event.key === "ArrowDown") { event.preventDefault(); highlight(highlighted + 1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); highlight(highlighted - 1); }
  else if (event.key === "Enter") {
    const options = [...countryList.querySelectorAll<HTMLElement>(".combo-option")];
    const pick = options[highlighted] ?? options[0];
    if (pick?.dataset["iso"]) { event.preventDefault(); chooseCountry(pick.dataset["iso"]); }
  } else if (event.key === "Escape") closeCountryList();
});
countryList.addEventListener("mousedown", (event) => {
  const li = (event.target as Element).closest<HTMLElement>(".combo-option");
  if (li?.dataset["iso"]) { event.preventDefault(); chooseCountry(li.dataset["iso"]); }
});

function render(): void {
  if (!selected) return;

  const country = selectedCountry;
  if (!country) return;

  const quantities: Record<string, number> = {};
  for (const input of quantityFields.querySelectorAll<HTMLInputElement>("input[data-unit]")) {
    quantities[input.dataset["unit"]!] = Number.parseFloat(input.value) || 0;
  }

  const mode = (form.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "ocean") as Mode;
  const customsValue = Math.max(Number.parseFloat(valueInput.value) || 0, 0);

  output.innerHTML = renderOutput({
    result: calculate({
      entry: selected,
      country,
      customsValue,
      quantities,
      mode,
      remedies: remedyMatches,
      appliedHeadings: panel.applied,
      chapter98: chapter98Input.checked,
    }),
    customsValue,
    matches: remedyMatches,
    applied: panel.applied,
    expanded: panel.expanded,
    remedyError,
  });
}



form.addEventListener("input", render);
form.addEventListener("change", render);
// The output panel is replaced wholesale on each render, so the remedy toggles
// are handled by delegation rather than per-element listeners.
output.addEventListener(
  "toggle",
  (event) => {
    const details = event.target as HTMLDetailsElement;
    const heading = details.dataset?.["for"];
    if (!heading) return;
    panel = toggleDisclosure(panel, heading, details.open);
  },
  true,
);

output.addEventListener("change", (event) => {
  const box = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-heading]");
  if (!box) return;
  const heading = box.dataset["heading"]!;
  const owner = box.closest<HTMLDetailsElement>("details.remedy-exempt")?.dataset["for"];
  panel = toggleChecked(panel, heading, box.checked, owner);
  render();
});

/* Deep-link support: /?code=6109.10.00.12 opens straight to a line. */
const initial = new URLSearchParams(location.search).get("code");
if (initial) {
  searchInput.value = initial;
  void runSearch().then(() => select(initial));
}
