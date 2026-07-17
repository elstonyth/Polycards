import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ARIMO_FONT_B64 } from './arimo-font-b64';

export const LABEL_FONT_FAMILY = 'Arimo';

let installed = false;

// Materialise the bundled Arimo TTF + a minimal fontconfig into the OS temp
// dir and point fontconfig at it, so sharp/librsvg (pango) resolve 'Arimo'
// deterministically on dev AND the Linux prod container (which has no Arial).
// MUST run before the first <text> render in this process — fontconfig reads
// FONTCONFIG_PATH once, lazily, at first text layout. bakeSlabImage calls
// this before composing; the earlier mask SVGs contain no text.
export function ensureLabelFont(): void {
  if (installed) return;
  // mkdtemp (0700 + unpredictable suffix), NOT a fixed world-shared tmpdir
  // path: a predictable shared path could be pre-created by another local
  // user, letting them swap the font/fontconfig under us (and the old
  // existsSync reuse would happily trust their file). Costs one ~662KB write
  // per process boot; stale dirs are left to normal OS tmp cleanup.
  const dir = mkdtempSync(path.join(tmpdir(), 'polycards-label-font-'));
  const cacheDir = path.join(dir, 'cache');
  const fontPath = path.join(dir, 'Arimo-Variable.ttf');
  const confPath = path.join(dir, 'fonts.conf');
  mkdirSync(cacheDir);
  writeFileSync(fontPath, Buffer.from(ARIMO_FONT_B64, 'base64'));
  writeFileSync(
    confPath,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${dir}</dir>\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`,
  );
  process.env.FONTCONFIG_PATH = dir;
  process.env.FONTCONFIG_FILE = confPath;
  installed = true;
}
