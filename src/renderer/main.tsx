// Keel's typefaces, bundled rather than fetched: a packaged app has no
// network, and a Google Fonts link would fall back to system-ui in silence.
// Only the weights the design uses -- 400 body, 500 labels, 700 titles.
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import { createRoot } from "react-dom/client";
import { PopoutWindow } from "./PopoutWindow.js";
import { App } from "./App.js";
import type { ThApi } from "../main/preload.js";
import { startServices } from "./ide/vscode.js";

declare global {
  interface Window { th: ThApi }
}

// A window opened with ?popout=<paneId> renders that pane alone; the PTY is
// already running in the main process and is attached to, never restarted.
const popoutPaneId = window.th.popoutPaneId();

/*
 * VS Code's editor services must exist before the first editor is created.
 * Starting them never rejects -- a failure is reported inside the editor
 * pane -- so terminals and agents come up either way.
 */
void startServices().then(() => {
  createRoot(document.getElementById("root")!).render(
    popoutPaneId ? <PopoutWindow paneId={popoutPaneId} /> : <App />,
  );
});
