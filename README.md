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
| `npm test` | Unit tests — parsers and the duty stack, no data needed |
| `npm run check` | Duty regression cases with externally-known answers (needs `npm run data`) |
| `npm run snapshot` | Structural snapshot; `-- --update` to re-record |
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

The workflow gates the deploy in this order: unit tests and typecheck first
(neither needs the dataset, so a broken parser fails in seconds rather than
after two PDF downloads), then the data fetch, then the regression cases and the
snapshot, then the build.

The data-dependent checks **block a push but only warn on the nightly run**, and
the difference matters. On a schedule the code is byte-identical to the last
successful deploy, so a failure can only mean USITC changed something — and
blocking would keep stale duty rates live at exactly the moment tariffs moved.
On a push the code did change, so a failure means it broke and the deploy stops.

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

The same line from Vietnam is 25% (no Section 301). Germany is excluded from the
cabinet duty by note 37(e) but covered by 9903.76.22 at a flat 15% under note
37(j), which lists the EU member states by name.

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

### List rules and blanket rules

Chapter 99 headings come in two shapes and need opposite handling.

**List rules** name the classifications they cover — Section 301 and the
Section 232 headings. When one matches the code and the origin it is applied
automatically.

**Blanket rules** cover an origin wholesale and carve exceptions back out:
"Except for products described in headings 9903.01.11 … articles the product of
Canada". The IEEPA actions work this way, and they are 169 of the 231
duty-imposing headings. A list-only model finds no list and reports nothing,
which is why Canada came back clean when it is anything but.

Where the notes resolve the overlap, they are believed. Heading 9903.01.10
reaches Canadian goods "other than products described in headings … 9903.76.01,
9903.76.02 and 9903.76.03", so a Canadian kitchen cabinet that already matches
the Section 232 cabinet duty drops the 35% blanket instead of showing both.
Those displacement rules live only in the notes — a heading's own description
carries a shorter list — and are parsed by `parseHeadingExclusions`.

Only one heading currently states such a rule explicitly, which is the honest
limit here rather than a parser shortcoming: the notes mostly do not say which
of several overlapping provisions governs.

Blanket headings are otherwise surfaced but never applied automatically. Several usually
reach the same origin at once — Canada matches a 35%, a 40% and two
transshipment provisions — and they are alternatives keyed to dates and CBP
determinations rather than duties that sum. Adding them produced 165% for goods
that mostly owe nothing once USMCA is claimed.

Their carve-outs are offered as claimable exemptions. `9903.01.14` exempts goods
entered free under General Note 11, which is USMCA, and covers most Canadian and
Mexican shipments. Claiming one waives the duty entirely.

Deciding list vs blanket cannot be done from the description. Every Section 301
heading reads "articles the product of China", which looks blanket, but each has
a coverage list; treating them as blanket applied eighteen at once and produced
a 618% duty. Having a list is what makes a heading list-based.

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

`npm run check` runs these. Every one was added because it caught a real defect.

| Line | Origin | Base | Chapter 99 | Effective |
| --- | --- | --- | --- | ---: |
| `9403.60.80.93` | China | Free | `9903.76.03` +25%, `9903.88.03` +25% | 50.47% |
| `9403.60.80.93` | Vietnam | Free | `9903.76.03` +25% | 25.47% |
| `9403.60.80.93` | Germany | Free | `9903.76.22` flat 15% | 15.47% |
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
- **Effective dates.** The API declares an `effectivePeriod` field but never
  populates it, and the notes do not tie headings to dates in any parseable
  form — only 13 heading descriptions state one. Every heading is therefore
  treated as currently in force, which is wrong for an entry date in the past
  and for provisions that have since been superseded.

## Countries

All 197 ISO countries are offered as origins, not a curated shortlist. A country
with no preference programme still has a correct answer — Column 1 General — so
omitting it buys nothing. Only membership needs curation.

Membership comes from the General Notes where they publish a roster: GSP
(GN 4), CBERA (GN 7) and AGOA (GN 16), fetched as PDFs from the same release
endpoint and matched to ISO codes through a name index. Where the note is
rules-of-origin text rather than a list — USMCA, CAFTA-DR, CBTPA — membership is
stated in `scripts/parse-notes.ts`, as are the single-country agreements, where
the code *is* the country.

Goods-based programmes (Civil Aircraft, Pharmaceutical, dye intermediates, the
Automotive Products Trade Act) are deliberately **not** granted by origin. They
turn on what the goods are, and granting them by country makes every line that
lists one duty-free for everybody — it quietly zeroed the base duty on Chinese
EVs and lithium batteries during development.

The origin picker is a filtered combobox rather than a select: 197 entries is
too many to scan, and people reach for "South Korea" when ISO says "Korea,
South".

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
