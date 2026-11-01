/**
 * Fuzzy matching, from VS Code.
 *
 * VS Code's quick open scorer (`vs/base/common/fuzzyScorer`), used under
 * fove's own Spotlight and palette. It is the matcher people already have in
 * their fingers: `edtsx` finds `Editor.tsx`, a hit in the file name beats one
 * scattered through directories, a prefix beats a mid-word match, and spaces
 * split the query into pieces that may match in any order (`panes edit`).
 */

import {
  compareItemsByFuzzyScore,
  prepareQuery,
  scoreFuzzy,
  scoreItemFuzzy,
  type FuzzyScorerCache,
  type IItemAccessor,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/fuzzyScorer";

/** A highlighted span, [start, end) in characters. */
export interface Span {
  start: number;
  end: number;
}

export interface RankedPath {
  path: string;
  /** Spans to mark within `path`. */
  spans: Span[];
}

const pathAccessor: IItemAccessor<string> = {
  getItemLabel: (p) => p.slice(p.lastIndexOf("/") + 1),
  getItemDescription: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""),
  getItemPath: (p) => p,
};

/**
 * Repository-relative paths that match `query`, best first, at most `limit`.
 * Ties keep the order the paths came in.
 */
export function rankPaths(paths: readonly string[], query: string, limit = Infinity): RankedPath[] {
  const prepared = prepareQuery(query);
  if (!prepared.normalized) return paths.slice(0, limit).map((path) => ({ path, spans: [] }));
  const cache: FuzzyScorerCache = {};
  const scored: { path: string; index: number; spans: Span[] }[] = [];
  paths.forEach((path, index) => {
    const s = scoreItemFuzzy(path, prepared, true, pathAccessor, cache);
    if (!s.score) return;
    // Label spans are within the file name; move them to the full path.
    const base = path.lastIndexOf("/") + 1;
    const spans = [
      ...(s.descriptionMatch ?? []),
      ...(s.labelMatch ?? []).map((m) => ({ start: m.start + base, end: m.end + base })),
    ];
    scored.push({ path, index, spans });
  });
  scored.sort((a, b) =>
    compareItemsByFuzzyScore(a.path, b.path, prepared, true, pathAccessor, cache) || a.index - b.index);
  return scored.slice(0, limit).map(({ path, spans }) => ({ path, spans }));
}

/**
 * Score one string against a query: higher is better, null for no match, 0
 * for an empty query (so an unfiltered list keeps its order).
 */
export function scoreText(text: string, query: string): number | null {
  const q = query.trim();
  if (!q) return 0;
  // Pieces separated by spaces must each match; the score is their sum.
  let total = 0;
  for (const piece of q.split(/\s+/)) {
    const [score] = scoreFuzzy(text, piece, piece.toLowerCase(), true);
    if (!score) return null;
    total += score;
  }
  return total;
}
