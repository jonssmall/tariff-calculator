/**
 * Loading and searching the HTS snapshot produced by `npm run data`.
 *
 * The snapshot is split so the browser never pulls more than it needs: one
 * compact search index for lookup, and per-chapter files fetched on demand for
 * the full detail of a selected line.
 */

/** A line as stored in the per-chapter files. */
export interface Entry {
  code: string;
  desc: string;
  path: string[];
  units: string[];
  general: string;
  special: string;
  other: string;
  additional?: string;
  rateFrom?: string;
  leaf?: boolean;
}

/** A search hit, with its text already reassembled from the string table. */
export interface Hit {
  code: string;
  /** Full classification path, " > " separated. */
  text: string;
  /** Own description, the last path element. */
  desc: string;
  general: string;
  leaf: boolean;
}

interface RawIndex {
  segments: string[];
  entries: [code: string, path: number[], desc: number, general: number, leaf: number][];
}

export interface Meta {
  source: string;
  endpoint: string;
  fetchedAt: string;
  release: string;
  rows: number;
  entries: number;
  remedies: { headings: number; coveredCodes: number; scoped: number; lists: number; section301: number; conflicts: number; suspended: number };
  chapters: { ch: string; title: string; count: number }[];
}

// Optional-chained so the module can also be exercised outside a bundler, where
// `import.meta.env` does not exist.
const BASE = import.meta.env?.BASE_URL ?? "/";

let indexPromise: Promise<Hit[]> | undefined;
let searchable: string[] = [];
const chapterCache = new Map<string, Promise<Entry[]>>();

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}data/${path}`);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return (await res.json()) as T;
}

export function loadMeta(): Promise<Meta> {
  return fetchJson<Meta>("meta.json");
}

let remedyPromise: Promise<import("./remedies.ts").RemedyData> | undefined;

/** Chapter 99 additional-duty data. Cached for the page's lifetime. */
export function loadRemedies(): Promise<import("./remedies.ts").RemedyData> {
  remedyPromise ??= fetchJson<import("./remedies.ts").RemedyData>("remedies.json");
  return remedyPromise;
}

/** Load and rehydrate the search index. Cached for the page's lifetime. */
export function loadIndex(): Promise<Hit[]> {
  indexPromise ??= fetchJson<RawIndex>("search-index.json").then((raw) => {
    const { segments } = raw;
    const hits = raw.entries.map(([code, path, desc, general, leaf]) => {
      const own = segments[desc] ?? "";
      return {
        code,
        text: [...path.map((i) => segments[i] ?? ""), own].filter(Boolean).join(" > "),
        desc: own,
        general: segments[general] ?? "",
        leaf: leaf === 1,
      };
    });
    // Precompute the match target once; doing it per keystroke over 25k rows is
    // what makes a naive search feel slow.
    searchable = hits.map((h) => `${h.code} ${h.text}`.toLowerCase());
    return hits;
  });
  return indexPromise;
}

export function loadChapter(chapter: string): Promise<Entry[]> {
  const ch = chapter.padStart(2, "0");
  let cached = chapterCache.get(ch);
  if (!cached) {
    cached = fetchJson<Entry[]>(`chapter/${ch}.json`);
    chapterCache.set(ch, cached);
  }
  return cached;
}

/** Digits only, so "6109.10.00.12" and "6109101012" both match. */
const digits = (s: string): string => s.replace(/\D/g, "");

export interface SearchOptions {
  /** Only return lines that are real entry codes. */
  leafOnly?: boolean;
  limit?: number;
}

/**
 * Search by HTS number or keyword.
 *
 * A numeric query is treated as a code prefix, which is how a classifier
 * actually looks things up. Anything else is an all-terms substring match,
 * ranked so that whole-word hits in the line's own description come first —
 * without that, a search for "cotton" returns hundreds of lines whose parent
 * heading merely mentions cotton before it reaches the ones that are cotton.
 */
export async function search(query: string, options: SearchOptions = {}): Promise<Hit[]> {
  const { leafOnly = false, limit = 200 } = options;
  const hits = await loadIndex();
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: { hit: Hit; score: number }[] = [];

  const numeric = digits(q);
  if (numeric.length >= 2 && /^[\d.\s]+$/.test(q)) {
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]!;
      if (leafOnly && !hit.leaf) continue;
      const code = digits(hit.code);
      if (!code.startsWith(numeric)) continue;
      // Shortest (most general) codes first, then numerically.
      results.push({ hit, score: 1000 - code.length });
    }
    results.sort((a, b) => b.score - a.score || a.hit.code.localeCompare(b.hit.code));
    return results.slice(0, limit).map((r) => r.hit);
  }

  const terms = q.split(/\s+/).filter(Boolean);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    if (leafOnly && !hit.leaf) continue;
    const haystack = searchable[i]!;
    if (!terms.every((t) => haystack.includes(t))) continue;

    const own = hit.desc.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (own.includes(term)) score += 10;
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(own)) score += 15;
    }
    // Prefer specific lines over broad headings when scores tie.
    if (hit.leaf) score += 3;
    score -= Math.min(hit.text.length / 200, 4);
    results.push({ hit, score });
  }

  results.sort((a, b) => b.score - a.score || a.hit.code.localeCompare(b.hit.code));
  return results.slice(0, limit).map((r) => r.hit);
}

/** Fetch the full record for one code. */
export async function getEntry(code: string): Promise<Entry | undefined> {
  const chapter = digits(code).slice(0, 2);
  const entries = await loadChapter(chapter);
  return entries.find((e) => e.code === code);
}
