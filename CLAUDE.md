# tariff-calculator — working notes

Static HTS duty calculator built on USITC data. See `README.md` for the stack,
the scripts, and the reasoning behind the build-time data fetch.

## Non-obvious things

- **The USITC API cannot be called from the browser.** `hts.usitc.gov/reststop`
  allowlists only its own origin and returns `403 Invalid CORS request` to
  everything else. `Origin` is a forbidden header name, so this is not
  workaroundable from page JavaScript. Do not "fix" this by adding a client-side
  fetch; it will fail in every browser. The API call belongs in
  `scripts/fetch-hts.ts`, which runs in Node.
- **`public/data/` is generated and gitignored.** A fresh clone shows an empty
  app until `npm run data` runs. Anything that consumes the data must handle its
  absence rather than assume it.
- **10-digit lines have blank rate cells.** They inherit from the 8-digit
  subheading. Filtering the export to rows that have a rate throws away every
  code an importer actually files. `buildEntries()` handles the inheritance and
  records `rateFrom`; do not reintroduce a naive rate filter.
- **Leaf detection cannot use `indent`.** A superior row between two statistical
  suffixes pushes the next line deeper without making the previous one a parent.
  Leaves are determined by code-prefix nesting instead.
- **Rate text is prose and about 3.7% of it is not computable.** `parseRate()`
  returns `computable: false` for those and the UI shows the published text.
  Never widen the parser by guessing at a construction — if a form cannot be
  evaluated exactly, it must stay uncomputed.
- **Qualified weight units stay distinct.** `kg on drained weight` and
  `kg on lead content` must not normalize to `kg`; the duty is owed on that
  specific basis and folding them together overstates the duty.
- **Fee constants are fiscal-year specific.** `FEES` in `src/lib/calc.ts` is
  FY2026. CBP adjusts the COBRA fees for inflation every October — check
  `federalregister.gov` for the current CBP Dec. notice rather than carrying the
  old figures forward.

- **`BASE_PATH` is what makes a project page work.** Vite applies it to asset
  URLs and `src/lib/hts.ts` reads the resulting `import.meta.env.BASE_URL` when
  fetching `data/*.json`. Hardcoding a leading `/` on any data path breaks the
  deployed site while still working locally, which is the worst failure mode —
  it passes every local check.
- **The daily deploy re-fetches rather than committing data.** Do not "fix" the
  gitignored `public/data/` by committing it; the workflow regenerates it on
  every run and a daily 13 MB commit would wreck the repository's history.
- **A failed fetch must fail the build.** `fetchSchedule()` retries four times
  and `assertPlausible()` rejects a suspiciously small response. Both exist so
  an unattended run cannot replace a good deployment with a broken snapshot.
  Do not add a fallback that publishes partial data.
- **Scheduled workflows only run from the default branch** and GitHub disables
  them after 60 days of repository inactivity. A silently-stopped morning
  refresh is the expected failure here, not a bug.

- **Section 301 coverage comes from the official "China Tariffs" table, not the
  notes.** It is a clean two-column mapping in the same release API and is
  authoritative. The note parser still runs over those headings purely as a
  cross-check; do not make it the source of truth again. Section 232 and IEEPA
  have no such table and still depend on the note parser.
- **Suspended provisions must be excluded.** A heading stays in the schedule
  after suspension, marked only by "[Compiler's note: provision suspended.]",
  and its coverage table is still printed. 9903.88.16 (+15%) and 9903.01.63
  (+34%) are currently suspended. Applying one adds duty that is not owed.
- **Chapter 99 coverage is anchored to named headings, not subdivision labels.**
  `parseHeadingCoverage()` only attributes a code table to a heading the
  introducing prose actually names ("Heading 9903.88.03 applies to..." or "the
  rates of duty set forth in headings ... apply to"). Going by subdivision label
  merges unrelated tables across page breaks. Do not loosen this to raise
  coverage — a wrongly applied heading adds 25% silently.
- **Scope must come from a subject-position sentence.** One sentence often
  introduces several headings sharing a coverage list but not a country; note
  37(f) names both 9903.76.03 (most origins) and 9903.76.20 (UK only). Reading
  scope from a listing sentence gave the UK heading worldwide scope and applied
  10% to everything. `parseHeadingScopes()` prefers "heading X applies/provides"
  and refuses to fall back once such a sentence exists.
- **`pdftotext` is a hard dependency of `npm run data`** and is not on the
  GitHub runner image; the workflow installs poppler-utils. `-layout` is
  required — without it the note columns interleave and the lists are garbage.
- **Nested subdivisions inherit their parent's heading via the trailing colon,
  not indentation.** "(s) Heading 9903.88.15 applies to:" and its child "(i)"
  are both indented twelve spaces, so indent-based nesting silently drops the
  heading and the codes leak to whichever heading was seen last. That leak
  charged cotton T-shirts 25% (List 2) instead of 7.5% (List 4A).
- **Regression cases live in the README table.** 9403.60.80.93 must be 50% from
  China, 25% from Vietnam, 0% from Germany and the UK; 6109.10.00.12 must be
  24.47% from China; 8703.80.00.20 must be 102.97% from China. Any change to the note parsing has to keep those, and they
  are the cases the client checks.

## Content rules

- The tariff data is real and current as of the retrieval date shown in the
  footer, so it must never be described as demonstration or sample data — but it
  is a snapshot, and the retrieval date has to stay visible.
- Programme membership in `src/lib/programs.ts` is hand-maintained and dated by
  `AS_OF`. Update that constant whenever the table changes.
- Lapsed programmes (GSP, ATPA, NAFTA codes) stay listed with their `lapsed`
  note rather than being deleted. They still appear in the schedule's Special
  column, and silently omitting them would make the app look like it had missed
  a preference.
- No claim anywhere that the app provides customs or legal advice, or that it
  determines classification. The disclaimers in the footer stay.

- **Blanket headings must never auto-apply.** Several reach the same origin and
  are alternatives, not addends; summing them gave Canada 165%. They are shown
  with confidence "possible" and their carve-outs offered as claimable
  exemptions.
- **List vs blanket is decided by whether a coverage list exists**, never by the
  description. Every Section 301 heading reads "articles the product of China"
  and would classify as blanket; doing so stacked eighteen headings into a 618%
  duty.

- **Never grant goods-based programmes by origin.** C, K, L and B depend on
  what the goods are. Granting them per country made Chinese EVs and lithium
  batteries duty-free at the base rate, because the Automotive Products code
  took 2.5% to Free. `npm run check` catches this exact regression.
- **The country table is generated**, not a constant. `public/data/countries.json`
  is built from the General Notes plus the curated memberships in
  `scripts/parse-notes.ts`, and loaded at runtime like the other data.

- **Rendering lives in `src/ui/render.ts` and must stay pure.** State in, HTML
  string out, no `document` and no module state. That is what makes the markup
  testable without a browser, and it is where the unclosed-`<div>` and
  truncation bugs lived.
- **Applied and expanded are separate sets** (`src/ui/panel-state.ts`). Deriving
  the disclosure's open state from whether an exemption was claimed collapsed
  the list when the user unchecked the last one.

## Verifying changes

```bash
npm test && npm run typecheck && npm run check && npm run snapshot && npm run build
```

`npm test` needs no data and is the fastest signal — put new parser cases there
rather than discovering them by rebuilding the dataset. `npm run check` and
`npm run snapshot` both need `npm run data` to have run.

`npm run check` is the regression suite in `scripts/check-regressions.ts`. It
needs `npm run data` to have run first.
