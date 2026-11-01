/**
 * The user's shortcut overrides, shared by everything that handles keys.
 *
 * A module-level store rather than React state, because key handlers in the
 * app and in each editor pane read it on every keystroke, and none of them
 * should re-subscribe their listeners just because a binding changed.
 *
 * Kept in localStorage like the theme: shortcuts are a per-machine
 * preference. Only overrides are stored, so a changed default still reaches
 * everyone who never touched that command.
 */

import { useSyncExternalStore } from "react";
import {
  assign, chordFromEvent, formatChord, keyFor, lookup, reset, sanitize,
  type Overrides, type Scope,
} from "../../shared/keymap.js";

const STORAGE_KEY = "fove.keys";

function load(): Overrides {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

let overrides: Overrides = load();
const listeners = new Set<() => void>();

function commit(next: Overrides): void {
  overrides = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // An unwritable store keeps the change for this session only.
  }
  for (const l of listeners) l();
}

export const keymap = {
  get: (): Overrides => overrides,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set: (id: string, chord: string | null) => commit(assign(overrides, id, chord)),
  reset: (id: string) => commit(reset(overrides, id)),
  resetAll: () => commit({}),
  /** The command a key event triggers in a scope, if any. */
  match(e: KeyboardEvent, scope: Scope): string | undefined {
    const chord = chordFromEvent(e);
    return chord ? lookup(overrides, scope, chord) : undefined;
  },
  /** A command's key as a hint, e.g. "⇧⌘F", or "" when it has none. */
  hint: (id: string): string => formatChord(keyFor(overrides, id)),
};

/** Re-render when any binding changes. */
export function useKeymap(): Overrides {
  return useSyncExternalStore(keymap.subscribe, keymap.get);
}
