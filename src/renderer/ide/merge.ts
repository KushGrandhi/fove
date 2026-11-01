/**
 * Three-way merge of a buffer with an outside change, line by line.
 *
 * The case it exists for: you are editing a file, an agent writes to it, and
 * you press save. VS Code's text-file service refuses that save -- it would
 * overwrite the agent's work -- and this decides what happens instead:
 *
 *   base   what the file was when your buffer last matched the disk
 *   mine   your buffer
 *   theirs the disk now
 *
 * Edits to different lines combine cleanly. Edits to the same lines become
 * git-style conflict blocks, so nothing is dropped from either side and the
 * blocks read the way every developer already knows from `git merge`.
 *
 * The diffing itself is `node-diff3` (MIT), the same algorithm GNU diff3 uses.
 */

import { diff3Merge } from "node-diff3";

export const MARK_MINE = "<<<<<<< your edits";
export const MARK_SPLIT = "=======";
export const MARK_THEIRS = ">>>>>>> on disk";

export interface MergeOutcome {
  text: string;
  /** How many blocks need a person to choose. 0 means saved as-is is safe. */
  conflicts: number;
}

/**
 * Split keeping each line's own ending, so a file's CRLFs or a missing final
 * newline come back out exactly as they went in.
 */
function lines(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Make sure a block ends in a newline before a marker line follows it. */
function closed(block: string[]): string[] {
  if (block.length === 0) return block;
  const last = block[block.length - 1]!;
  return last.endsWith("\n") ? block : [...block.slice(0, -1), `${last}\n`];
}

export function threeWay(base: string, mine: string, theirs: string): MergeOutcome {
  if (mine === theirs) return { text: mine, conflicts: 0 };
  if (mine === base) return { text: theirs, conflicts: 0 };
  if (theirs === base) return { text: mine, conflicts: 0 };

  const regions = diff3Merge(lines(mine), lines(base), lines(theirs), {
    // Both sides made the same change: that is agreement, not a conflict.
    excludeFalseConflicts: true,
  });

  const out: string[] = [];
  let conflicts = 0;
  for (const r of regions) {
    if (r.ok) {
      out.push(...r.ok);
    } else if (r.conflict) {
      conflicts++;
      out.push(
        `${MARK_MINE}\n`,
        ...closed(r.conflict.a),
        `${MARK_SPLIT}\n`,
        ...closed(r.conflict.b),
        `${MARK_THEIRS}\n`,
      );
    }
  }
  return { text: out.join(""), conflicts };
}

/** Whether a buffer still holds conflict blocks from `threeWay`. */
export function hasConflictMarkers(text: string): boolean {
  return text.split("\n").some((l) => l === MARK_MINE || l === MARK_THEIRS);
}
