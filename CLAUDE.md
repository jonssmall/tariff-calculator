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

## Verifying changes

```bash
npm run typecheck && npm run build
```
