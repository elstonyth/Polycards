import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ARIMO_FONT_B64 } from './arimo-font-b64';
import { GEIST_FONT_B64 } from './geist-font-b64';
import { NEKST_FONT_B64 } from './nekst-font-b64';

/** The slab label face (bake-slab). */
export const LABEL_FONT_FAMILY = 'Arimo';
/** Storefront display face — the Telegram pull card's name, values and chip.
 *  Its one file is the Black cut but is tagged weight 400, so request it at
 *  normal weight: asking for bold makes pango synthesise a smeared faux-bold. */
export const DISPLAY_FONT_FAMILY = 'Nekst';
/** Storefront body face — the Telegram pull card's labels. Regular only. */
export const BODY_FONT_FAMILY = 'Geist';

let installed = false;

// Materialise EVERY bundled TTF + a minimal fontconfig into the OS temp dir
// and point fontconfig at it, so sharp/librsvg (pango) resolve these families
// deterministically on the Linux prod container (which has no fonts at all).
// MUST run before the first <text> render in this process — fontconfig reads
// FONTCONFIG_PATH once, lazily, at first text layout — which is why it is one
// installer for all faces rather than one per caller: a second caller's fonts
// would be invisible once the first caller had rendered. bakeSlabImage and the
// Telegram pull card both call this before composing.
// (sharp's prebuilt Windows binary ignores FONTCONFIG_PATH, so on win32 dev
// these families fall back to a system face — see label-font.unit.spec.ts.)
export function ensureBundledFonts(): void {
  if (installed) return;
  // mkdtemp (0700 + unpredictable suffix), NOT a fixed world-shared tmpdir
  // path: a predictable shared path could be pre-created by another local
  // user, letting them swap the font/fontconfig under us (and the old
  // existsSync reuse would happily trust their file). Costs one ~1MB write
  // per process boot; stale dirs are left to normal OS tmp cleanup.
  const dir = mkdtempSync(path.join(tmpdir(), 'polycards-fonts-'));
  const cacheDir = path.join(dir, 'cache');
  const confPath = path.join(dir, 'fonts.conf');
  mkdirSync(cacheDir);
  for (const [file, b64] of [
    ['Arimo-Variable.ttf', ARIMO_FONT_B64],
    ['Nekst-Black.ttf', NEKST_FONT_B64],
    ['Geist-Regular.ttf', GEIST_FONT_B64],
  ]) {
    writeFileSync(path.join(dir, file), Buffer.from(b64, 'base64'));
  }
  writeFileSync(
    confPath,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${dir}</dir>\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`,
  );
  process.env.FONTCONFIG_PATH = dir;
  process.env.FONTCONFIG_FILE = confPath;
  installed = true;
}
