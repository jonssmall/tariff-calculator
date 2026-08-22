/**
 * Pure rendering: state in, HTML string out.
 *
 * Separated from `main.ts` so it can be tested without a DOM. The bugs that got
 * through every other layer lived here — an unclosed `<div>` that nested each
 * remedy row inside the last one, exclusion text truncated for no reason, a
 * disclosure that collapsed itself when the user unchecked a box. None of them
 * involved the calculation, so no amount of duty testing would have found them,
 * and none needed a browser to detect either: parsing the returned string is
 * enough.
 *
 * Nothing here touches `document`, reads module state, or has side effects.
 */
import type { CalcResult } from "../lib/calc.ts";
import type { RemedyMatch } from "../lib/remedies.ts";
import { parseSpecial } from "../lib/rates.ts";
import { PROGRAMS } from "../lib/programs.ts";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);

export const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const percent = (n: number): string => `${(n * 100).toFixed(2)}%`;

/**
 * A heading's description without its exclusion citations.
 *
 * Section 301 headings open with a list of every carve-out — "Except as
 * provided in headings 9903.88.13, 9903.88.18, … , articles the product of
 * China" — which is 150 characters of heading numbers before the sentence says
 * anything. The carve-outs are listed separately as claimable exemptions, so
 * repeating them here only buries the description.
 */
export function cleanDescription(text: string): string {
  const trimmed = text
    .replace(
      /^except\s+(?:as\s+provided\s+(?:in|by|for)|for\s+products\s+described\s+in)\s+(?:heading|subheading)s?\s+(?:9903\.\d{2}\.\d{2}[\s,]*(?:or\s+)?)+,?\s*/i,
      "",
    )
    .trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** The Column 1 Special cell, broken into per-programme clauses. */
export function renderSpecial(special: string): string {
  const clauses = parseSpecial(special);
  if (clauses.length === 0) return escapeHtml(special || "—");
  return clauses
    .map((clause) => {
      const names = clause.codes.map((c) => PROGRAMS[c]?.name ?? c).join(", ");
      return (
        `<div class="mb-1"><span${/^free$/i.test(clause.rateText) ? ' style="color:var(--color-free);font-weight:600"' : ""}>` +
        `${escapeHtml(clause.rateText)}</span> ` +
        `<span class="text-ink-400">(${escapeHtml(clause.codes.join(", "))})</span>` +
        `<div class="text-ink-400" style="font-size:0.625rem">${escapeHtml(names)}</div></div>`
      );
    })
    .join("");
}

/** Everything the Chapter 99 band needs in order to draw itself. */
export interface RemedyView {
  matches: RemedyMatch[];
  /** Headings and exemptions the user has switched on. */
  applied: ReadonlySet<string>;
  /** Headings whose exclusion list is expanded, tracked apart from `applied`. */
  expanded: ReadonlySet<string>;
  customsValue: number;
}

/**
 * The Chapter 99 band of the ledger.
 *
 * Every heading that reaches these goods is listed, applied or not, because the
 * ones switched off are exactly the ones a user needs to see — a silently
 * omitted 25% is indistinguishable from no duty.
 */
export function renderRemedies(view: RemedyView): string {
  const { matches, applied, expanded, customsValue } = view;
  if (matches.length === 0) return "";

  /*
   * Reasons shared by several rows are said once, above them.
   *
   * The explanation for a blanket heading is generic and identical on every
   * blanket row — a 321-character paragraph about overlapping provisions. On a
   * phone that was 112 pixels per row and roughly a quarter of the whole band,
   * repeating the same sentences four times. Row-specific reasons ("the notes
   * apply this heading to products of China") stay where they are, because
   * those differ per row and are the point.
   */
  const reasonCounts = new Map<string, number>();
  for (const m of matches) reasonCounts.set(m.reason, (reasonCounts.get(m.reason) ?? 0) + 1);
  const shared = [...reasonCounts.entries()].filter(([, n]) => n > 1).map(([reason]) => reason);
  const isShared = new Set(shared);

  const rows = matches
    .map((match) => {
      const on = applied.has(match.remedy.heading);
      const amount = customsValue * match.remedy.uplift;
      const uplift =
        match.remedy.uplift === 0
          ? "no additional duty"
          : `+${(match.remedy.uplift * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
      const notes = match.remedy.noteRefs.length ? `U.S. note ${match.remedy.noteRefs.join(", ")}` : "";
      // The cheapest claimed carve-out wins, mirroring the calculation. Not
      // every carve-out is an exemption — some substitute a lower rate — so
      // this is the provision itself, not a boolean.
      const claimed = match.exemptions
        .filter((e) => applied.has(e.heading))
        .sort((a, b) => a.uplift - b.uplift)[0];
      const description = cleanDescription(match.remedy.description);

      /*
       * Exemptions collapse behind a disclosure, and its open state comes from
       * `expanded` rather than from whether anything is claimed. Deriving it
       * from the claim meant unchecking the last exemption collapsed the list
       * the user was working in.
       */
      const exemptions = match.exemptions.length
        ? `<details class="remedy-exempt" data-for="${escapeHtml(match.remedy.heading)}"${
            expanded.has(match.remedy.heading) || claimed ? " open" : ""
          }>` +
          `<summary>${match.exemptions.length} product exclusion${match.exemptions.length === 1 ? "" : "s"} may remove this duty</summary>` +
          `<div class="remedy-exempt-list">` +
          match.exemptions
            .map(
              (e) =>
                `<label><input type="checkbox" data-heading="${escapeHtml(e.heading)}"${
                  applied.has(e.heading) ? " checked" : ""
                } /> <span><span class="remedy-code">${escapeHtml(e.heading)}</span> ` +
                `<span class="remedy-uplift">${e.uplift === 0 ? "free" : `+${(e.uplift * 100).toFixed(2).replace(/\.?0+$/, "")}%`}</span> ` +
                `${escapeHtml(cleanDescription(e.description))}</span></label>`,
            )
            .join("") +
          `</div></details>`
        : "";

      return (
        `<div class="remedy${on ? " remedy-on" : ""}">` +
        `<input type="checkbox" data-heading="${escapeHtml(match.remedy.heading)}"${on ? " checked" : ""} />` +
        `<span class="remedy-body">` +
        `<span class="remedy-head"><span class="remedy-code">${escapeHtml(match.remedy.heading)}</span>` +
        `<span class="remedy-uplift">${escapeHtml(uplift)}</span>` +
        (match.confidence === "possible" ? `<span class="remedy-flag">verify</span>` : "") +
        `</span>` +
        `<span class="remedy-desc">${escapeHtml(description)}</span>` +
        `<span class="remedy-reason">${isShared.has(match.reason) ? "" : escapeHtml(match.reason)}` +
        `${notes ? `${isShared.has(match.reason) ? "" : " · "}${escapeHtml(notes)}` : ""}` +
        (match.matchedOn === "origin" ? `${notes ? " · " : ""}applies to all goods of this origin` : "") +
        `</span>` +
        exemptions +
        `</span>` +
        `<span class="remedy-amount">${
          on
            ? claimed
              ? claimed.uplift === 0
                ? "exempt"
                : money(customsValue * claimed.uplift)
              : money(amount)
            : "—"
        }</span>` +
        `</div>`
      );
    })
    .join("");

  return (
    `<div class="remedy-block">` +
    `<p class="label">Additional duties · Chapter 99</p>` +
    `<p class="hint">Section 301, Section 232 and IEEPA duties are separate headings declared alongside the classification, and they stack on the rate above. Switch a heading off to exclude it.</p>` +
    shared.map((reason) => `<p class="hint remedy-shared-reason">${escapeHtml(reason)}</p>`).join("") +
    `<div class="mt-2">${rows}</div></div>`
  );
}

export interface OutputView extends RemedyView {
  result: CalcResult;
  /** Set when the Chapter 99 dataset failed to load. */
  remedyError?: string | undefined;
}

/** The whole results panel: charges, Chapter 99 band, total, and notices. */
export function renderOutput(view: OutputView): string {
  const { result, customsValue, remedyError } = view;
  const tone = result.column === "column2" ? "remedy" : result.column === "special" ? "free" : "ink-600";

  const chargeRow = (charge: { label: string; amount: number; formula: string }): string =>
    `<div class="charge"><div class="charge-label">${escapeHtml(charge.label)}</div>` +
    `<div class="charge-amount">${money(charge.amount)}</div>` +
    `<div class="charge-formula">${escapeHtml(charge.formula)}</div></div>`;

  const dutyCharges = result.charges.filter((c) => c.kind === "duty").map(chargeRow).join("");
  const feeCharges = result.charges.filter((c) => c.kind === "fee").map(chargeRow).join("");

  const notices = result.notices
    .map(
      (n) =>
        `<div class="notice notice-${n.tone}"><p class="notice-title">${escapeHtml(n.title)}</p>` +
        `<p>${escapeHtml(n.body)}</p></div>`,
    )
    .join("");

  const uncomputed = result.dutyTotal === null;
  const savings =
    result.column === "special" && result.generalDuty !== null && result.dutyTotal !== null
      ? result.generalDuty - result.dutyTotal
      : null;

  const loadFailure = remedyError
    ? `<div class="notice notice-warn mb-3"><p class="notice-title">Additional duties could not be loaded</p>` +
      `<p>The Chapter 99 dataset failed to load (${escapeHtml(remedyError)}). Section 301, Section 232 and IEEPA duties ` +
      `are <strong>not</strong> included in the figures below, so any total shown here understates the duty owed on ` +
      `covered goods — often by 25 to 100 percentage points. Reload the page; if it persists the deployed data is incomplete.</p></div>`
    : "";

  return `
    ${loadFailure}
    <div class="panel p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule pb-3">
        <div>
          <p class="label">Rate applied</p>
          <p class="mt-1 text-sm font-semibold" style="color:var(--color-${tone})">
            ${escapeHtml(result.columnLabel)}${result.claimedCode ? ` · code ${escapeHtml(result.claimedCode)}` : ""}
          </p>
        </div>
        <p class="font-mono text-sm">${escapeHtml(result.rate.text || "—")}</p>
      </div>

      <div class="mt-2">${dutyCharges}</div>
      ${renderRemedies(view)}
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
                       ? ` · ${escapeHtml(result.rate.text)} base + ${(result.remedyRate * 100).toFixed(0)}% Chapter 99`
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
