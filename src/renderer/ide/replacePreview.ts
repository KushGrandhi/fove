/**
 * The Search pane's replace preview: the pattern and the replacement exactly
 * as VS Code's find builds them (see replace.ts, which applies the same two).
 */

import { createRegExp } from "@codingame/monaco-vscode-api/vscode/vs/base/common/strings";
import { parseReplaceString } from "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/find/browser/replacePattern";

export interface ReplaceQuery {
  query: string;
  replace: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/** A line split into kept text, matched text that goes, and text that comes in. */
export type PreviewPart = { kind: "same" | "old" | "new"; text: string };

/** The search as a global JS regex, or null when the pattern does not compile. */
export function patternOf(q: ReplaceQuery): RegExp | null {
  try {
    return createRegExp(q.query, q.regex === true, {
      matchCase: q.caseSensitive === true,
      wholeWord: q.wholeWord === true,
      global: true,
      unicode: true,
    });
  } catch {
    return null;
  }
}

/** One line, with every match struck out and its replacement after it. */
export function previewLine(text: string, q: ReplaceQuery): PreviewPart[] {
  const re = patternOf(q);
  if (!re || !q.query) return [{ kind: "same", text }];
  const pattern = parseReplaceString(q.replace);
  const parts: PreviewPart[] = [];
  let at = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > at) parts.push({ kind: "same", text: text.slice(at, m.index) });
    parts.push({ kind: "old", text: m[0] });
    const replacement = pattern.buildReplaceString([...m]);
    if (replacement) parts.push({ kind: "new", text: replacement });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ kind: "same", text: text.slice(at) });
  return parts;
}

