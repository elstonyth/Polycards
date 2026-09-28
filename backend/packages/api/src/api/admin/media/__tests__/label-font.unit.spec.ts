import sharp from 'sharp';
import {
  BODY_FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  ensureBundledFonts,
  LABEL_FONT_FAMILY,
} from '../label-font';

// §7: assert rendered metrics of a known string so a font regression fails a
// test instead of shipping. W-vs-i ink-width ratio separates Arial-metric
// Arimo (~4.2) from the DejaVu Sans fallback (~3.3) far outside noise.
const inkWidth = async (text: string): Promise<number> => {
  const svg = Buffer.from(
    `<svg width="4000" height="300" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="10" y="200" font-family="${LABEL_FONT_FAMILY}" font-size="100">${text}</text></svg>`,
  );
  const { info } = await sharp(svg)
    .trim()
    .toBuffer({ resolveWithObject: true });
  return info.width;
};

// sharp's prebuilt Windows binary ignores FONTCONFIG_PATH (verified via
// FC_DEBUG) — 'Arimo' cannot be injected on win32. Skip locally; the
// regression check runs for real on Linux/CI, which is what prod ships.
const suite = process.platform === 'win32' ? describe.skip : describe;

suite('bundled label font', () => {
  beforeAll(() => ensureBundledFonts());

  it('resolves Arimo (Arial metrics), not a DejaVu fallback', async () => {
    const w = await inkWidth('WWWWWWWWWW');
    const i = await inkWidth('iiiiiiiiii');
    expect(w / i).toBeGreaterThan(3.8);
  });

  // fontconfig here knows ONLY the bundled faces, so a face that failed to
  // load (e.g. a WOFF2 sharp's FreeType cannot read) silently renders as one
  // of the others. Pairwise-different pixels prove all three really resolved.
  it('resolves every bundled face — the pull card needs Nekst and Geist too', async () => {
    const render = (family: string) =>
      sharp(
        Buffer.from(
          `<svg width="900" height="160" xmlns="http://www.w3.org/2000/svg">` +
            `<text x="10" y="120" font-family="${family}" font-size="100">Rag 2,290</text></svg>`,
        ),
      )
        .raw()
        .toBuffer();
    const faces = await Promise.all(
      [LABEL_FONT_FAMILY, DISPLAY_FONT_FAMILY, BODY_FONT_FAMILY].map(render),
    );
    expect(faces[0].equals(faces[1])).toBe(false);
    expect(faces[0].equals(faces[2])).toBe(false);
    expect(faces[1].equals(faces[2])).toBe(false);
  });
});
