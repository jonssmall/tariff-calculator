# tariff-calculator

A static front-end that looks up a Harmonized Tariff Schedule classification and
calculates the US import duty, merchandise processing fee and harbor maintenance
fee on a shipment, using tariff data from the **USITC HTS REST API**.

## Running it

```bash
nvm use && npm install && npm run data && npm run dev
```

Serves on **http://localhost:8084**. `npm run data` is required before the first
run: it populates `public/data/`, which is not committed.

| Script | What it does |
| --- | --- |
| `npm run data` | Fetch the schedule from USITC and rebuild `public/data/` |
| `npm run dev` | Vite dev server on port 8084 |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` — the only type checker |

## Why the API call happens at build time

The USITC API is unauthenticated and free, but it allowlists exactly one CORS
origin — its own:

| Request origin | Result |
| --- | --- |
| `https://hts.usitc.gov` | `200`, `Access-Control-Allow-Origin` echoed back |
| `http://localhost:8084` | `403 Invalid CORS request` |
| no `Origin` header (Node, curl) | `200` |

`Origin` is a forbidden header name in the Fetch spec, so page JavaScript cannot
set it and no amount of client-side work gets a browser on another host past
that 403. The three ways around it are a build-time snapshot, a server-side
proxy, or a third-party CORS relay. Only the snapshot keeps this a genuinely
static front end with no backend and no third-party dependency, so
`scripts/fetch-hts.ts` calls the API in Node and the app ships the result.

The practical cost is that the data is a snapshot. USITC revises the HTS several
times a year; re-run `npm run data` to refresh, and the footer always shows the
retrieval date so a stale build is visible rather than silent.

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on push to
`master`, on manual dispatch, and on a daily schedule at 09:00 UTC (05:00 US
Eastern in summer, 04:00 in winter).

The scheduled run is what keeps the snapshot current: it re-runs `npm run data`
against USITC, rebuilds, and redeploys. Nothing about this needs a server — the
API call happens on the Actions runner, which is an ordinary Ubuntu VM with no
CORS restriction, and Pages only ever serves the finished static output.

`public/data/` stays gitignored. Committing 13 MB of regenerated JSON every
morning would bloat the repository's history for no benefit, since the snapshot
is reproducible from the API at any time.

If USITC is unreachable, `npm run data` fails after four retries, the build
fails, and the deploy step never runs — the previously published site stays up
rather than being replaced by a broken one. The same guard rejects a response
that parses but is implausibly small.

Two things to know about the schedule:

- GitHub runs scheduled workflows only from the **default branch**, and the
  workflow triggers on `master`. If the default branch is named something else,
  both need changing.
- GitHub **disables scheduled workflows after 60 days without repository
  activity**. On a project that is finished and left alone, the morning refresh
  will eventually stop; re-enable it from the Actions tab.

For a project page the workflow sets `BASE_PATH=/<repo-name>/`, which Vite
applies to asset URLs and which `src/lib/hts.ts` picks up through
`import.meta.env.BASE_URL` when it fetches the data files. A custom domain or a
`<owner>.github.io` repo should leave `BASE_PATH` unset.

## What the data pipeline reconstructs

`exportList` returns the schedule as a flattened outline, and two things have to
be rebuilt from it:

- **Classification paths.** Rows with no HTS number are "superior" text
  (`Men's or boys':`) that qualifies everything nested beneath them. A leaf whose
  own description is `Other` is meaningless without that ancestor chain, so each
  entry stores the full path.
- **Rate inheritance.** Duty rates are legislated at the 8-digit subheading. The
  10-digit statistical suffixes below it carry the reporting units and are the
  codes actually filed on an entry, but their rate cells are blank — `6109.10.00`
  holds `16.5%` while all fifteen `6109.10.00.xx` breakouts show nothing. Each
  line inherits the nearest rate-bearing ancestor's rates and records where they
  came from.

Output is one file per chapter plus a search index whose repeated path segments
are interned into a shared string table, which takes the index from 7.2 MB to
2.4 MB (479 kB gzipped). Chapter files are fetched only when a line is selected.

## Duty rate coverage

Rate cells are prose, not numbers. The parser evaluates `Free`, ad valorem
(`16.5%`), specific (`4.4¢/kg`, `$1.13/m3`) and compound (`9.9¢/kg + 6.4%`)
rates. Across all 25,627 priceable lines:

| Outcome | Lines | Share |
| --- | ---: | ---: |
| Free | 10,020 | 39.1% |
| Calculated | 14,654 | 57.2% |
| Shown as published text | 953 | 3.7% |

The remaining 3.7% are constructions that cannot be resolved from the schedule
alone — Chapter 99 cross-references (`The duty provided in the applicable
subheading + 25%`), ensemble rates, sugar duties that vary by degree, watch
duties apportioned across case, strap and battery. Those are displayed verbatim
and explicitly **not** calculated. A landed-cost figure that silently drops half
of a compound duty is worse than no figure, because it looks authoritative.

Qualified weights are kept distinct rather than folded into kilograms:
`kg on drained weight` and `kg on lead content` each get their own quantity
input, because charging those duties against gross weight would overstate them,
often severely.

## What it does not model

- **AD/CVD.** Antidumping and countervailing deposit rates are set per producer
  and routinely exceed the ordinary duty by an order of magnitude. Nothing in the
  tariff schedule can derive one, so the calculator flags the risk instead of
  guessing.
- **Chapter 99 trade remedies.** Sections 201, 232 and 301 and the IEEPA-based
  actions stack on top of the rates shown. Whether a given line is covered
  depends on annexes that are not in this dataset.
- **Quota provisions.** Where the Special column says `See 9822.04.01` the
  preferential rate applies only within a quantity limit; that is surfaced as a
  notice, not resolved.
- **Informal entries and de minimis**, whose treatment changed materially during
  2025.

## Source boundaries

Duty rates, unit descriptions and special-programme codes come verbatim from
USITC. Programme membership (which countries claim which codes), the CBP user fee
amounts, and the Column 2 country list are maintained by hand in
`src/lib/programs.ts` and `src/lib/calc.ts` — the API publishes the schedule, not
the general notes that define eligibility, and those change by proclamation
rather than on the HTS revision cycle. Fee amounts are FY2026
(CBP Dec. 25-10, effective 1 October 2025) and are re-set by CBP each October.

## Stack

Vite 8, Tailwind 4 (CSS-first `@theme`), TypeScript, vanilla DOM — no framework.
One screen and one piece of real state did not justify one.
