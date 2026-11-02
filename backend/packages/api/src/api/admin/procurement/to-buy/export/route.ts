import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import sharp from 'sharp';
// Same two-part ceremony as inventory/export.xlsx/route.ts, for the same
// reason (write-excel-file 4 is ESM-only under this package's Node16
// resolution): the TYPES with an explicit resolution-mode, the VALUE via
// `await import()`. See that file's import note for the swc-vs-tsc story.
import type { Cell, CellObject, Image, Row } from 'write-excel-file/node' with {
  'resolution-mode': 'import',
};
import {
  currentToBuyList,
  type ToBuyListRow,
} from '../../../../../modules/packs/procurement-view';
import { fetchBytes, MAX_DECODE_PIXELS } from '../../../../utils/image-fetch';

// Every size below is in screen pixels at 96 dpi: the library multiplies image
// sizes and offsets by 9525 EMU, a column is 7 px per width unit (Calibri 11),
// and a row height is in points, 3/4 of a pixel.
const PICTURE_MAX_WIDTH_PX = 130;
const PICTURE_MAX_HEIGHT_PX = 182;
const COLUMN_WIDTH_UNITS = 22;
export const COLUMN_WIDTH_PX = COLUMN_WIDTH_UNITS * 7;
export const ROW_HEIGHT_PX = 196;

const WIDTHS = [COLUMN_WIDTH_UNITS, 32, 28, 11, 8, 13, 13, 16];

// Enough fetches at once to finish a long list inside the gateway timeout,
// few enough that the decodes stay small next to the API's own traffic.
const PICTURE_CONCURRENCY = 6;

export type SheetPicture = { content: Buffer; width: number; height: number };

const BASE: CellObject = {
  align: 'center',
  alignVertical: 'center',
  borderColor: '#BFBFBF',
  borderStyle: 'thin',
  fontSize: 11,
};
// The buyers' own sheet has this yellow header; they read it at a glance.
const HEADER: CellObject = {
  ...BASE,
  backgroundColor: '#FFFF00',
  fontWeight: 'bold',
  height: 24,
};
const BODY: CellObject = { ...BASE, height: (ROW_HEIGHT_PX * 3) / 4 };

const HEADERS = [
  'PICTURE',
  'NAME',
  'SERIES',
  'RAW/PSA',
  'QTY',
  'PRICE (USD)',
  'PRICE (RM)',
  'STATUS',
];

const rawOrPsa = (r: ToBuyListRow): string =>
  r.graded ? (r.grade ?? 'SLAB') : 'RAW';

const money = (value: number | null): Cell =>
  value === null ? BODY : { ...BODY, value, type: Number, format: '#,##0.00' };

const sheetRow = (r: ToBuyListRow, hasPicture: boolean): Row => [
  hasPicture
    ? BODY
    : {
        ...BODY,
        value: 'No image',
        fontStyle: 'italic',
        textColor: '#7F7F7F',
      },
  { ...BODY, value: r.name, wrap: true, fontWeight: 'bold' },
  { ...BODY, value: r.set ?? undefined, wrap: true },
  { ...BODY, value: rawOrPsa(r) },
  {
    ...BODY,
    value: r.to_procure,
    type: Number,
    fontWeight: 'bold',
    fontSize: 14,
  },
  money(r.fmv_usd),
  money(r.fmv),
  // Left blank for the buyers to fill in, as on their own sheet.
  BODY,
];

/** The row's picture as the sheet holds it: always a JPEG, because Excel has no
 *  WebP and our card art is WebP. Twice the display size, to stay sharp when
 *  zoomed. White behind any transparent corner, which is what the cell is. Null
 *  when it can't be had: a bad picture must not cost the buyers the whole list. */
export async function sheetPicture(url: string): Promise<SheetPicture | null> {
  const bytes = await fetchBytes(url);
  if (!bytes) return null;
  try {
    const { data, info } = await sharp(bytes, {
      limitInputPixels: MAX_DECODE_PIXELS,
    })
      .resize(PICTURE_MAX_WIDTH_PX * 2, PICTURE_MAX_HEIGHT_PX * 2, {
        fit: 'inside',
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return {
      content: data,
      width: Math.round(info.width / 2),
      height: Math.round(info.height / 2),
    };
  } catch {
    return null;
  }
}

/** `pictures` lines up with `rows`, null where a row has none. */
export async function toBuyWorkbook(
  rows: ToBuyListRow[],
  pictures: (SheetPicture | null)[],
): Promise<Buffer> {
  const images = rows.flatMap((r, i): Image[] => {
    const pic = pictures[i];
    return pic
      ? [
          {
            content: pic.content,
            contentType: 'image/jpeg',
            width: pic.width,
            height: pic.height,
            dpi: 96,
            // Row 1 is the header.
            anchor: { row: i + 2, column: 1 },
            offsetX: Math.round((COLUMN_WIDTH_PX - pic.width) / 2),
            offsetY: Math.round((ROW_HEIGHT_PX - pic.height) / 2),
            description: r.name,
          },
        ]
      : [];
  });

  // See the import note at the top of this file for why this is dynamic.
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  return writeXlsxFile(
    [
      HEADERS.map((value) => ({ ...HEADER, value })),
      ...rows.map((r, i) => sheetRow(r, pictures[i] !== null)),
    ],
    {
      sheet: 'To buy',
      columns: WIDTHS.map((width) => ({ width })),
      stickyRowsCount: 1,
      showGridLines: false,
      images,
    },
  ).toBuffer();
}

// GET /admin/procurement/to-buy/export — the To buy list as a .xlsx with each
// card's picture in its row, laid out like the sheet the buyers already keep.
// currentToBuyList, so the rows are the ones on screen: while the list is
// frozen, the frozen list. No dot in the path on purpose (see
// players/export/route.ts); procurement:read comes with the /admin/procurement
// prefix, and the assistant proxy refuses `/export` paths.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { rows } = await currentToBuyList(req.scope);

  const pictures: (SheetPicture | null)[] = [];
  for (let i = 0; i < rows.length; i += PICTURE_CONCURRENCY) {
    pictures.push(
      ...(await Promise.all(
        rows
          .slice(i, i + PICTURE_CONCURRENCY)
          .map((r) => (r.image ? sheetPicture(r.image) : null)),
      )),
    );
  }
  const missing = pictures.filter((p) => p === null).length;
  if (missing) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[procurement] export: ${missing}/${rows.length} rows no picture`);
  }

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="procurement-to-buy-${new Date().toISOString().slice(0, 10)}.xlsx"`,
  );
  res.send(await toBuyWorkbook(rows, pictures));
}
