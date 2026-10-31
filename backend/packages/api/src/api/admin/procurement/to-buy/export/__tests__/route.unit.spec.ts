import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import {
  COLUMN_WIDTH_PX,
  ROW_HEIGHT_PX,
  sheetPicture,
  toBuyWorkbook,
  type SheetPicture,
} from '../route';
import type { ToBuyListRow } from '../../../../../../modules/packs/procurement-view';
import { fetchBytes } from '../../../../../utils/image-fetch';

jest.mock('../../../../../utils/image-fetch', () => ({
  ...jest.requireActual('../../../../../utils/image-fetch'),
  fetchBytes: jest.fn(),
}));
const fetched = fetchBytes as jest.Mock;

const row = (over: Partial<ToBuyListRow> = {}): ToBuyListRow => ({
  handle: 'card-a',
  name: 'Ampharos #29',
  sku: 'CARD-A',
  photo: null,
  image: 'https://cdn/card.webp',
  graded: false,
  grade: null,
  set: 'Pokemon Chaos Rising',
  to_procure: 3,
  on_hand: 0,
  requested: 3,
  ready_to_ship: 0,
  fmv: 7.51,
  fmv_usd: 1.85,
  oldest_order_at: null,
  ...over,
});

const picture = (width: number, height: number): SheetPicture => ({
  content: Buffer.from('jpeg-bytes'),
  width,
  height,
});

const unpack = async (
  rows: ToBuyListRow[],
  pictures: (SheetPicture | null)[],
) => {
  const parts = unzipSync(new Uint8Array(await toBuyWorkbook(rows, pictures)));
  const text = (name: string) => strFromU8(parts[name]);
  const media = Object.keys(parts).filter((p) => p.startsWith('xl/media/'));
  const strings = text('xl/sharedStrings.xml');
  return { parts, text, media, strings };
};

// The picture is what the sheet exists for, so these read the shipped writer's
// output back rather than trusting the options handed to it.
describe('to-buy workbook', () => {
  it('embeds one picture per row, on that row, centred in its cell', async () => {
    const { media, text } = await unpack(
      [row(), row({ handle: 'card-b' })],
      [picture(120, 168), picture(100, 168)],
    );
    expect(media).toHaveLength(2);
    const anchors = [
      ...text('xl/drawings/drawing1.xml').matchAll(
        /<xdr:col>(\d+)<\/xdr:col><xdr:colOff>(\d+)<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(\d+)<\/xdr:rowOff>/g,
      ),
    ].map((m) => m.slice(1).map(Number));
    const emu = (px: number) => Math.round(px) * 9525;
    expect(anchors).toEqual([
      // Row 1 is the header, so the first card sits on 0-based row 1.
      [0, emu((COLUMN_WIDTH_PX - 120) / 2), 1, emu((ROW_HEIGHT_PX - 168) / 2)],
      [0, emu((COLUMN_WIDTH_PX - 100) / 2), 2, emu((ROW_HEIGHT_PX - 168) / 2)],
    ]);
  });

  it('row height holds the picture, header stays frozen', async () => {
    const { text } = await unpack([row()], [picture(120, 168)]);
    const sheet = text('xl/worksheets/sheet1.xml');
    // Points are 3/4 of a pixel.
    expect(sheet).toMatch(
      new RegExp(`<row[^>]*r="2"[^>]*ht="${(ROW_HEIGHT_PX * 3) / 4}"`),
    );
    expect(sheet).toContain('state="frozen"');
  });

  it('writes the buyers’ columns: series, RAW or the slab grade, qty, price', async () => {
    const { strings, text } = await unpack(
      [row(), row({ graded: true, grade: 'PSA 10', name: 'Mew ex #158' })],
      [null, null],
    );
    for (const header of [
      'PICTURE',
      'NAME',
      'SERIES',
      'RAW/PSA',
      'QTY',
      'PRICE (USD)',
      'PRICE (RM)',
      'STATUS',
    ]) {
      expect(strings).toContain(`>${header}<`);
    }
    expect(strings).toContain('>Pokemon Chaos Rising<');
    expect(strings).toContain('>RAW<');
    expect(strings).toContain('>PSA 10<');
    const sheet = text('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<v>1.85</v>');
    expect(sheet).toContain('<v>7.51</v>');
  });

  it('a graded row with no grade recorded still says it is a slab', async () => {
    const { strings } = await unpack(
      [row({ graded: true, grade: null })],
      [null],
    );
    expect(strings).toContain('>SLAB<');
    expect(strings).not.toContain('>RAW<');
  });

  it('a missing picture keeps the row and says so', async () => {
    const { media, strings } = await unpack([row()], [null]);
    expect(media).toHaveLength(0);
    expect(strings).toContain('>Ampharos #29<');
    expect(strings).toContain('>No image<');
  });

  it('an unknown price is an empty cell, not a zero', async () => {
    const { text } = await unpack([row({ fmv: null, fmv_usd: null })], [null]);
    const sheet = text('xl/worksheets/sheet1.xml');
    // Styled for its border, no value: a 0 would read as a free card.
    expect(sheet).toMatch(/<c r="F2" s="\d+"\/>/);
    expect(sheet).toMatch(/<c r="G2" s="\d+"\/>/);
  });

  it('an empty list is a header-only sheet', async () => {
    const { media, strings } = await unpack([], []);
    expect(media).toHaveLength(0);
    expect(strings).toContain('>PICTURE<');
  });
});

describe('sheetPicture', () => {
  beforeEach(() => fetched.mockReset());

  const art = (width: number, height: number) =>
    sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 200, g: 40, b: 40, alpha: 0 },
      },
    });

  // Excel has no WebP, and every card on the CDN is WebP.
  it('turns WebP art into a JPEG, keeping the whole picture', async () => {
    fetched.mockResolvedValue(await art(1000, 1400).webp().toBuffer());
    const pic = await sheetPicture('https://cdn/card.webp');
    expect(pic).not.toBeNull();
    const meta = await sharp(pic!.content).metadata();
    expect(meta.format).toBe('jpeg');
    expect(pic!.width / pic!.height).toBeCloseTo(1000 / 1400, 1);
    // Held at twice its display size so it stays sharp when zoomed.
    expect(meta.width).toBe(pic!.width * 2);
  });

  it.each([
    ['a slab, taller than a card', 600, 1000],
    ['wide art', 1000, 500],
  ])('fits %s inside its cell', async (_what, width, height) => {
    fetched.mockResolvedValue(await art(width, height).png().toBuffer());
    const pic = await sheetPicture('https://cdn/x.png');
    expect(pic!.width).toBeLessThan(COLUMN_WIDTH_PX);
    expect(pic!.height).toBeLessThan(ROW_HEIGHT_PX);
  });

  it('flattens a transparent corner onto the white sheet', async () => {
    fetched.mockResolvedValue(await art(100, 140).png().toBuffer());
    const pic = await sheetPicture('https://cdn/x.png');
    const { data } = await sharp(pic!.content)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250);
  });

  it('no picture when the fetch fails or the bytes are not an image', async () => {
    fetched.mockResolvedValue(null);
    await expect(sheetPicture('https://cdn/x')).resolves.toBeNull();
    fetched.mockResolvedValue(Buffer.from('<html>not an image</html>'));
    await expect(sheetPicture('https://cdn/x')).resolves.toBeNull();
  });
});
