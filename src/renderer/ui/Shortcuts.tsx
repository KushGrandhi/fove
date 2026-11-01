/**
 * The keyboard shortcuts screen: every fove command, its key, and a way to
 * change it.
 *
 * Click a key (or "add key") and press the new one. macOS's own keys are
 * refused, a key another command had is moved over with a note saying so,
 * and a key macOS or VS Code use for something else is allowed with a
 * warning. Escape cancels a recording; Backspace removes the key.
 */

import { useEffect, useMemo, useState } from "react";
import { C } from "./Chrome.js";
import { keymap, useKeymap } from "./keymap-store.js";
import {
  COMMANDS, COMMAND_BY_ID, check, chordFromEvent, formatChord, hasModifier, keyFor,
  normalize, type Command,
} from "../../shared/keymap.js";

const SCOPE_NOTE: Record<string, string> = {
  terminal: "in terminal and Claude panes",
  editor: "in the editor pane",
};

export function Shortcuts(props: { onClose: () => void }) {
  const overrides = useKeymap();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; tone: string } | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = COMMANDS.filter((c) => {
      if (!q) return true;
      const key = formatChord(keyFor(overrides, c.id)).toLowerCase();
      return c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || key.includes(q);
    });
    const out = new Map<string, Command[]>();
    for (const c of shown) out.set(c.group, [...(out.get(c.group) ?? []), c]);
    return [...out];
  }, [query, overrides]);

  /*
   * While recording, every key goes to the recorder and nowhere else --
   * capture phase, so neither the app's shortcuts nor a focused pane see it.
   */
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (bare && e.key === "Escape") { setRecording(null); return; }
      if (bare && (e.key === "Backspace" || e.key === "Delete")) {
        keymap.set(recording, null);
        setNote({ id: recording, text: "Key removed. Still in the command palette.", tone: C.faint });
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // a modifier on its own: keep waiting for the key
      if (!hasModifier(chord)) {
        setNote({ id: recording, text: "Add ⌘, ⌃ or ⌥, so it can't fire while you type.", tone: C.yellow });
        return;
      }
      const result = check(keymap.get(), recording, chord);
      if (result.reserved) {
        setNote({ id: recording, text: `${formatChord(chord)} is macOS's ${result.reserved}. Pick another key.`, tone: C.red });
        return;
      }
      keymap.set(recording, chord);
      const def = COMMAND_BY_ID.get(recording)?.key;
      const isDefault = def != null && normalize(def) === normalize(chord);
      if (result.clash) {
        const from = COMMAND_BY_ID.get(result.clash)?.label ?? result.clash;
        setNote({ id: recording, text: `Moved from "${from}", which now has no key.`, tone: C.yellow });
      } else if (result.standard && !isDefault) {
        setNote({ id: recording, text: `Heads up: ${formatChord(chord)} usually means ${result.standard}.`, tone: C.yellow });
      } else {
        setNote(null);
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const changed = Object.keys(overrides).length;

  return (
    <div style={S.scrim} onMouseDown={props.onClose}>
      <div style={S.box} onMouseDown={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={S.title}>Keyboard shortcuts</span>
          <span style={S.sub}>macOS first, then VS Code. Click a key to change it.</span>
          <div style={{ flex: 1 }} />
          {changed > 0 && (
            <button style={S.link} onClick={() => { keymap.resetAll(); setNote(null); }}>
              Reset all ({changed})
            </button>
          )}
          <button style={S.link} onClick={props.onClose}>Done</button>
        </div>
        <input
          autoFocus
          value={query}
          placeholder="Search commands or keys…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
          }}
          style={S.input}
        />
        <div style={S.list}>
          {groups.length === 0 && <div style={S.none}>no matches</div>}
          {groups.map(([group, cmds]) => (
            <div key={group}>
              <div style={S.group}>{group}</div>
              {cmds.map((c) => {
                const key = keyFor(overrides, c.id);
                const isRecording = recording === c.id;
                const overridden = Object.prototype.hasOwnProperty.call(overrides, c.id);
                return (
                  <div key={c.id}>
                    <div style={S.row}>
                      <span style={S.label}>
                        {c.label}
                        {SCOPE_NOTE[c.scope] && <span style={S.scope}> · {SCOPE_NOTE[c.scope]}</span>}
                      </span>
                      <div style={{ flex: 1 }} />
                      {overridden && !isRecording && (
                        <button
                          style={S.link}
                          title={`Default: ${formatChord(c.key) || "none"}`}
                          onClick={() => { keymap.reset(c.id); setNote(null); }}
                        >
                          reset
                        </button>
                      )}
                      <button
                        style={{
                          ...S.chip,
                          ...(isRecording ? S.chipOn : null),
                          ...(key || isRecording ? null : S.chipEmpty),
                        }}
                        onClick={() => { setNote(null); setRecording(isRecording ? null : c.id); }}
                      >
                        {isRecording ? "press keys…  ⎋ cancel  ⌫ remove" : key ? formatChord(key) : "add key"}
                      </button>
                    </div>
                    {note?.id === c.id && (
                      <div style={{ ...S.note, color: note.tone }}>{note.text}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  scrim: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    display: "flex", justifyContent: "center", alignItems: "flex-start",
    paddingTop: "8vh", zIndex: 60,
  },
  box: {
    width: "min(640px, 90vw)", background: C.panel, color: C.fg,
    border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)", fontFamily: "system-ui", fontSize: 12,
  },
  head: {
    display: "flex", alignItems: "baseline", gap: 10, padding: "12px 14px 8px",
  },
  title: { fontSize: 13, fontWeight: 600 },
  sub: { color: C.faint, fontSize: 11 },
  input: {
    width: "100%", boxSizing: "border-box", background: "transparent", color: C.fg,
    border: "none", borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}`,
    padding: "9px 14px", fontSize: 12, outline: "none", fontFamily: "inherit",
  },
  list: { maxHeight: "66vh", overflow: "auto", paddingBottom: 8 },
  group: {
    padding: "10px 14px 4px", color: C.faint, fontSize: 10,
    textTransform: "uppercase", letterSpacing: 0.6,
  },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "4px 14px", minHeight: 24 },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  scope: { color: C.faint },
  chip: {
    fontFamily: "Menlo, monospace", fontSize: 11, color: C.fg, background: C.chromeHi,
    border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 8px",
    cursor: "pointer", minWidth: 48, textAlign: "center",
  },
  chipOn: { borderColor: C.accent, color: C.accent, fontFamily: "system-ui" },
  chipEmpty: { color: C.faint, background: "transparent", fontFamily: "system-ui" },
  link: {
    background: "none", border: "none", color: C.dim, cursor: "pointer",
    fontSize: 11, padding: "2px 4px", fontFamily: "inherit",
  },
  note: { padding: "0 14px 6px", fontSize: 11, textAlign: "right" },
  none: { padding: "14px", color: C.faint, textAlign: "center" },
};
