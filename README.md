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

## Chapter 99 additional duties

Section 301, Section 232 and the IEEPA actions are not rates on an ordinary
tariff line. They are separate Chapter 99 headings whose rate text reads
"The duty provided in the applicable subheading + 25%", declared as an extra
line on the entry and stacking on Column 1. Reporting only the ordinary rate
understates duty on covered goods by 25 or 50 points.

The worked example this was built against:

| Component | Rate |
| --- | ---: |
| `9403.60.80.93` wooden furniture, base rate | Free |
| `9903.76.03` Section 232, kitchen cabinets | +25% |
| `9903.88.03` Section 301 List 3, China | +25% |
| **Total from China** | **50%** |

The same line from Vietnam is 25% (no Section 301), and from Germany or the UK
it is 0% — note 37(e) excludes them from the cabinet duty.

`exportList` publishes the headings but not their coverage. That comes from two
documents in the same release API, both fetched by `scripts/parse-ch99.ts` and
converted with `pdftotext -layout`.

**Section 301 uses the official table.** USITC publishes "China Tariffs", a
purpose-built two-column list of every covered subheading and the Chapter 99
heading that imposes the duty:

```
0101.21.00                       9903.88.15
8507.60.00                       9903.91.06
```

10,391 rows, parsed with one regex. This is authoritative and replaces
note-mining for Section 301 entirely.

**Section 232 and the IEEPA actions come from the Chapter 99 U.S. Notes**, which
have no equivalent table, so their coverage lists and country scope are still
mined from prose.

The note parser still runs over the Section 301 notes and its output is compared
against the official table on every build. It is no longer the source of truth,
but a contradiction between the two is the only signal that would catch either
document being reformatted, so disagreements are reported.

**Suspended provisions are dropped.** The schedule leaves a heading in place
after it is suspended and marks it only in a compiler's note. `9903.88.16` is
the old List 4B at 15%, which never came into force, and `9903.01.63` was
suspended by Federal Register notice. Their coverage tables are still printed in
the notes, so a parser reading the notes will pick them up and add duty that is
not owed.

**Coverage is partial, and the UI says so.** Section 301 is complete, from the
official table. Section 232 and IEEPA coverage is whatever the note parser could
attribute with confidence. Country scope was readable for 456 of 560 headings. Country scope was readable for 456 of 560 headings. Where a
heading's coverage is known but its scope is not, it is listed switched **off**
with the reason shown. Where nothing matches at all, the result carries an
explicit warning that absence is not proof — because for this data it isn't.

Attribution is anchored to the heading a subdivision *names*, never to the
subdivision label. Note 20 runs for thousands of lines, its tables span page
breaks, and its markers sit pages away from the tables they govern, so
"whichever subdivision was seen last" merges unrelated lists — one label
absorbed 2,958 codes spanning several.

The notes also nest, and the heading is named one level above the table:

```
(s)  Heading 9903.88.15 applies to:
(i)    all products of China classified in the following 8-digit subheadings:
             ... 6109.10.00 ...
```

Indentation cannot tell parent from sibling here — both markers are indented
twelve spaces — so the trailing colon is the signal. A block that names a
heading and ends on a colon is introducing children, and following blocks
inherit that heading until one names its own or a new note begins. Getting this
wrong is not academic: an earlier attempt leaked the apparel table onto an
industrial-goods heading and charged cotton T-shirts 25% instead of 7.5%.

The bias throughout is deliberate. A wrongly applied heading silently adds duty
to goods that never carried it, which is worse than missing one.

### Regression cases

These are the cases to re-check after any change to the note parsing.

| Line | Origin | Base | Chapter 99 | Effective |
| --- | --- | --- | --- | ---: |
| `9403.60.80.93` | China | Free | `9903.76.03` +25%, `9903.88.03` +25% | 50.47% |
| `9403.60.80.93` | Vietnam | Free | `9903.76.03` +25% | 25.47% |
| `9403.60.80.93` | Germany | Free | none (excluded) | 0.47% |
| `6109.10.00.12` | China | 16.5% | `9903.88.15` +7.5% | 24.47% |
| `6109.10.00.12` | Korea | Free | none | 0.47% |
| `6109.10.00.12` | Russia | 90% (Col 2) | none | 90.47% |
| `8507.60.00.90` | China | 3.4% | `9903.91.06` +25% | 28.87% |
| `8703.80.00.20` | China | 2.5% | `9903.91.03` +100% | 102.97% |
| `8541.10.00.80` | China | Free | `9903.91.05` +50% | 50.47% |

## What it does not model

- **AD/CVD.** Antidumping and countervailing deposit rates are set per producer
  and routinely exceed the ordinary duty by an order of magnitude. Nothing in the
  tariff schedule can derive one, so the calculator flags the risk instead of
  guessing.
- **Chapter 99 remedies beyond the extracted coverage.** See above: headings
  whose coverage lists could not be attributed are simply absent, and a line
  showing no additional duties has not been proven free of them.
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
