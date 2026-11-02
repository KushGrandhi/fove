/**
 * What each file looked like before Claude's latest turn changed it.
 *
 * Claude Code records every Edit and Write with the file's full text from
 * before that change (`toolUseResult.originalFile`). The first such record
 * for a file within a turn is therefore exactly what the file was when the
 * turn reached it -- no snapshot, no guessing from timestamps.
 *
 * This is the "original" for the editor's turn review: VS Code's change
 * markers drawn against it show what the turn did, hunk by hunk, and its
 * inline diff can revert any one of them.
 */

import { promptText, timeOf, type TurnRecord } from "./turns.js";

export interface TurnOriginals {
  /** The uuid of the prompt that opened the turn. */
  turnId: string;
  prompt: string;
  startedAt: number;
  /**
   * Absolute path -> its text before the turn's first change to it. "" for a
   * file the turn created.
   */
  files: Record<string, string>;
}

interface EditResult {
  filePath?: unknown;
  originalFile?: unknown;
  type?: unknown;
}

/**
 * The latest turn that changed files, with each file's original.
 *
 * The latest turn *that changed files*, not simply the latest: after a turn
 * that edits ten files, a follow-up like "thanks" would otherwise leave
 * nothing to review. Subagent edits (sidechain records) count -- they are
 * part of what the turn did to the tree.
 */
export function latestTurnOriginals(records: TurnRecord[]): TurnOriginals | null {
  let current: TurnOriginals | null = null;
  let latestWithFiles: TurnOriginals | null = null;

  for (const rec of records) {
    const prompt = promptText(rec);
    if (prompt !== null) {
      const startedAt = timeOf(rec);
      current = { turnId: rec.uuid ?? `t${startedAt ?? 0}`, prompt, startedAt: startedAt ?? 0, files: {} };
      continue;
    }
    if (!current) continue;
    const result = (rec as { toolUseResult?: EditResult }).toolUseResult;
    if (!result || typeof result !== "object" || typeof result.filePath !== "string") continue;
    if (!("originalFile" in result)) continue;
    const path = result.filePath;
    // Only the first change in the turn: later ones start from the turn's
    // own edits, which is not what the review compares against.
    if (path in current.files) continue;
    current.files[path] = typeof result.originalFile === "string" ? result.originalFile : "";
    latestWithFiles = current;
  }
  return latestWithFiles;
}
