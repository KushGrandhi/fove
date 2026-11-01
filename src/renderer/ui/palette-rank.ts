/**
 * Filtering and ranking for the command palette.
 *
 * Subsequence matching, not substring: typing `cpt` should find
 * `core-python-tests`, which is the whole reason a palette beats a dropdown.
 * The scorer is VS Code's (fuzzy.ts); this file adds the palette's own rules
 * on top: priority first, then a label match over a keyword-only one.
 */

import { scoreText } from "./fuzzy.js";

export interface Badge {
  text: string;
  /** A CSS colour, for status that should read at a glance. */
  tone?: string;
}

export interface Item {
  id: string;
  label: string;
  /** Extra text that should also match the query, e.g. a full path. */
  keywords?: string;
  detail?: string;
  icon?: string;
  hint?: string;
  badges?: Badge[];
  /** Sorts before anything with a lower priority, regardless of score. */
  priority?: number;
  run: () => void;
}

interface Scored {
  item: Item;
  /** Matched on the visible label, which beats any match on keywords alone. */
  label: boolean;
  score: number;
  index: number;
}

/**
 * Score one candidate against a query, or null when it does not match.
 *
 * Higher is better; 0 for an empty query so the caller keeps the original
 * order. The scoring is VS Code's quick open scorer (see fuzzy.ts).
 */
export function score(text: string, query: string): number | null {
  return scoreText(text, query);
}

/**
 * The items matching `query`, best first.
 *
 * Ties break on the original order, so a caller's deliberate arrangement (the
 * current worktree first, say) survives an empty or ambiguous query.
 */
export function rank(items: readonly Item[], query: string): Item[] {
  const out: Scored[] = [];
  items.forEach((item, index) => {
    const label = score(item.label, query);
    // Keywords match at a discount: a hit on the full path is real, but a hit
    // on the visible label is a better answer to what was typed.
    const keyword = item.keywords ? score(item.keywords, query) : null;
    if (label === null && keyword === null) return;
    out.push({ item, label: label !== null, score: label ?? keyword ?? 0, index });
  });

  out.sort((a, b) => {
    const pa = a.item.priority ?? 0;
    const pb = b.item.priority ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.label !== b.label) return a.label ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
  return out.map((s) => s.item);
}
