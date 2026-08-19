/**
 * Build-time fetch of the Harmonized Tariff Schedule from the USITC HTS REST API.
 *
 * This runs in Node, not the browser, and that is not an implementation
 * preference — it is forced. hts.usitc.gov/reststop allowlists exactly one
 * CORS origin, its own:
 *
 *   Origin: https://hts.usitc.gov  -> 200, Access-Control-Allow-Origin echoed
 *   Origin: http://localhost:8084  -> 403 "Invalid CORS request"
 *   no Origin header (Node/curl)   -> 200
 *
 * `Origin` is a forbidden header name in the Fetch spec, so page JavaScript
 * cannot spoof its way past that. A browser on any other host is refused. The
 * options are a build-time snapshot, a server-side proxy, or a third-party CORS
 * relay; only the snapshot keeps the deliverable a genuinely static front end,
 * so the API call happens here and the app ships the result.
 *
 * Run `npm run data` to refresh. USITC revises the HTS several times a year.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  fetchChapter99Text,
  fetchSection301Coverage,
  parseCoverageLists,
  parseHeadingScopes,
  parseNoteRefs,
  parseUplift,
  type Scope,
} from "./parse-ch99.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data");
const API = "https://hts.usitc.gov/reststop/exportList";
const RELEASE_API = "https://hts.usitc.gov/reststop/currentRelease";

/** One row exactly as the API returns it. */
interface ApiRow {
  htsno: string;
  indent: string;
  description: string;
  superior: string | null;
  units: string[];
  general: string;
  special: string;
  other: string;
  footnotes: unknown[];
  quotaQuantity: string | null;
  additionalDuties: string | null;
}

/** A line the app can price. */
interface Entry {
  /** Dotted HTS number, e.g. "6109.10.00.10". */
  code: string;
  /** Own description only. */
  desc: string;
  /** Ancestor descriptions, outermost first — the classification path. */
  path: string[];
  /** Reporting units, markup stripped. */
  units: string[];
  /** Column 1 General (MFN) rate text. */
  general: string;
  /** Column 1 Special (preference programs) rate text. */
  special: string;
  /** Column 2 (non-NTR) rate text. */
  other: string;
  /** Ch. 99 additional duties note, when the API carries one. */
  additional?: string;
  /** Set when the rate was inherited: the ancestor code it came from. */
  rateFrom?: string;
  /** True when nothing nests below this line — a real entry code. */
  leaf?: boolean;
}

const stripTags = (s: string): string =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Pull the whole schedule in one request, retrying on transient failure.
 *
 * This runs unattended on a schedule, so a momentary 502 from USITC should not
 * turn into a failed deploy. Retries are limited and backed off; a persistent
 * failure still exits non-zero, which is what keeps a broken snapshot from
 * being published over a good one.
 */
async function fetchSchedule(attempts = 4): Promise<ApiRow[]> {
  const url = `${API}?from=0101&to=9999&format=JSON&styles=true`;
  process.stdout.write(`fetching ${url}\n`);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const started = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`USITC API returned ${res.status} ${res.statusText}`);
      const rows = (await res.json()) as ApiRow[];
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("USITC API returned an empty schedule");
      process.stdout.write(`  ${rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
      return rows;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) break;
      const waitMs = attempt * 5000;
      process.stdout.write(`  attempt ${attempt}/${attempts} failed (${message}); retrying in ${waitMs / 1000}s\n`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`Could not fetch the HTS after ${attempts} attempts: ${lastError}`);
}

/**
 * Guard against publishing a technically-valid but obviously wrong snapshot.
 *
 * The schedule has held roughly 35,000 rows and 25,000 priceable lines across
 * revisions. A sudden collapse to a fraction of that means the API returned
 * something unexpected rather than that the tariff schedule was repealed, and
 * on an unattended daily run it would silently replace a good deployment.
 */
function assertPlausible(rows: ApiRow[], entries: Entry[]): void {
  const MIN_ROWS = 25_000;
  const MIN_ENTRIES = 18_000;
  if (rows.length < MIN_ROWS) {
    throw new Error(`Refusing to publish: expected at least ${MIN_ROWS} rows, got ${rows.length}`);
  }
  if (entries.length < MIN_ENTRIES) {
    throw new Error(`Refusing to publish: expected at least ${MIN_ENTRIES} priceable lines, got ${entries.length}`);
  }
}

/**
 * Rebuild the classification hierarchy from the flat export and push duty
 * rates down to the lines that inherit them.
 *
 * Two things are flattened out of the export and have to be restored:
 *
 * 1. `indent` is the outline depth and rows with no `htsno` are "superior"
 *    text ("Men's or boys':") qualifying everything beneath them. A leaf whose
 *    own description is just "Other" is meaningless without that chain.
 *
 * 2. Duty rates are legislated at the 8-digit subheading. The 10-digit
 *    statistical suffixes below it carry the reporting units and are the codes
 *    actually filed on an entry, but their rate cells are blank — 6109.10.00
 *    holds "16.5%" and all fifteen 6109.10.00.xx breakouts show nothing.
 *    Dropping blank-rate lines would throw away every code an importer types
 *    in, so each line inherits the nearest rate-bearing ancestor's rates and
 *    remembers where they came from.
 */
function buildEntries(rows: ApiRow[]): Entry[] {
  const entries: Entry[] = [];
  /** Description path by indent depth. */
  const descAt: string[] = [];
  /** Nearest rate-bearing line at or above each indent depth. */
  const rateAt: ({ code: string; general: string; special: string; other: string } | undefined)[] = [];

  for (const row of rows) {
    const indent = Number.parseInt(row.indent, 10) || 0;
    const desc = stripTags(row.description ?? "");
    descAt.length = indent;
    rateAt.length = indent;
    const code = (row.htsno ?? "").trim();

    if (!code) {
      if (desc) descAt[indent] = desc;
      continue;
    }

    const own = {
      general: stripTags(row.general ?? ""),
      special: stripTags(row.special ?? ""),
      other: stripTags(row.other ?? ""),
    };
    const hasOwn = Boolean(own.general || own.other);

    // Nearest ancestor that actually carries a rate, if this line does not.
    let source: { code: string; general: string; special: string; other: string } | undefined;
    if (hasOwn) {
      source = { code, ...own };
    } else {
      for (let i = indent - 1; i >= 0; i--) {
        const candidate = rateAt[i];
        if (candidate) {
          source = candidate;
          break;
        }
      }
    }

    if (source) {
      entries.push({
        code,
        desc,
        path: descAt.slice(0, indent).filter(Boolean),
        units: (row.units ?? []).map(stripTags).filter(Boolean),
        general: source.general,
        special: source.special,
        other: source.other,
        ...(row.additionalDuties ? { additional: stripTags(row.additionalDuties) } : {}),
        ...(hasOwn ? {} : { rateFrom: source.code }),
      });
      rateAt[indent] = source;
    }

    if (desc) descAt[indent] = desc;
  }

  // A line is a real entry code when no longer code nests beneath it. Indent
  // order cannot answer this — a superior row between two statistical suffixes
  // pushes the next line deeper without making the previous one a parent — so
  // go by the codes themselves, which nest by digit prefix.
  const digitsOf = (code: string): string => code.replace(/\D/g, "");
  const hasChildren = new Set<string>();
  for (const entry of entries) {
    const d = digitsOf(entry.code);
    // Every proper prefix of this code is a parent, so it is not a leaf.
    for (let len = 2; len < d.length; len++) hasChildren.add(d.slice(0, len));
  }
  for (const entry of entries) {
    if (!hasChildren.has(digitsOf(entry.code))) entry.leaf = true;
  }

  return entries;
}

/** A Chapter 99 additional-duty heading and the goods it reaches. */
interface Remedy {
  /** Chapter 99 heading, e.g. "9903.88.03". */
  heading: string;
  /** Additive rate as a fraction; 0 for headings that add nothing. */
  uplift: number;
  /** Rate text as published. */
  rateText: string;
  description: string;
  /** Note subdivisions cited, e.g. ["20(e)", "20(f)"]. */
  noteRefs: string[];
  /** Country scope, as far as the notes could be read. */
  scope: Scope;
  /** Headings that carve goods out of this one. */
  exceptHeadings: string[];
}

/**
 * The release the API is currently serving, e.g. "2026HTSRev16".
 *
 * `exportList` has no release parameter and always serves current, while the
 * Chapter 99 notes are fetched by explicit release. On an unattended daily run
 * a revision landing between the two calls would pair a schedule with the wrong
 * notes, and the failure is silent — wrong coverage, no error. So the release
 * is read before and after and the build fails if it moved.
 */
async function currentRelease(): Promise<string> {
  const res = await fetch(RELEASE_API, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`currentRelease failed: ${res.status}`);
  const body = (await res.json()) as { name?: string };
  if (!body.name) throw new Error("currentRelease returned no release name");
  return body.name;
}

/** Chapter number from a dotted HTS code: "6109.10.00" -> "61". */
const chapterOf = (code: string): string => code.replace(/\D/g, "").slice(0, 2).padStart(2, "0");

/**
 * Build the Chapter 99 remedy records and the reverse index from ordinary
 * codes to the headings that reach them.
 */
async function buildRemedies(
  rows: ApiRow[],
  release: string,
): Promise<{ remedies: Remedy[]; coverage: Record<string, string[]>; stats: { headings: number; coveredCodes: number; scoped: number; lists: number; section301: number; conflicts: number; suspended: number } }> {
  process.stdout.write("fetching Chapter 99 notes (PDF)\n");
  const notesText = await fetchChapter99Text(release);
  const lists = parseCoverageLists(notesText);
  process.stdout.write(`  ${lists.size} headings with a coverage list in the notes\n`);

  // Chapter 99 headings that impose or waive an additional duty.
  const headingRows = rows.filter((r) => (r.htsno ?? "").startsWith("9903") && (r.general ?? "").trim());
  const scopes = parseHeadingScopes(notesText, headingRows.map((r) => r.htsno.trim()));
  process.stdout.write(`  ${scopes.size} of ${headingRows.length} headings had a readable country scope\n`);

  // The official Section 301 table. Authoritative where it speaks.
  const official = await fetchSection301Coverage(release);
  process.stdout.write(`  ${official.size.toLocaleString("en-US")} rows in the official Section 301 table\n`);

  const remedies: Remedy[] = [];
  const suspended: string[] = [];
  /** digits-only ordinary code -> heading codes */
  const coverage = new Map<string, Set<string>>();
  const addCoverage = (code: string, heading: string): void => {
    let set = coverage.get(code);
    if (!set) coverage.set(code, (set = new Set()));
    set.add(heading);
  };

  for (const row of headingRows) {
    const heading = row.htsno.trim();
    const description = stripTags(row.description ?? "");
    const rateText = stripTags(row.general ?? "");
    const uplift = parseUplift(rateText);
    if (uplift === null) continue; // not a simple uplift; nothing to stack

    /*
     * Suspended provisions must never be applied.
     *
     * The schedule keeps a heading in place after it is suspended and marks it
     * only in a compiler's note — 9903.88.16 is the old List 4B at 15%, which
     * never came into force, and 9903.01.63 was suspended by Federal Register
     * notice. Their coverage tables are still printed in the U.S. Notes, so a
     * parser reading the notes will happily pick them up and add duty that is
     * not owed. The official Section 301 table already omits them; this drops
     * them everywhere else.
     */
    if (/provision suspended/i.test(description)) {
      suspended.push(heading);
      continue;
    }

    const noteRefs = parseNoteRefs(description);
    const exceptHeadings = [
      ...new Set(
        [...description.matchAll(/9903\.\d{2}\.\d{2}/g)]
          .map((m) => m[0])
          .filter((h) => h !== heading),
      ),
    ];

    remedies.push({
      heading,
      uplift,
      rateText,
      description,
      noteRefs,
      scope: scopes.get(heading) ?? { kind: "unknown", text: "" },
      exceptHeadings,
    });

    // Section 301 coverage comes from the official table, so skip the
    // note-derived list for those headings and let the cross-check below
    // compare them instead.
    if (!/^9903\.(88|91|92)\./.test(heading)) {
      for (const code of lists.get(heading) ?? []) addCoverage(code, heading);
    }
  }

  for (const [code, heading] of official) addCoverage(code, heading);

  /*
   * Cross-check the prose parser against the official table.
   *
   * The note parser is no longer the source of truth for Section 301, but it
   * still reads the same notes, so a disagreement means one of the two has
   * drifted — a heading renumbered, a table reformatted, a note rewritten. It
   * costs nothing to compare and it is the only signal that would catch the
   * document format changing under us. Missing entries are expected and fine;
   * a contradiction is not.
   */
  let conflicts = 0;
  const suspendedSet = new Set(suspended);
  for (const [heading, codes] of lists) {
    if (!/^9903\.(88|91|92)\./.test(heading)) continue;
    // A suspended heading's table is still printed; the official table
    // correctly omits it, and that difference is expected, not drift.
    if (suspendedSet.has(heading)) continue;
    for (const code of codes) {
      const truth = official.get(code);
      if (truth && truth !== heading) conflicts++;
    }
  }
  if (conflicts > 0) {
    process.stdout.write(
      `  WARNING: ${conflicts} disagreements between the notes and the official Section 301 table\n`,
    );
  }

  const flat: Record<string, string[]> = {};
  for (const [code, set] of coverage) flat[code] = [...set];

  return {
    remedies,
    coverage: flat,
    stats: {
      headings: remedies.length,
      coveredCodes: coverage.size,
      scoped: scopes.size,
      lists: lists.size,
      section301: official.size,
      conflicts,
      suspended: suspended.length,
    },
  };
}

async function main(): Promise<void> {
  const release = await currentRelease();
  process.stdout.write(`release ${release}\n`);
  const rows = await fetchSchedule();
  const entries = buildEntries(rows);
  process.stdout.write(`  ${entries.length} rate-bearing lines\n`);
  assertPlausible(rows, entries);

  const { remedies, coverage, stats } = await buildRemedies(rows, release);
  process.stdout.write(
    `  ${stats.headings} remedy headings covering ${stats.coveredCodes.toLocaleString("en-US")} codes` +
      `${stats.suspended > 0 ? `, ${stats.suspended} suspended and excluded` : ""}\n`,
  );

  // The schedule and the notes must come from the same revision.
  const releaseAfter = await currentRelease();
  if (releaseAfter !== release) {
    throw new Error(
      `USITC published ${releaseAfter} while this build was reading ${release}. ` +
        "Re-run so the schedule and the Chapter 99 notes come from one revision.",
    );
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "chapter"), { recursive: true });
  await writeFile(join(OUT, "remedies.json"), JSON.stringify({ remedies, coverage }));

  // Per-chapter files: the app fetches only the chapter it needs.
  const byChapter = new Map<string, Entry[]>();
  for (const e of entries) {
    const ch = chapterOf(e.code);
    let list = byChapter.get(ch);
    if (!list) byChapter.set(ch, (list = []));
    list.push(e);
  }
  for (const [ch, list] of byChapter) {
    await writeFile(join(OUT, "chapter", `${ch}.json`), JSON.stringify(list));
  }

  // Chapter titles come from the 4-digit heading rows' nearest chapter text;
  // the export has no explicit chapter row, so take the first heading in each.
  const titles = new Map<string, string>();
  for (const row of rows) {
    const code = (row.htsno ?? "").trim();
    if (!/^\d{4}$/.test(code)) continue;
    const ch = chapterOf(code);
    if (!titles.has(ch)) titles.set(ch, stripTags(row.description ?? ""));
  }

  // Search index. Path segments repeat across every sibling line — "Men's or
  // boys':" alone appears thousands of times — so segments go in a shared
  // string table and each entry references them by number. That turns a 7 MB
  // file into well under 2 MB without giving up full-path search text.
  const segments: string[] = [];
  const segmentId = new Map<string, number>();
  const intern = (text: string): number => {
    let id = segmentId.get(text);
    if (id === undefined) {
      id = segments.length;
      segments.push(text);
      segmentId.set(text, id);
    }
    return id;
  };

  const index = {
    segments,
    // [code, ...pathSegmentIds, -1, ownDescriptionId, generalRateId]
    entries: entries.map((e) => [
      e.code,
      e.path.map(intern),
      intern(e.desc),
      intern(e.general),
      e.leaf ? 1 : 0,
    ]),
  };

  await writeFile(join(OUT, "search-index.json"), JSON.stringify(index));
  await writeFile(
    join(OUT, "meta.json"),
    JSON.stringify({
      source: "USITC Harmonized Tariff Schedule REST API",
      endpoint: `${API}?from=0101&to=9999&format=JSON&styles=true`,
      fetchedAt: new Date().toISOString(),
      release,
      rows: rows.length,
      entries: entries.length,
      remedies: stats,
      chapters: [...byChapter.keys()].sort().map((ch) => ({
        ch,
        title: titles.get(ch) ?? "",
        count: byChapter.get(ch)!.length,
      })),
    }, null, 2),
  );

  process.stdout.write(`  wrote ${byChapter.size} chapter files + search index to public/data\n`);
}

await main();
