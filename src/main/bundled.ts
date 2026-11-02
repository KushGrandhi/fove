/**
 * Binaries fove ships for a new user's sake: ruff and ripgrep.
 *
 * scripts/fetch-tools.mjs downloads each one pinned and checksummed into
 * build/bin, and electron-builder copies that folder to Resources/bin. A tool
 * the user installed themselves still wins wherever both exist; these are the
 * fallback that makes the feature work with nothing installed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The bundled copy of `name`, or null (a dev checkout that never fetched it). */
export function bundledBin(name: string): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources ? [join(resources, "bin", name)] : []),
    // The repository's build/bin, in development: three levels up from the
    // compiled dist/main/main/*.js, two from the source under test.
    join(__dirname, "..", "..", "..", "build", "bin", name),
    join(__dirname, "..", "..", "build", "bin", name),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}
