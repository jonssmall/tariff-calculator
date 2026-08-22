/**
 * Chapter 99 subchapter III: the additional-duty provisions and what they cover.
 *
 * Section 301, Section 232 and the IEEPA actions are not rates on an ordinary
 * tariff line. They are separate Chapter 99 headings whose rate text reads
 * "The duty provided in the applicable subheading + 25%", declared as an extra
 * line on the entry and stacking on top of Column 1. A calculator that reports
 * only the ordinary rate understates duty on covered goods by 25 or 50 points,
 * which is the difference between a useful figure and a dangerous one.
 *
 * The catch is that `exportList` publishes the headings but not their coverage.
 * A heading says only "provided for in subdivision (f) of U.S. note 37 of this
 * subchapter"; the list of HTS codes that subdivision names lives in the U.S.
 * Notes, which USITC ships as the Chapter 99 PDF. So the PDF is fetched from
 * the same API host, converted to text, and mined for two things: the coverage
 * lists, and the prose that says which countries each heading applies to.
 *
 * This is inherently a text-mining step against a document written for humans.
 * Everything it produces is therefore labelled with how confident it is, and
 * the UI defaults to applying only what it is sure of.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const FILE_API = "https://hts.usitc.gov/reststop/file";

/** Page headers and footers that interleave with the note text. */
const FURNITURE =
  /Harmonized Tariff Schedule|Annotated for Statistical|^\s*99 - [IVX]+ - |^\s*U\.S\. Notes|^\s*[IVX]{1,6}\s*$|^\s*\d{1,3}\s*$/;

/**
 * An HTS code as written in the notes.
 *
 * The notes are inconsistent about the statistical suffix: note 20 lists
 * 8-digit subheadings ("9403.60.80") while note 37 lists 10-digit statistical
 * codes with the final dot omitted ("9403.60.8093"). Both are accepted and
 * normalized to digits, which is also how entry codes are matched.
 */
const CODE = /\b\d{4}\.\d{2}\.\d{2}(?:\.?\d{2})?\b/g;

/** A line that is nothing but codes and whitespace. */
const BARE_LINE = /^[\s\d.\/]+$/;

export const digitsOf = (code: string): string => code.replace(/\D/g, "");

/** Download a document from the release and convert it to text. */
export async function fetchDocumentText(release: string, filename: string): Promise<string> {
  const url = `${FILE_API}?release=${encodeURIComponent(release)}&filename=${encodeURIComponent(filename)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`"${filename}" request failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== "%PDF") {
    throw new Error(`"${filename}" is not a PDF (${bytes.length} bytes)`);
  }

  const dir = await mkdtemp(join(tmpdir(), "hts-doc-"));
  try {
    const pdf = join(dir, "doc.pdf");
    const txt = join(dir, "doc.txt");
    await writeFile(pdf, bytes);
    // -layout preserves the column structure both documents depend on.
    await run("pdftotext", ["-layout", pdf, txt]);
    const { readFile } = await import("node:fs/promises");
    return await readFile(txt, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) {
      throw new Error(
        "pdftotext is not installed. It ships in poppler-utils " +
          "(`sudo apt-get install -y poppler-utils`) and is required to read the Chapter 99 documents.",
      );
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The official Section 301 coverage table.
 *
 * USITC publishes "China Tariffs" alongside the schedule: a plain two-column
 * list of every 8-digit subheading covered by Section 301 and the Chapter 99
 * heading that imposes the duty.
 *
 *   0101.21.00                       9903.88.15
 *   8507.60.00                       9903.91.06
 *
 * This is the authoritative mapping and it replaces note-mining for Section 301
 * entirely. It matters most for the 2024 strategic-sector tranche — semi-
 * conductors, EVs, batteries, solar cells — whose notes the prose parser never
 * reached, and whose rates run to 100%. The notes remain the only source for
 * Section 232 and the IEEPA actions, which have no equivalent table.
 */
export async function fetchSection301Coverage(release: string): Promise<Map<string, string>> {
  const text = await fetchDocumentText(release, "China Tariffs");
  const rows = new Map<string, string>();
  // A data row is a subheading and a heading alone on the line; everything else
  // in the document is explanatory prose.
  const ROW = /^\s*(\d{4}\.\d{2}\.\d{2}(?:\.\d{2})?)\s+(9903\.\d{2}\.\d{2})\s*$/;
  for (const line of text.split("\n")) {
    const m = line.match(ROW);
    if (m) rows.set(digitsOf(m[1]!), m[2]!);
  }
  if (rows.size < 5000) {
    throw new Error(`"China Tariffs" yielded only ${rows.size} rows; the document format has probably changed.`);
  }
  return rows;
}

/** Download the Chapter 99 PDF and convert it to layout-preserving text. */
export function fetchChapter99Text(release: string): Promise<string> {
  return fetchDocumentText(release, "Chapter 99");
}

/**
 * Coverage lists keyed by note and subdivision, e.g. "20(f)".
 *
 * Only lines consisting purely of codes are treated as coverage. Prose in the
 * notes cites plenty of headings ("Except as provided in heading 9903.88.13"),
 * and counting those would wildly over-match.
 */
export function parseCoverageLists(text: string): Map<string, Set<string>> {
  return parseHeadingCoverage(text);
}

/**
 * Map each additional-duty heading to the HTS codes it reaches.
 *
 * Attribution is anchored to the heading a subdivision *names*, not to the
 * subdivision label. Going by label fails badly here: note 20 runs for
 * thousands of lines, its code tables span page breaks, and its subdivision
 * markers sit pages away from the tables they govern, so "whichever subdivision
 * was seen last" merges unrelated lists — one label absorbed 2,958 codes
 * spanning several. Every subdivision that carries coverage introduces itself
 * by naming its heading, in one of two forms:
 *
 *   (f)  Heading 9903.88.03 applies to all products of China that are
 *        classified in the following 8-digit subheadings, except ...
 *
 *   (f)  ... the rates of duty set forth in headings 9903.76.03, 9903.76.20,
 *        ... apply to all imported completed kitchen cabinets ...
 *
 * Headings cited *after* "except" are exclusions, not coverage, so only the
 * heading in the introducing clause is taken. A block that names no heading is
 * skipped entirely: an unattributed table is not worth the risk of guessing,
 * because a wrongly applied heading silently adds 25% to goods that never
 * carried it.
 */
export function parseHeadingCoverage(text: string): Map<string, Set<string>> {
  const coverage = new Map<string, Set<string>>();
  const lines = text.split("\n").filter((l) => !FURNITURE.test(l));

  interface Mark {
    line: number;
    indent: number;
    /** True when this line also opens a new note, which resets inheritance. */
    opensNote: boolean;
  }

  const marks: Mark[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const opener = l.match(/^(\s*)\d{1,3}\.\s*\([a-z]{1,3}\)/);
    if (opener) {
      marks.push({ line: i, indent: opener[1]!.length, opensNote: true });
      continue;
    }
    if (/^\s*\d{1,3}\.\s*$/.test(l)) {
      marks.push({ line: i, indent: -1, opensNote: true });
      continue;
    }
    const sub = l.match(/^(\s*)\([a-z]{1,3}\)\s/);
    if (sub) marks.push({ line: i, indent: sub[1]!.length, opensNote: false });
  }

  /*
   * The heading an enclosing block named for its children.
   *
   * The big Section 301 notes nest: the heading is named by one subdivision and
   * the code table sits in the next one down.
   *
   *   (s)  Heading 9903.88.15 applies to:
   *   (i)   all products of China classified in the following 8-digit
   *         subheadings:
   *               ... 6109.10.00 ...
   *
   * Indentation cannot separate parent from sibling here — (s) and (i) are both
   * indented twelve spaces — so the trailing colon is the signal. A block that
   * names a heading and ends its sentence with a colon is introducing children,
   * and the blocks that follow inherit that heading until one names its own or
   * a new note begins. A block ending any other way keeps its codes to itself,
   * which is what stops an apparel table leaking onto an industrial-goods
   * heading and overstating duty by 17.5 points.
   */
  let parent: string[] | null = null;

  for (let m = 0; m < marks.length; m++) {
    const mark = marks[m]!;
    const from = mark.line;
    const to = m + 1 < marks.length ? marks[m + 1]!.line : lines.length;

    if (mark.opensNote) parent = null;

    let firstCode = -1;
    for (let i = from; i < to; i++) {
      const l = lines[i]!;
      if (l.trim() && BARE_LINE.test(l) && /\d{4}\.\d{2}\.\d{2}/.test(l)) {
        firstCode = i;
        break;
      }
    }

    const intro = lines
      .slice(from, firstCode === -1 ? to : firstCode)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const named = new Set<string>();
    const plural = intro.match(
      /rates?\s+of\s+duty\s+set\s+forth\s+in\s+headings?\s+((?:9903\.\d{2}\.\d{2}[,\s]*(?:and\s+)?)+)/i,
    );
    if (plural) for (const h of plural[1]!.matchAll(/9903\.\d{2}\.\d{2}/g)) named.add(h[0]);
    const singular = intro.match(/[Hh]eading\s+(9903\.\d{2}\.\d{2})\s+applies\s+to/);
    if (singular) named.add(singular[1]!);

    let headings: string[];
    if (named.size > 0) {
      headings = [...named];
      parent = /:$/.test(intro) ? [...named] : null;
    } else {
      headings = parent ?? [];
    }

    if (firstCode === -1 || headings.length === 0) continue;

    for (let i = firstCode; i < to; i++) {
      const l = lines[i]!;
      if (!l.trim()) continue;
      if (!BARE_LINE.test(l)) continue;
      const codes = l.match(CODE);
      if (!codes) continue;
      for (const heading of headings) {
        let set = coverage.get(heading);
        if (!set) coverage.set(heading, (set = new Set()));
        for (const code of codes) set.add(digitsOf(code));
      }
    }
  }
  return coverage;
}

/**
 * How a heading defines the goods it reaches.
 *
 * Two shapes, and they need opposite treatment. Section 301 enumerates covered
 * subheadings, so coverage is a list. The IEEPA actions do the reverse: they
 * hit everything from a country and then carve exceptions out by heading
 * ("Except for products described in headings 9903.01.11 ... articles the
 * product of Canada"). A list-only model finds no list for those and silently
 * reports no duty, which is why Canada, Mexico and Brazil came back clean when
 * they are anything but.
 */
export function classifyCoverage(description: string): "blanket" | "list" {
  return /^except (as provided|for)/i.test(description.trim()) ||
    /articles the product of (any country|[A-Z])/i.test(description)
    ? "blanket"
    : "list";
}

/** Which origins a heading reaches. */
export type Scope =
  | { kind: "country"; name: string }
  | { kind: "all-except"; names: string[] }
  | { kind: "all" }
  | { kind: "unknown"; text: string };

/**
 * Find each heading's country scope in the note prose.
 *
 * Scope is stated inconsistently. Sometimes it is in the heading's own
 * description ("articles the product of China"); sometimes only in the note
 * that governs it ("heading 9903.76.03 ... applicable to products of all
 * countries other than: the United Kingdom, ..."). This scans the notes for
 * sentences naming a heading and reads the scope out of them; anything it
 * cannot classify is returned as `unknown` so the UI can ask rather than guess.
 */
export function parseHeadingScopes(text: string, headings: string[]): Map<string, Scope> {
  const scopes = new Map<string, Scope>();
  const flat = text
    .split("\n")
    .filter((l) => !FURNITURE.test(l))
    .join(" ")
    .replace(/\s+/g, " ");
  const sentences = flat.split(/(?<=\.)\s+(?=[A-Z(])/);

  for (const heading of headings) {
    const mentions = sentences.filter((s) => s.includes(heading));
    if (mentions.length === 0) continue;

    /*
     * Prefer sentences where this heading is the subject.
     *
     * A single sentence often lists several headings that share a coverage
     * list but not a country — note 37(f) introduces 9903.76.03 (most origins)
     * and 9903.76.20 (the United Kingdom) together. Reading scope from such a
     * sentence gives the UK-only heading the other's scope and applies a 10%
     * duty to goods from everywhere. Sentences of the form "heading X applies
     * to" or "heading X provides" are about X alone, so they are read first.
     */
    const subject = new RegExp(`heading ${heading.replace(/\./g, "\\.")}\\s+(?:applies|provides)`, "i");
    const ordered = [...mentions].sort((a, b) => Number(subject.test(b)) - Number(subject.test(a)));
    const anySubject = mentions.some((s) => subject.test(s));

    let resolved: Scope | undefined;
    for (const sentence of ordered) {
      // Once a subject-position sentence exists, never fall back to a listing
      // sentence — that is exactly the mix-up described above.
      if (anySubject && !subject.test(sentence)) break;

      const except = sentence.match(
        /applicable to products of all countries other than:?\s*([^.]+?)(?:\.|$)/i,
      );
      if (except) {
        resolved = {
          kind: "all-except",
          names: except[1]!
            .split(/,| and /)
            .map((n) => n.replace(/^the /i, "").trim())
            .filter((n) => n.length > 1),
        };
        break;
      }
      const single = sentence.match(
        /products? of (?:the\s+)?([A-Z][A-Za-z ]{2,30}?)(?:,|\s+that\b|\s+as\b|\s+shall\b|\s+described\b|\.)/,
      );
      if (single && !resolved) resolved = { kind: "country", name: single[1]!.trim() };
    }
    if (resolved) scopes.set(heading, resolved);
  }
  return scopes;
}

/**
 * Country scope stated in the heading's own description.
 *
 * Used when the notes yield nothing. Many headings name their origin plainly —
 * "Wood products of the European Union as provided for in subdivisions (d) and
 * (f)" — and without reading it that heading has unknown scope and is offered
 * against every origin, so a Korean shipment is asked to consider an EU
 * provision.
 */
export function parseScopeFromDescription(description: string): Scope | null {
  const text = description.replace(/\s+/g, " ").trim();
  const m = text.match(
    /(?:articles|products|goods)\s+(?:the\s+)?(?:product\s+)?of\s+(?:the\s+)?([A-Z][A-Za-z ]{2,40}?)(?:,|\s+as\b|\s+that\b|\s+described\b|\s+provided\b|\s+shall\b|\.|$)/,
  );
  if (!m) return null;
  const name = m[1]!.trim();
  if (/^any country$/i.test(name)) return { kind: "all" };
  return { kind: "country", name };
}

/**
 * Note references cited by a heading's description.
 *
 * Written two ways: "U.S. note 20(f)" and "subdivision (f) of U.S. note 37".
 * A heading often cites several — one for the rate, one for the coverage list —
 * so all are returned and the caller keeps whichever resolve to a list.
 */
export function parseNoteRefs(description: string): string[] {
  const refs = new Set<string>();
  for (const m of description.matchAll(/U\.S\.\s*note\s*(\d{1,3})\s*\(([a-z]{1,3})\)/gi)) {
    refs.add(`${m[1]}(${m[2]!.toLowerCase()})`);
  }
  for (const m of description.matchAll(/subdivision\s*\(([a-z]{1,3})\)\s*of\s*U\.S\.\s*note\s*(\d{1,3})/gi)) {
    refs.add(`${m[2]}(${m[1]!.toLowerCase()})`);
  }
  return [...refs];
}

/**
 * A flat ad valorem rate on a Chapter 99 heading, which replaces the ordinary
 * duty rather than adding to it.
 *
 * These come in pairs that make the intent unambiguous:
 *
 *   9903.94.40  "The duty provided in the applicable subheading"
 *               Japanese vehicles whose column 1 rate is >= 15 percent
 *   9903.94.41  "15%"
 *               Japanese vehicles whose column 1 rate is <  15 percent
 *
 * That is a floor from the US-Japan arrangement: the rate is raised *to* 15%,
 * not by it. Reading "15%" as an uplift would add it to a 2.5% car and report
 * 17.5% where 15% is owed.
 */
export function parseReplacementRate(rateText: string): number | null {
  const text = (rateText ?? "").replace(/\s+/g, " ").trim();
  const m = text.match(/^([\d.]+)\s*%$/);
  return m ? Number.parseFloat(m[1]!) / 100 : null;
}

/** The additive percentage a heading imposes, if its rate is a simple uplift. */
export function parseUplift(rateText: string): number | null {
  const text = (rateText ?? "").replace(/\s+/g, " ").trim();
  if (/^the duty provided in the applicable subheading$/i.test(text)) return 0;
  // "No change" is how an exemption heading is written: it applies to the
  // goods but leaves the duty alone. Without this the carve-outs that make
  // blanket duties correct — USMCA on Canadian goods, for one — are dropped.
  if (/^no change$/i.test(text)) return 0;
  const m = text.match(/^the duty provided in the applicable subheading\s*(?:\+|plus)\s*([\d.]+)\s*%$/i);
  return m ? Number.parseFloat(m[1]!) / 100 : null;
}

/**
 * Which headings displace which.
 *
 * Blanket provisions overlap heavily — Canada matches a 35%, a 40% and two
 * transshipment duties at once — and the notes resolve that overlap explicitly:
 *
 *   (j)  For the purposes of heading 9903.01.10, products of Canada, other than
 *        products described in headings 9903.01.11 … 9903.01.16, 9903.76.01,
 *        9903.76.02 and 9903.76.03 … shall be subject to an additional 35%.
 *
 * The heading's own description carries only part of that list (9903.01.11
 * through .15); the rest, including the Section 232 headings that take
 * precedence, appears only here. Without it a Canadian kitchen cabinet looks
 * liable for both the 232 duty and the 35% IEEPA duty, when the note says the
 * IEEPA duty does not reach goods the 232 heading already covers.
 */
export function parseHeadingExclusions(text: string, headings: string[]): Map<string, Set<string>> {
  const known = new Set(headings);

  /**
   * Expand "9903.05.20–9903.05.84" into the headings that exist in that span.
   *
   * The notes state precedence over ranges, not lists. Without expansion the
   * single most valuable rule in the chapter is invisible: the IEEPA reciprocal
   * duties in 9903.05.20–9903.05.84 do not apply to goods already covered by
   * the Section 232 headings. That one relationship is why a Chinese kitchen
   * cabinet owes 50% and not 50% plus a reciprocal tariff on top.
   */
  const expandRange = (from: string, to: string): string[] => {
    const key = (h: string) => Number(h.replace(/\D/g, ""));
    const lo = key(from);
    const hi = key(to);
    if (!(hi > lo)) return [from];
    return [...known].filter((h) => {
      const k = key(h);
      return k >= lo && k <= hi;
    });
  };

  /** Every heading a clause names, ranges expanded. */
  const headingsIn = (clause: string): string[] => {
    const out: string[] = [];
    // Ranges first, so their endpoints are not also counted individually.
    const consumed = new Set<string>();
    for (const m of clause.matchAll(/(9903\.\d{2}\.\d{2})\s*[–—-]\s*(9903\.\d{2}\.\d{2})/g)) {
      out.push(...expandRange(m[1]!, m[2]!));
      consumed.add(m[0]);
    }
    let rest = clause;
    for (const c of consumed) rest = rest.split(c).join(" ");
    for (const m of rest.matchAll(/9903\.\d{2}\.\d{2}/g)) out.push(m[0]);
    return [...new Set(out)].filter((h) => known.has(h));
  };
  const exclusions = new Map<string, Set<string>>();

  const flat = text
    .split("\n")
    .filter((l) => !FURNITURE.test(l))
    .join(" ")
    .replace(/\s+/g, " ");

  // "For the purposes of heading X, … other than products described in headings A, B, C"
  const scopes = /[Ff]or the purposes of heading (9903\.\d{2}\.\d{2})([\s\S]{0,900}?)(?=[Ff]or the purposes of heading |$)/g;
  let match: RegExpExecArray | null;
  while ((match = scopes.exec(flat)) !== null) {
    const heading = match[1]!;
    if (!known.has(heading)) continue;
    const body = match[2] ?? "";

    const clause = body.match(
      /other than (?:products|articles|goods) (?:described|provided for) in (?:heading|subheading)s? ([\s\S]{0,400}?)(?:\band other than\b|\bshall\b|\.\s)/i,
    );
    if (!clause) continue;

    const displaced = [...clause[1]!.matchAll(/9903\.\d{2}\.\d{2}/g)].map((m) => m[0]).filter((h) => h !== heading);
    if (displaced.length === 0) continue;

    let set = exclusions.get(heading);
    if (!set) exclusions.set(heading, (set = new Set()));
    for (const h of displaced) set.add(h);
  }

  /*
   * The second phrasing, which carries the chapter's most important rule:
   *
   *   the additional duties imposed by headings 9903.05.20–9903.05.84 shall not
   *   apply to: (1) articles of aluminum ... provided for in headings
   *   9903.82.02 and 9903.82.04–9903.82.26; (2) passenger vehicles ...
   *
   * Both sides are ranges. Every heading on the left is displaced by every
   * heading on the right, which is how a product-specific Section 232 duty
   * takes precedence over the country-wide reciprocal tariff.
   */
  const notApply =
    /additional duties imposed by (?:heading|subheading)s? ([\d.–—, and-]{5,90}?) shall not apply to ([\s\S]{0,900}?)(?:\. [A-Z]|$)/gi;
  let clause: RegExpExecArray | null;
  while ((clause = notApply.exec(flat)) !== null) {
    const sources = headingsIn(clause[1]!);
    const targets = headingsIn(clause[2]!).filter((h) => !sources.includes(h));
    if (sources.length === 0 || targets.length === 0) continue;
    for (const source of sources) {
      let set = exclusions.get(source);
      if (!set) exclusions.set(source, (set = new Set()));
      for (const t of targets) set.add(t);
    }
  }

  return exclusions;
}

/**
 * Headings whose duty is waived when entry is claimed under Chapter 98.
 *
 * Chapter 98 covers US goods returned, goods exported for repair, and similar
 * provisions where duty is owed on something other than the full value. The
 * notes repeatedly say the additional duty "shall not apply to goods for which
 * entry is properly claimed under a provision of chapter 98", which makes a
 * Chapter 98 claim one of the few things that removes an IEEPA duty outright.
 *
 * The waiver is conditional — the note adds "pursuant to applicable regulations"
 * and "whenever CBP agrees" — so this is offered to the user as a claim rather
 * than applied on their behalf.
 */
export function parseChapter98Waivers(text: string): Set<string> {
  const flat = text
    .split("\n")
    .filter((l) => !FURNITURE.test(l))
    .join(" ")
    .replace(/\s+/g, " ");

  const waived = new Set<string>();
  const pattern =
    /additional duties imposed by headings? ((?:9903\.\d{2}\.\d{2}[\s,and]*)+)shall not apply to goods for which entry is properly claimed under a provision of chapter 98/gi;
  for (const m of flat.matchAll(pattern)) {
    for (const h of m[1]!.matchAll(/9903\.\d{2}\.\d{2}/g)) waived.add(h[0]);
  }
  return waived;
}

/**
 * A condition on the ordinary rate that decides whether a heading applies.
 *
 * The schedule implements negotiated ceilings as a pair of headings gated on
 * the column 1 rate:
 *
 *   9903.94.40  no change   "...rate of duty under column 1 equal to or
 *                            greater than 15 percent"
 *   9903.94.41  15%         "...rate of duty under column 1 less than 15
 *                            percent"
 *
 * Exactly one of each pair can apply, and which one is fully determined by the
 * base rate — so offering both, as happens without this, asks the user to
 * decide something the data already answers.
 */
export interface RateThreshold {
  op: "gte" | "lt";
  rate: number;
}

export function parseRateThreshold(description: string): RateThreshold | null {
  const m = description.match(
    /rate of duty under column 1 (equal to or greater than|less than) ([\d.]+) percent/i,
  );
  if (!m) return null;
  return {
    op: /less than/i.test(m[1]!) ? "lt" : "gte",
    rate: Number.parseFloat(m[2]!) / 100,
  };
}
