import type { MedusaContainer } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { uploadFilesWorkflow } from '@medusajs/medusa/core-flows';
import {
  currentToBuyList,
  type ToBuyListRow,
} from '../modules/packs/procurement-view';
import {
  COLUMN_WIDTH_PX,
  rawOrPsa,
  ROW_HEIGHT_PX,
  sheetPicture,
} from '../api/admin/procurement/to-buy/export/route';
import {
  cellText,
  sameCell,
  sameGrid,
  sameRow,
  usedRows,
  serviceAccountFromEnv,
  sheetsCall,
  SheetsError,
  textCell,
  type Cell,
  type Grid,
  type ServiceAccount,
} from '../utils/google-sheets';
import {
  buildOrdersGrid,
  decideOrderEdit,
  loadSheetOrders,
  ORDER_COL,
  ORDER_HEADERS,
  STATUS_WORD,
  type SheetOrder,
} from '../modules/packs/orders-sheet';
import { updateDeliveryOrderWorkflow } from '../workflows/update-delivery-order';
import { notifyDeliveryChange } from '../api/admin/delivery-orders/notify';

// The To buy list as a live Google Sheet the whole team can open (owner
// 2026-11-25): the buyers mark each card Found / Not found in STATUS. Every
// minute the job compares the sheet with the list the Procurement page shows
// (currentToBuyList) and rewrites it only when they differ: a GRN or PI save,
// the 12am cutoff, a cancel or a Refresh shows within a minute.
//
// STATUS is the buyers' column. It is carried over by card (the hidden CARD
// column), so it follows the card when rows move and goes when the card leaves
// the list. Every other column belongs to the sync: an edit there differs from
// the list, so the next run puts it back.
//
// Turned on by two app-level env vars; with either unset the job does nothing.
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account's JSON key (raw or base64)
//   PROCUREMENT_SHEET_ID         the sheet's id, or its whole URL
// The sheet must be shared with the key's client_email as Editor. The sync
// owns two tabs it finds by name, "To buy" and "All orders" (orders-sheet.ts),
// and adds them when missing.
//
// Pictures: our card art is WebP and Google doesn't say IMAGE() reads WebP, so
// each picture is re-encoded to JPEG (sheetPicture, as in the Export file) and
// uploaded once to our public file store. The hidden PICTURE SOURCE column
// remembers which art the JPEG came from, so it is made again only when the
// card's art changes.

export const HEADERS = [
  'PICTURE',
  'NAME',
  'SERIES',
  'RAW/PSA',
  'QTY',
  'PRICE (USD)',
  'PRICE (RM)',
  'STATUS',
  'CARD',
  'PICTURE SOURCE',
];
const PICTURE = 0;
const STATUS = 7;
const KEY = 8;
const SOURCE = 9;
const COLUMNS = HEADERS.length;

const PICTURE_CONCURRENCY = 6;
/** A picture that failed is tried again after this long, not every minute. */
const PICTURE_RETRY_MS = 60 * 60 * 1000;

export const TO_BUY_TAB = 'To buy';
export const ORDERS_TAB = 'All orders';
const SHEET_ACTOR = 'system:google-sheet';

const str = textCell;
const num = (v: number | null): Cell =>
  v === null || !Number.isFinite(v)
    ? {}
    : { userEnteredValue: { numberValue: Math.round(v * 100) / 100 } };
const text = cellText;

/** The JPEG url inside a cell's =IMAGE("…") formula, if it holds one. */
export function imageUrlOf(c: Cell | undefined): string | null {
  const m = /^=IMAGE\("((?:[^"]|"")*)"/i.exec(
    c?.userEnteredValue?.formulaValue ?? '',
  );
  return m ? m[1].replace(/""/g, '"') : null;
}

/** The sheet's existing body rows by card, header left out. */
export function rowsByCard(existing: Grid): Map<string, Cell[]> {
  const out = new Map<string, Cell[]>();
  for (const row of existing.slice(1)) {
    const key = text(row[KEY]);
    if (key) out.set(key, row);
  }
  return out;
}

/** What the sheet should hold: header, then one row per card in list order.
 *  `pictures` maps a card to its JPEG url and the art it was made from. Names
 *  go in as stringValue, never as typed input, so a name starting with "=" is
 *  text, not a formula. */
export function buildGrid(
  rows: ToBuyListRow[],
  existing: Grid,
  pictures: ReadonlyMap<string, { url: string; source: string }>,
): Grid {
  const old = rowsByCard(existing);
  return [
    HEADERS.map((h) => str(h)),
    ...rows.map((r): Cell[] => {
      const pic = pictures.get(r.handle);
      return [
        pic
          ? {
              userEnteredValue: {
                formulaValue: `=IMAGE("${pic.url.replace(/"/g, '""')}")`,
              },
            }
          : str('No image'),
        str(r.name),
        str(r.set),
        str(rawOrPsa(r)),
        num(r.to_procure),
        num(r.fmv_usd),
        num(r.fmv),
        old.get(r.handle)?.[STATUS] ?? {},
        str(r.handle),
        str(pic?.source),
      ];
    }),
  ];
}

/** The sheet id from PROCUREMENT_SHEET_ID, which may be the whole sheet URL. */
export function sheetIdFrom(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return /\/d\/([\w-]+)/.exec(v)?.[1] ?? v;
}

/** Layout the sync keeps: yellow bold header like the buyers' own sheet,
 *  frozen; picture-sized rows; money as 0.00; a Found / Not found dropdown in
 *  STATUS that still takes free text; the two key columns hidden. */
function toBuyLayout(sheetId: number, bodyRows: number): unknown[] {
  const range = (r0: number, c0: number, c1: number, r1?: number) => ({
    sheetId,
    startRowIndex: r0,
    ...(r1 === undefined ? {} : { endRowIndex: r1 }),
    startColumnIndex: c0,
    endColumnIndex: c1,
  });
  const columns = (start: number, end: number) => ({
    sheetId,
    dimension: 'COLUMNS',
    startIndex: start,
    endIndex: end,
  });
  return [
    {
      repeatCell: {
        range: range(0, 0, COLUMNS, 1),
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 0 } },
            textFormat: { bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields:
          'userEnteredFormat(backgroundColorStyle,textFormat.bold,horizontalAlignment)',
      },
    },
    {
      repeatCell: {
        range: range(1, 0, COLUMNS),
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
          },
        },
        fields:
          'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)',
      },
    },
    {
      repeatCell: {
        range: range(1, 5, 7),
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'NUMBER', pattern: '#,##0.00' },
          },
        },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    {
      setDataValidation: {
        range: range(1, STATUS, STATUS + 1),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [
              { userEnteredValue: 'Found' },
              { userEnteredValue: 'Not found' },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      updateDimensionProperties: {
        range: columns(PICTURE, PICTURE + 1),
        properties: { pixelSize: COLUMN_WIDTH_PX },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: columns(KEY, SOURCE + 1),
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
    ...(bodyRows > 0
      ? [
          {
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: 1,
                endIndex: 1 + bodyRows,
              },
              properties: { pixelSize: ROW_HEIGHT_PX },
              fields: 'pixelSize',
            },
          },
        ]
      : []),
  ];
}

type SheetRead = {
  sheets?: {
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: { rowCount?: number };
    };
    data?: { rowData?: { values?: Cell[] }[] }[];
  }[];
};
type Tab = { sheetId: number; rowCount: number; grid: Grid };

const READ_FIELDS =
  'sheets(properties(sheetId,title,gridProperties(rowCount)),data(rowData(values(userEnteredValue))))';

async function readTabs(
  sa: ServiceAccount,
  spreadsheetId: string,
): Promise<{ tabs: Map<string, Tab>; firstEmpty: number | null }> {
  const read = await sheetsCall<SheetRead>(
    sa,
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(READ_FIELDS)}`,
  );
  const tabs = new Map<string, Tab>();
  let firstEmpty: number | null = null;
  (read.sheets ?? []).forEach((s, i) => {
    const grid = (s.data?.[0]?.rowData ?? []).map((r) => r.values ?? []);
    const tab = {
      sheetId: s.properties?.sheetId ?? 0,
      rowCount: s.properties?.gridProperties?.rowCount ?? 1000,
      grid,
    };
    if (s.properties?.title) tabs.set(s.properties.title, tab);
    if (i === 0 && grid.length === 0) firstEmpty = tab.sheetId;
  });
  return { tabs, firstEmpty };
}

/** The two tabs, made when missing. A blank first tab (the "Sheet1" a new
 *  sheet comes with) becomes To buy rather than staying as an empty extra.
 *  The All orders tab gets its filter row in the same call, once, over every
 *  column (hidden ones too, so a sort through it moves whole rows); later
 *  writes never reset what staff picked in it. */
async function ensureTabs(
  sa: ServiceAccount,
  spreadsheetId: string,
): Promise<Map<string, Tab>> {
  const { tabs, firstEmpty } = await readTabs(sa, spreadsheetId);
  if (tabs.has(TO_BUY_TAB) && tabs.has(ORDERS_TAB)) return tabs;
  const requests: unknown[] = [];
  if (!tabs.has(TO_BUY_TAB)) {
    requests.push(
      firstEmpty !== null
        ? {
            updateSheetProperties: {
              properties: { sheetId: firstEmpty, title: TO_BUY_TAB },
              fields: 'title',
            },
          }
        : { addSheet: { properties: { title: TO_BUY_TAB, index: 0 } } },
    );
  }
  if (!tabs.has(ORDERS_TAB)) {
    // Our own id, so the filter can go in the same call as the new tab.
    const sheetId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    requests.push(
      { addSheet: { properties: { sheetId, title: ORDERS_TAB } } },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 0,
              startColumnIndex: 0,
              endColumnIndex: ORDER_HEADERS.length,
            },
          },
        },
      },
    );
  }
  await sheetsCall(sa, `${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    requests,
  });
  return (await readTabs(sa, spreadsheetId)).tabs;
}

/** What one tab needs written, row by row, so a cell someone is editing on a
 *  row the sync leaves alone is never overwritten. `check` lists the columns
 *  staff type into (and the row's key): a planned row whose `check` cells
 *  changed between the first read and the write is dropped this pass. */
type TabPlan = {
  title: string;
  tab: Tab;
  columns: number;
  check: number[];
  rows: { i: number; values: Cell[] }[];
  clearFrom: number | null;
  layout: unknown[];
};

function planTab(
  title: string,
  tab: Tab,
  want: Grid,
  columns: number,
  check: number[],
  layout: unknown[],
): TabPlan | null {
  if (sameGrid(want, tab.grid, columns)) return null;
  const rows = want.flatMap((row, i) =>
    sameRow(row, tab.grid[i], columns)
      ? []
      : [
          {
            i,
            values: Array.from({ length: columns }, (_, j) => row[j] ?? {}),
          },
        ],
  );
  const clearFrom =
    usedRows(tab.grid, columns) > want.length ? want.length : null;
  return { title, tab, columns, check, rows, clearFrom, layout };
}

/** The batchUpdate requests for a plan, keeping only rows whose `check`
 *  cells still read as they did when the pass began (`fresh` is a re-read
 *  taken just before writing). */
function planRequests(plan: TabPlan, fresh: Tab | undefined): unknown[] {
  const { tab, columns, check } = plan;
  if (!fresh || fresh.sheetId !== tab.sheetId) return [];
  const untouched = (i: number) =>
    check.every((c) => sameCell(tab.grid[i]?.[c], fresh.grid[i]?.[c]));
  const rows = plan.rows.filter((r) => untouched(r.i));
  const lastRow = Math.max(plan.clearFrom ?? 0, ...rows.map((r) => r.i + 1));
  const clear =
    plan.clearFrom !== null &&
    usedRows(fresh.grid, columns) === usedRows(tab.grid, columns);
  if (!rows.length && !clear) return [];
  return [
    ...(lastRow > tab.rowCount
      ? [
          {
            appendDimension: {
              sheetId: tab.sheetId,
              dimension: 'ROWS',
              length: lastRow - tab.rowCount + 200,
            },
          },
        ]
      : []),
    ...rows.map((r) => ({
      updateCells: {
        start: { sheetId: tab.sheetId, rowIndex: r.i, columnIndex: 0 },
        rows: [{ values: r.values }],
        fields: 'userEnteredValue',
      },
    })),
    ...(clear
      ? [
          {
            updateCells: {
              range: {
                sheetId: tab.sheetId,
                startRowIndex: plan.clearFrom,
                startColumnIndex: 0,
                endColumnIndex: columns,
              },
              fields: 'userEnteredValue',
            },
          },
        ]
      : []),
    ...plan.layout,
  ];
}

/** Header, frozen; centred, wrapped body; a strict status dropdown; TRACKING
 *  as plain text (digits keep their leading zeros); the SYNCED columns hidden;
 *  a wide CARDS column. */
function ordersLayout(sheetId: number): unknown[] {
  const columns = ORDER_HEADERS.length;
  const range = (r0: number, c0: number, c1: number, r1?: number) => ({
    sheetId,
    startRowIndex: r0,
    ...(r1 === undefined ? {} : { endRowIndex: r1 }),
    startColumnIndex: c0,
    endColumnIndex: c1,
  });
  const cols = (start: number, end: number) => ({
    sheetId,
    dimension: 'COLUMNS',
    startIndex: start,
    endIndex: end,
  });
  return [
    {
      repeatCell: {
        range: range(0, 0, columns, 1),
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 0 } },
            textFormat: { bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields:
          'userEnteredFormat(backgroundColorStyle,textFormat.bold,horizontalAlignment)',
      },
    },
    {
      repeatCell: {
        range: range(1, 0, columns),
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
          },
        },
        fields:
          'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)',
      },
    },
    {
      repeatCell: {
        range: range(1, ORDER_COL.TRACKING, ORDER_COL.TRACKING + 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    {
      setDataValidation: {
        range: range(1, ORDER_COL.STATUS, ORDER_COL.STATUS + 1),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: Object.values(STATUS_WORD).map((w) => ({
              userEnteredValue: w,
            })),
          },
          showCustomUi: true,
          strict: true,
        },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      updateDimensionProperties: {
        range: cols(ORDER_COL.CARDS, ORDER_COL.CARDS + 1),
        properties: { pixelSize: 320 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: cols(ORDER_COL.SYNC_STATUS, ORDER_COL.SYNC_ORDER + 1),
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
  ];
}
const failedAt = new Map<string, number>();
// Art → JPEG url uploaded by this process: a write that keeps failing (so the
// sheet never remembers the JPEG) must not upload the same picture every minute.
const uploaded = new Map<string, string>();

/** Each card's JPEG: kept from the sheet while the art is the same, otherwise
 *  re-encoded and uploaded. A card whose art can't be had shows "No image". */
async function resolvePictures(
  container: MedusaContainer,
  rows: ToBuyListRow[],
  existing: Grid,
): Promise<Map<string, { url: string; source: string }>> {
  const old = rowsByCard(existing);
  const out = new Map<string, { url: string; source: string }>();
  const todo: ToBuyListRow[] = [];
  for (const r of rows) {
    if (!r.image) continue;
    const prev = old.get(r.handle);
    const url =
      (text(prev?.[SOURCE]) === r.image ? imageUrlOf(prev?.[PICTURE]) : null) ??
      uploaded.get(r.image);
    if (url) {
      out.set(r.handle, { url, source: r.image });
    } else if (Date.now() - (failedAt.get(r.image) ?? 0) > PICTURE_RETRY_MS) {
      todo.push(r);
    }
  }
  let failed = 0;
  for (let i = 0; i < todo.length; i += PICTURE_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + PICTURE_CONCURRENCY).map(async (r) => {
        const source = r.image as string;
        try {
          const pic = await sheetPicture(source);
          if (!pic) throw new Error('no picture');
          const { result } = await uploadFilesWorkflow(container).run({
            input: {
              files: [
                {
                  filename: `to-buy-${r.handle}.jpg`,
                  mimeType: 'image/jpeg',
                  content: pic.content.toString('base64'),
                  access: 'public',
                },
              ],
            },
          });
          const url = result?.[0]?.url;
          if (!url) throw new Error('upload gave no url');
          out.set(r.handle, { url, source });
          uploaded.set(source, url);
          failedAt.delete(source);
        } catch {
          failedAt.set(source, Date.now());
          failed++;
        }
      }),
    );
  }
  if (failed) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[procurement-sheet] ${failed}/${todo.length} picture(s) not uploaded, retried in an hour`,
      );
  }
  return out;
}

// Orders whose row changed position in the last write: an edit found on them
// next pass may have been aimed at the order that sat there before, so it is
// refused once with a note (code review 2026-11-25). Rows move only when the
// order set changes mid-list (12am trim, an old order coming back).
let movedIds = new Set<string>();

const mytNow = (): string =>
  new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' })
    .slice(0, 16);

/** A refusal's own words (MedusaError, or a workflow's serialized one) are
 *  shown; anything else is logged and the sheet gets a plain line. */
function noteFor(e: unknown): { note: string; log?: string } {
  const err = e as { message?: unknown; type?: unknown } | null | undefined;
  const message = typeof err?.message === 'string' ? err.message : String(e);
  const known = Object.values(MedusaError.Types).includes(
    err?.type as (typeof MedusaError.Types)[keyof typeof MedusaError.Types],
  );
  return known
    ? { note: `Not saved: ${message}`.slice(0, 200) }
    : { note: 'Not saved: try again, or use the admin.', log: message };
}

/** Runs the STATUS / TRACKING edits made in the sheet through the same
 *  workflow and customer notice as the admin's Manage modal. Returns this
 *  pass's notes per order ('' clears an old one) and how many were saved. */
async function applyOrderEdits(
  container: MedusaContainer,
  grid: Grid,
  orders: SheetOrder[],
): Promise<{ notes: Map<string, string>; saved: number }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const notes = new Map<string, string>();
  // A header that isn't ours means columns were inserted or moved: read
  // nothing, and let the rewrite put the tab back.
  if (!sameRow(grid[0], ORDER_HEADERS.map(textCell), ORDER_HEADERS.length)) {
    if (grid.length > 1) {
      logger.warn(
        '[procurement-sheet] All orders header changed; sheet edits ignored this pass',
      );
    }
    return { notes, saved: 0 };
  }
  const byId = new Map(orders.map((o) => [o.id, o]));
  const seen = new Map<string, number>();
  for (const row of grid.slice(1)) {
    const id = cellText(row[ORDER_COL.ORDER]);
    if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  let saved = 0;
  for (const row of grid.slice(1)) {
    const id = cellText(row[ORDER_COL.ORDER]);
    const order = id ? byId.get(id) : undefined;
    if (!id || !order) continue;
    const edit = decideOrderEdit(row, order);
    if (!edit) continue;
    if ((seen.get(id) ?? 0) > 1) {
      notes.set(id, 'This order is on two rows; not saved.');
      continue;
    }
    if (movedIds.has(id)) {
      notes.set(
        id,
        'Rows moved while you edited; check the row and pick again.',
      );
      continue;
    }
    if ('note' in edit) {
      notes.set(id, edit.note);
      continue;
    }
    const { status, tracking_number } = edit.input;
    try {
      const { result } = await updateDeliveryOrderWorkflow(container).run({
        input: {
          order_id: id,
          ...edit.input,
          // Re-checked under the order's lock: the order must still be where
          // the sheet saw it.
          allowed_from: [order.status],
          audit: status
            ? {
                adminId: SHEET_ACTOR,
                action: 'edit' as const,
                // The time finds the editor in the sheet's version history.
                reason: `mark as ${status} (Google Sheet, seen ${mytNow()} MYT)`,
              }
            : undefined,
        },
      });
      await notifyDeliveryChange(container, order, result, tracking_number);
      notes.set(id, '');
      saved++;
      const what = [
        status ? `${order.status} -> ${status}` : null,
        tracking_number !== undefined
          ? `tracking ${order.tracking_number ?? '(none)'} -> ${tracking_number}`
          : null,
      ]
        .filter(Boolean)
        .join(', ');
      logger.info(`[procurement-sheet] order ${id}: ${what} from the sheet`);
    } catch (e) {
      const { note, log } = noteFor(e);
      notes.set(id, note);
      if (log) {
        logger.warn(`[procurement-sheet] order ${id} not saved: ${log}`);
      }
    }
  }
  return { notes, saved };
}

/** One pass over both tabs: apply sheet edits to orders, then write each tab
 *  only where it differs from what it should show. Each tab runs on its own:
 *  one failing doesn't hold the other back. */
export async function syncProcurementSheet(
  container: MedusaContainer,
  sa: ServiceAccount,
  spreadsheetId: string,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const tabs = await ensureTabs(sa, spreadsheetId);
  const toBuy = tabs.get(TO_BUY_TAB);
  const ordersTab = tabs.get(ORDERS_TAB);
  if (!toBuy || !ordersTab) throw new Error('tabs missing after creating them');
  const plans: TabPlan[] = [];
  let failed = 0;

  try {
    const { rows } = await currentToBuyList(container);
    const want = buildGrid(
      rows,
      toBuy.grid,
      await resolvePictures(container, rows, toBuy.grid),
    );
    const plan = planTab(
      TO_BUY_TAB,
      toBuy,
      want,
      COLUMNS,
      [KEY, STATUS],
      toBuyLayout(toBuy.sheetId, want.length - 1),
    );
    if (plan) plans.push(plan);
  } catch (e) {
    failed++;
    logger.warn(
      `[procurement-sheet] To buy tab skipped: ${(e as Error).message}`,
    );
  }

  let moved: Set<string> | null = null;
  try {
    let orders = await loadSheetOrders(container);
    const { notes, saved } = await applyOrderEdits(
      container,
      ordersTab.grid,
      orders,
    );
    if (saved) orders = await loadSheetOrders(container);
    const want = buildOrdersGrid(orders, ordersTab.grid, notes);
    const plan = planTab(
      ORDERS_TAB,
      ordersTab,
      want,
      ORDER_HEADERS.length,
      [ORDER_COL.ORDER, ORDER_COL.STATUS, ORDER_COL.TRACKING],
      ordersLayout(ordersTab.sheetId),
    );
    if (plan) {
      plans.push(plan);
      moved = new Set(
        plan.rows.flatMap(({ i, values }) => {
          const was = cellText(ordersTab.grid[i]?.[ORDER_COL.ORDER]);
          const now = cellText(values[ORDER_COL.ORDER]);
          return was && was !== now ? [was, ...(now ? [now] : [])] : [];
        }),
      );
    }
  } catch (e) {
    failed++;
    logger.warn(
      `[procurement-sheet] All orders tab skipped: ${(e as Error).message}`,
    );
  }

  if (!plans.length) {
    movedIds = new Set();
    if (failed === 2) throw new Error('both tabs failed');
    return;
  }
  // Re-read just before writing: a row staff typed into during this pass is
  // left for the next one instead of being overwritten.
  const fresh = (await readTabs(sa, spreadsheetId)).tabs;
  const requests = plans.flatMap((p) => planRequests(p, fresh.get(p.title)));
  // shortcut: an edit typed in the GET-to-POST round trip on a row the sync
  // rewrites is lost (the cell shows the old value again).
  if (requests.length) {
    await sheetsCall(sa, `${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests,
    });
    logger.info(
      `[procurement-sheet] wrote ${plans.map((p) => `${p.title}: ${p.rows.length} row(s)`).join(', ')}`,
    );
  }
  movedIds = moved ?? new Set();
}

// shortcut: one worker process, so a module flag keeps a slow run (the first
// one uploads every picture) from overlapping the next minute's; a second
// worker instance would need a lock. A run older than RUN_STALE_MS is taken
// as hung, so the sync heals instead of stopping until a restart.
const RUN_STALE_MS = 15 * 60 * 1000;
let runningSince = 0;

export default async function syncProcurementSheetJob(
  container: MedusaContainer,
): Promise<void> {
  const spreadsheetId = sheetIdFrom(process.env.PROCUREMENT_SHEET_ID);
  if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim())
    return;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (runningSince) {
    if (Date.now() - runningSince < RUN_STALE_MS) return;
    logger.warn('[procurement-sheet] last pass looks hung; starting a new one');
  }
  const started = Date.now();
  runningSince = started;
  let sa: ServiceAccount | null = null;
  try {
    sa = serviceAccountFromEnv();
    if (sa) await syncProcurementSheet(container, sa, spreadsheetId);
  } catch (e) {
    const hint =
      e instanceof SheetsError && (e.status === 403 || e.status === 404)
        ? ` (is the sheet shared with ${sa?.client_email} as Editor?)`
        : '';
    logger.warn(
      `[procurement-sheet] sync failed: ${e instanceof Error ? e.message : String(e)}${hint}`,
    );
  } finally {
    if (runningSince === started) runningSince = 0;
  }
}

export const config = {
  name: 'sync-procurement-sheet',
  schedule: '* * * * *',
};
