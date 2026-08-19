/**
 * UI wiring.
 *
 * One module, no framework: the app has a single screen and one piece of state
 * worth the name (the selected line), so a framework would be more machinery
 * than the problem needs. Rendering is a full redraw of the output panel on
 * every input change, which at this size is cheaper than reconciling.
 */
import { search, getEntry, loadMeta, loadRemedies, type Entry, type Hit } from "./lib/hts.ts";
import { parseRate, parseSpecial, requiredUnits, unitLabel } from "./lib/rates.ts";
import { calculate, type CalcResult, type Mode } from "./lib/calc.ts";
import { matchRemedies, type RemedyData, type RemedyMatch } from "./lib/remedies.ts";
import { COUNTRIES, COUNTRY_BY_ISO, PROGRAMS, AS_OF } from "./lib/programs.ts";

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const percent = (n: number): string => `${(n * 100).toFixed(2)}%`;
const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);

const searchInput = $<HTMLInputElement>("#search-input");
const leafOnly = $<HTMLInputElement>("#leaf-only");
const resultsList = $<HTMLUListElement>("[data-results]");
const resultCount = $("[data-result-count]");
const searchEmpty = $("[data-search-empty]");
const placeholder = $("[data-placeholder]");
const detail = $("[data-detail]");
const form = $<HTMLFormElement>("[data-form]");
const countrySelect = $<HTMLSelectElement>("#country");
const valueInput = $<HTMLInputElement>("#value");
const quantitiesBlock = $("[data-quantities]");
const quantityFields = $("[data-quantity-fields]");
const output = $("[data-output]");

let selected: Entry | undefined;
let remedyData: RemedyData | undefined;
let remedyMatches: RemedyMatch[] = [];
/** Headings the user has switched on. Rebuilt from confidence on each change. */
let appliedHeadings = new Set<string>();

void loadRemedies().then((data) => {
  remedyData = data;
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
  const country = COUNTRY_BY_ISO.get(countrySelect.value);
  if (!remedyData || !selected || !country) {
    remedyMatches = [];
    appliedHeadings = new Set();
    return;
  }
  remedyMatches = matchRemedies(remedyData, selected.code, country);
  appliedHeadings = new Set(
    remedyMatches.filter((m) => m.confidence === "confirmed").map((m) => m.remedy.heading),
  );
}

/* ---------------------------------------------------------------- provenance */

void loadMeta().then((meta) => {
  const fetched = new Date(meta.fetchedAt);
  const stamp = fetched.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  $("[data-provenance]").textContent = `${meta.entries.toLocaleString("en-US")} lines · USITC data retrieved ${stamp}`;
  $("[data-footer-provenance]").innerHTML =
    `Tariff data retrieved from the <strong>${escape(meta.source)}</strong> on ${escape(stamp)} ` +
    `(${meta.rows.toLocaleString("en-US")} rows, ${meta.entries.toLocaleString("en-US")} priceable lines) via ` +
    `<code>${escape(meta.endpoint)}</code>. The schedule is revised several times a year and this snapshot ` +
    `is refreshed by re-running the project's data script. Trade programme membership and fee amounts are ` +
    `stated as of ${escape(AS_OF)}.`;
});

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

function renderSpecial(special: string): string {
  const clauses = parseSpecial(special);
  if (clauses.length === 0) return escape(special || "—");
  return clauses
    .map((clause) => {
      const names = clause.codes
        .map((c) => PROGRAMS[c]?.name ?? c)
        .join(", ");
      return (
        `<div class="mb-1"><span${/^free$/i.test(clause.rateText) ? ' style="color:var(--color-free);font-weight:600"' : ""}>` +
        `${escape(clause.rateText)}</span> ` +
        `<span class="text-ink-400">(${escape(clause.codes.join(", "))})</span>` +
        `<div class="text-ink-400" style="font-size:0.625rem" title="${escape(names)}">${escape(names.slice(0, 110))}${names.length > 110 ? "…" : ""}</div></div>`
      );
    })
    .join("");
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

for (const country of COUNTRIES) {
  const option = document.createElement("option");
  option.value = country.iso;
  option.textContent = country.column2 ? `${country.name} — Column 2` : country.name;
  countrySelect.append(option);
}
countrySelect.value = "CN";

function render(): void {
  if (!selected) return;

  const country = COUNTRY_BY_ISO.get(countrySelect.value);
  if (!country) return;

  const quantities: Record<string, number> = {};
  for (const input of quantityFields.querySelectorAll<HTMLInputElement>("input[data-unit]")) {
    quantities[input.dataset["unit"]!] = Number.parseFloat(input.value) || 0;
  }

  const mode = (form.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "ocean") as Mode;
  const customsValue = Math.max(Number.parseFloat(valueInput.value) || 0, 0);

  output.innerHTML = renderOutput(
    calculate({
      entry: selected,
      country,
      customsValue,
      quantities,
      mode,
      remedies: remedyMatches,
      appliedHeadings,
    }),
    customsValue,
  );
}

/**
 * The Chapter 99 band of the ledger.
 *
 * Every heading that reaches these goods is listed, whether or not it is
 * applied, because the ones that are switched off are exactly the ones a user
 * needs to see — a silently omitted 25% is indistinguishable from no duty.
 * Confirmed matches are on by default; matches whose country scope could not be
 * read from the notes are off, with the reason shown.
 */
function renderRemedies(customsValue: number): string {
  if (remedyMatches.length === 0) return "";

  const rows = remedyMatches
    .map((match) => {
      const on = appliedHeadings.has(match.remedy.heading);
      const amount = customsValue * match.remedy.uplift;
      const uplift =
        match.remedy.uplift === 0 ? "no additional duty" : `+${(match.remedy.uplift * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
      const notes = match.remedy.noteRefs.length
        ? `U.S. note ${match.remedy.noteRefs.join(", ")}`
        : "";
      return (
        `<label class="remedy${on ? " remedy-on" : ""}">` +
        `<input type="checkbox" data-heading="${escape(match.remedy.heading)}"${on ? " checked" : ""} />` +
        `<span class="remedy-body">` +
        `<span class="remedy-head"><span class="remedy-code">${escape(match.remedy.heading)}</span>` +
        `<span class="remedy-uplift">${escape(uplift)}</span>` +
        (match.confidence === "possible" ? `<span class="remedy-flag">verify</span>` : "") +
        `</span>` +
        `<span class="remedy-desc">${escape(match.remedy.description.slice(0, 190))}${match.remedy.description.length > 190 ? "…" : ""}</span>` +
        `<span class="remedy-reason">${escape(match.reason)}${notes ? ` · ${escape(notes)}` : ""}</span>` +
        `</span>` +
        `<span class="remedy-amount">${on ? money(amount) : "—"}</span>` +
        `</label>`
      );
    })
    .join("");

  return (
    `<div class="remedy-block">` +
    `<p class="label">Additional duties · Chapter 99</p>` +
    `<p class="hint">Section 301, Section 232 and IEEPA duties are separate headings declared alongside the classification, and they stack on the rate above. Switch a heading off to exclude it.</p>` +
    `<div class="mt-2">${rows}</div></div>`
  );
}

function renderOutput(result: CalcResult, customsValue: number): string {
  const tone =
    result.column === "column2" ? "remedy" : result.column === "special" ? "free" : "ink-600";

  const chargeRow = (charge: { label: string; amount: number; formula: string }): string =>
    `<div class="charge"><div class="charge-label">${escape(charge.label)}</div>` +
    `<div class="charge-amount">${money(charge.amount)}</div>` +
    `<div class="charge-formula">${escape(charge.formula)}</div></div>`;

  const dutyCharges = result.charges.filter((c) => c.kind === "duty").map(chargeRow).join("");
  const feeCharges = result.charges.filter((c) => c.kind === "fee").map(chargeRow).join("");
  const remedySection = renderRemedies(customsValue);

  const notices = result.notices
    .map(
      (notice) =>
        `<div class="notice notice-${notice.tone}"><p class="notice-title">${escape(notice.title)}</p>` +
        `<p>${escape(notice.body)}</p></div>`,
    )
    .join("");

  const uncomputed = result.dutyTotal === null;
  const savings =
    result.column === "special" && result.generalDuty !== null && result.dutyTotal !== null
      ? result.generalDuty - result.dutyTotal
      : null;

  return `
    <div class="panel p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-3">
        <div>
          <p class="label">Rate applied</p>
          <p class="mt-1 text-sm font-semibold" style="color:var(--color-${tone})">
            ${escape(result.columnLabel)}${result.claimedCode ? ` · code ${escape(result.claimedCode)}` : ""}
          </p>
        </div>
        <p class="font-mono text-sm">${escape(result.rate.text || "—")}</p>
      </div>

      <div class="mt-2">${dutyCharges}</div>
      ${remedySection}
      <div>${feeCharges}</div>

      <div class="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-t-2 border-ink pt-3">
        <div>
          <p class="label">Total duty and fees</p>
          ${
            uncomputed
              ? `<p class="mt-1 text-xs text-ink-500">Duty not calculated — see the notes below.</p>`
              : `<p class="mt-1 text-xs text-ink-500">
                   ${money(result.dutyTotal!)} duty + ${money(result.feeTotal)} fees
                   on ${money(customsValue)} of goods${
                     result.remedyRate > 0
                       ? ` · ${escape(result.rate.text)} base + ${(result.remedyRate * 100).toFixed(0)}% Chapter 99`
                       : ""
                   }
                 </p>`
          }
        </div>
        <div class="text-right">
          <p class="font-mono text-2xl font-semibold">
            ${uncomputed ? `${money(result.feeTotal)}+` : money(result.grandTotal!)}
          </p>
          ${
            result.effectiveRate !== null
              ? `<p class="text-xs text-ink-500">${percent(result.effectiveRate)} of customs value</p>`
              : `<p class="text-xs text-ink-500">fees only</p>`
          }
        </div>
      </div>

      ${
        savings !== null && savings > 0
          ? `<p class="mt-3 rounded p-2 text-xs" style="background:var(--color-free-bg);color:var(--color-free)">
               The preference saves ${money(savings)} against the Column 1 General duty of ${money(result.generalDuty!)},
               provided the origin claim is supported.
             </p>`
          : ""
      }
    </div>

    <div class="mt-4 space-y-2">${notices}</div>
  `;
}

form.addEventListener("input", render);
form.addEventListener("change", render);
countrySelect.addEventListener("change", () => {
  refreshRemedies();
  render();
});

// The output panel is replaced wholesale on each render, so the remedy toggles
// are handled by delegation rather than per-element listeners.
output.addEventListener("change", (event) => {
  const box = (event.target as HTMLElement).closest<HTMLInputElement>("input[data-heading]");
  if (!box) return;
  const heading = box.dataset["heading"]!;
  if (box.checked) appliedHeadings.add(heading);
  else appliedHeadings.delete(heading);
  render();
});

/* Deep-link support: /?code=6109.10.00.12 opens straight to a line. */
const initial = new URLSearchParams(location.search).get("code");
if (initial) {
  searchInput.value = initial;
  void runSearch().then(() => select(initial));
}
