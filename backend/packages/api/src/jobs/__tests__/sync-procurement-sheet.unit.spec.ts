import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  buildGrid,
  HEADERS,
  imageUrlOf,
  sheetIdFrom,
  syncProcurementSheet,
} from '../sync-procurement-sheet';
import {
  currentToBuyList,
  type ToBuyListRow,
} from '../../modules/packs/procurement-view';
import {
  sameGrid,
  serviceAccountFromEnv,
  sheetsCall,
  signedJwt,
  type Cell,
  type Grid,
} from '../../utils/google-sheets';
import {
  loadSheetOrders,
  type SheetOrder,
} from '../../modules/packs/orders-sheet';
import { updateDeliveryOrderWorkflow } from '../../workflows/update-delivery-order';
import { notifyDeliveryChange } from '../../api/admin/delivery-orders/notify';
import { sheetPicture } from '../../api/admin/procurement/to-buy/export/route';
import { uploadFilesWorkflow } from '@medusajs/medusa/core-flows';

jest.mock('../../modules/packs/procurement-view', () => ({
  currentToBuyList: jest.fn(),
}));
jest.mock('../../utils/google-sheets', () => ({
  ...jest.requireActual('../../utils/google-sheets'),
  sheetsCall: jest.fn(),
}));
jest.mock('../../api/admin/procurement/to-buy/export/route', () => ({
  ...jest.requireActual('../../api/admin/procurement/to-buy/export/route'),
  sheetPicture: jest.fn(),
}));
jest.mock('@medusajs/medusa/core-flows', () => ({
  uploadFilesWorkflow: jest.fn(),
}));
jest.mock('../../modules/packs/orders-sheet', () => ({
  ...jest.requireActual('../../modules/packs/orders-sheet'),
  loadSheetOrders: jest.fn(),
}));
jest.mock('../../workflows/update-delivery-order', () => ({
  updateDeliveryOrderWorkflow: jest.fn(),
}));
jest.mock('../../api/admin/delivery-orders/notify', () => ({
  notifyDeliveryChange: jest.fn(),
}));

// The live To buy sheet: what a sync writes, that the buyers' STATUS follows
// its card, and when it leaves the sheet alone. The Google calls themselves
// are checked on a real sheet, not here.

const row = (handle: string, over: Partial<ToBuyListRow> = {}): ToBuyListRow =>
  ({
    handle,
    name: `Card ${handle}`,
    sku: null,
    photo: null,
    graded: false,
    to_procure: 2,
    on_hand: 0,
    requested: 2,
    ready_to_ship: 0,
    fmv: 43.214,
    oldest_order_at: null,
    image: `https://cdn.example/${handle}.webp`,
    fmv_usd: 10,
    set: 'Base Set',
    grade: null,
    ...over,
  }) as ToBuyListRow;

const s = (v: string): Cell => ({ userEnteredValue: { stringValue: v } });
const values = (g: Grid) =>
  g.map((r) =>
    r.map((c) => {
      const v = c.userEnteredValue ?? {};
      return v.stringValue ?? v.numberValue ?? v.formulaValue ?? null;
    }),
  );

describe('procurement sheet: buildGrid', () => {
  it('writes the header and one row per card, like the Export file', () => {
    const pics = new Map([
      [
        'a',
        {
          url: 'https://cdn.example/a.jpg',
          source: 'https://cdn.example/a.webp',
        },
      ],
    ]);
    const grid = buildGrid(
      [
        row('a'),
        row('b', { graded: true, grade: 'PSA 10', image: null, fmv_usd: null }),
      ],
      [],
      pics,
    );
    expect(values(grid)).toEqual([
      HEADERS,
      [
        '=IMAGE("https://cdn.example/a.jpg")',
        'Card a',
        'Base Set',
        'RAW',
        2,
        10,
        43.21,
        null,
        'a',
        'https://cdn.example/a.webp',
      ],
      [
        'No image',
        'Card b',
        'Base Set',
        'PSA 10',
        2,
        null,
        43.21,
        null,
        'b',
        null,
      ],
    ]);
  });

  it('keeps each STATUS with its card when rows move, and drops it when the card leaves', () => {
    const existing: Grid = [
      HEADERS.map(s),
      [{}, s('Card a'), {}, {}, {}, {}, {}, s('Found'), s('a')],
      [{}, s('Card gone'), {}, {}, {}, {}, {}, s('Not found'), s('gone')],
      [{}, s('Card b'), {}, {}, {}, {}, {}, s('Not found'), s('b')],
    ];
    const grid = buildGrid([row('b'), row('c'), row('a')], existing, new Map());
    expect(
      grid.slice(1).map((r) => r[7].userEnteredValue?.stringValue),
    ).toEqual(['Not found', undefined, 'Found']);
  });

  it('writes a name that starts with "=" as text, never as a formula', () => {
    const grid = buildGrid(
      [row('x', { name: '=HYPERLINK("http://evil")' })],
      [],
      new Map(),
    );
    expect(grid[1][1].userEnteredValue).toEqual({
      stringValue: '=HYPERLINK("http://evil")',
    });
  });
});

describe('procurement sheet: sameGrid', () => {
  const want = buildGrid([row('a')], [], new Map());

  it('is the same when the sheet only lacks empty trailing cells and rows', () => {
    const have: Grid = [
      ...want.map((r) => {
        const copy = [...r];
        while (copy.length && !copy[copy.length - 1].userEnteredValue)
          copy.pop();
        return copy;
      }),
      [{}, {}],
    ];
    expect(sameGrid(want, have, HEADERS.length)).toBe(true);
  });

  it('differs when a synced cell was edited, or a card row is extra', () => {
    const edited = want.map((r) => [...r]);
    edited[1][4] = { userEnteredValue: { numberValue: 99 } };
    expect(sameGrid(want, edited, HEADERS.length)).toBe(false);
    expect(sameGrid(want, [...want, want[1]], HEADERS.length)).toBe(false);
  });

  it('ignores columns past the synced ones', () => {
    const have = want.map((r) => [...r, s('buyer note')]);
    expect(sameGrid(want, have, HEADERS.length)).toBe(true);
  });
});

describe('procurement sheet: small parsers', () => {
  it('reads the url back out of an IMAGE formula', () => {
    expect(
      imageUrlOf({
        userEnteredValue: { formulaValue: '=IMAGE("https://x/a""b.jpg")' },
      }),
    ).toBe('https://x/a"b.jpg');
    expect(imageUrlOf(s('No image'))).toBeNull();
  });

  it('takes the sheet id alone or out of the sheet URL', () => {
    expect(
      sheetIdFrom('https://docs.google.com/spreadsheets/d/1AbC-d_9/edit#gid=0'),
    ).toBe('1AbC-d_9');
    expect(sheetIdFrom(' 1AbC-d_9 ')).toBe('1AbC-d_9');
    expect(sheetIdFrom('')).toBeNull();
  });
});

describe('google service account', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const key = {
    client_email: 'sync@proj.iam.gserviceaccount.com',
    private_key: pem,
  };

  it('reads the JSON key raw or base64, and refuses one without the fields', () => {
    const json = JSON.stringify({ type: 'service_account', ...key });
    expect(serviceAccountFromEnv(json)).toEqual(key);
    expect(serviceAccountFromEnv(Buffer.from(json).toString('base64'))).toEqual(
      key,
    );
    expect(serviceAccountFromEnv('')).toBeNull();
    expect(() => serviceAccountFromEnv('{"client_email":"x"}')).toThrow(
      /private_key/,
    );
  });

  it('signs an RS256 assertion for the Sheets scope, valid for an hour', () => {
    const jwt = signedJwt(key, 1_700_000_000);
    const [head, claims, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${head}.${claims}`)
        .verify(publicKey, Buffer.from(sig, 'base64url')),
    ).toBe(true);
  });
});

describe('procurement sheet: one sync pass over both tabs', () => {
  const sa = { client_email: 'sync@x', private_key: 'unused' };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const container = { resolve: () => logger } as never;
  const upload = jest.fn();
  const runOrder = jest.fn();
  type FakeTab = { sheetId: number; title: string; grid: Grid };
  let tabs: FakeTab[];
  let writes: number;
  let gets: number;
  let failNextWrite: boolean;
  /** Runs on the re-read just before a write: a staff edit landing mid-pass. */
  let onReRead: (() => void) | null;
  let orders: SheetOrder[];
  const tab = (title: string) => tabs.find((t) => t.title === title)!;
  const orderRow = (id: string) =>
    tab('All orders').grid.find(
      (r) => r[0]?.userEnteredValue?.stringValue === id,
    )!;
  const sync = () => syncProcurementSheet(container, sa, 'SHEET');
  const mk = (id: string, created: string, over: Partial<SheetOrder> = {}) => ({
    id,
    status: 'ready_to_ship',
    tracking_number: null,
    customer_id: 'c1',
    name: `Name ${id}`,
    cards: ['Pikachu', 'Pikachu'],
    created_at: created,
    shipped_at: null,
    ...over,
  });

  type Req = {
    addSheet?: { properties: { title: string; sheetId?: number } };
    updateSheetProperties?: {
      properties: { sheetId: number; title?: string };
      fields: string;
    };
    updateCells?: {
      start?: { sheetId: number; rowIndex: number };
      range?: { sheetId: number; startRowIndex: number };
      rows?: { values: Cell[] }[];
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tabs = [{ sheetId: 0, title: 'Sheet1', grid: [] }];
    writes = 0;
    gets = 0;
    failNextWrite = false;
    onReRead = null;
    orders = [mk('o1', '2026-11-25T01:00:00Z')];
    (currentToBuyList as jest.Mock).mockResolvedValue({
      rows: [row('a')],
      taken_at: null,
    });
    (sheetPicture as jest.Mock).mockResolvedValue({
      content: Buffer.from('jpeg'),
      width: 1,
      height: 1,
    });
    (uploadFilesWorkflow as unknown as jest.Mock).mockReturnValue({
      run: upload,
    });
    upload.mockResolvedValue({
      result: [{ url: 'https://cdn.example/a-01.jpg' }],
    });
    (loadSheetOrders as jest.Mock).mockImplementation(async () =>
      orders.map((o) => ({ ...o })),
    );
    // The workflow moves the fake order the way the real one would.
    (updateDeliveryOrderWorkflow as unknown as jest.Mock).mockReturnValue({
      run: runOrder,
    });
    runOrder.mockImplementation(
      async ({
        input,
      }: {
        input: { order_id: string; status?: string; tracking_number?: string };
      }) => {
        const o = orders.find((x) => x.id === input.order_id)!;
        if (input.status) o.status = input.status;
        if (input.tracking_number !== undefined)
          o.tracking_number = input.tracking_number;
        return { result: { order_id: o.id, status: o.status } };
      },
    );
    // A tiny Google: GET returns every tab; batchUpdate applies what the
    // sync sends (tab create/rename, row writes, clears) and ignores layout.
    let nextId = 100;
    (sheetsCall as jest.Mock).mockImplementation(
      async (_sa, path: string, body?: { requests: Req[] }) => {
        if (!body) {
          // Fires on the pass's second read: the re-read just before writing.
          if (onReRead && ++gets === 2) {
            onReRead();
            onReRead = null;
          }
          return {
            sheets: tabs.map((t) => ({
              properties: {
                sheetId: t.sheetId,
                title: t.title,
                gridProperties: { rowCount: 1000 },
              },
              data: [
                {
                  rowData: t.grid.map((values) => ({
                    values: values.map((c) => ({ ...c })),
                  })),
                },
              ],
            })),
          };
        }
        expect(path).toBe('SHEET:batchUpdate');
        if (body.requests.some((r) => r.updateCells)) {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('Google Sheets 503: backend error');
          }
          writes++;
        }
        for (const r of body.requests) {
          if (r.addSheet) {
            tabs.push({
              sheetId: r.addSheet.properties.sheetId ?? nextId++,
              title: r.addSheet.properties.title,
              grid: [],
            });
          }
          if (r.updateSheetProperties?.fields === 'title') {
            const p = r.updateSheetProperties.properties;
            tabs.find((t) => t.sheetId === p.sheetId)!.title = p.title!;
          }
          const u = r.updateCells;
          if (u?.start) {
            const t = tabs.find((x) => x.sheetId === u.start!.sheetId)!;
            t.grid[u.start.rowIndex] = u.rows![0].values;
          } else if (u?.range) {
            const t = tabs.find((x) => x.sheetId === u.range!.sheetId)!;
            t.grid = t.grid.slice(0, u.range.startRowIndex);
          }
        }
        return {};
      },
    );
  });

  it('makes both tabs, writes them once, then leaves them alone', async () => {
    await sync();
    expect(tabs.map((t) => t.title)).toEqual(['To buy', 'All orders']);
    expect(writes).toBe(1);
    expect(tab('To buy').grid[1][0].userEnteredValue?.formulaValue).toBe(
      '=IMAGE("https://cdn.example/a-01.jpg")',
    );
    expect(values(tab('All orders').grid)[1].slice(0, 7)).toEqual([
      'o1',
      '2026-11-25 09:00',
      'Name o1',
      'Pikachu ×2',
      2,
      'Ready to ship',
      null,
    ]);

    await sync();
    expect(writes).toBe(1); // nothing changed, nothing written
    expect(upload).toHaveBeenCalledTimes(1); // the sheet remembers the JPEG
  });

  it("keeps a buyer's To buy STATUS through a rewrite caused by a list change", async () => {
    await sync();
    tab('To buy').grid[1][7] = { userEnteredValue: { stringValue: 'Found' } };
    (currentToBuyList as jest.Mock).mockResolvedValue({
      rows: [row('b', { image: null }), row('a', { to_procure: 1 })],
      taken_at: null,
    });

    await sync();
    expect(
      values(tab('To buy').grid)
        .slice(1)
        .map((r) => [r[8], r[4], r[7]]),
    ).toEqual([
      ['b', 2, null],
      ['a', 1, 'Found'],
    ]);
  });

  it('ships an order marked Shipped with a tracking number in the sheet, like the admin does', async () => {
    await sync();
    const r = orderRow('o1');
    r[5] = { userEnteredValue: { stringValue: 'Shipped' } };
    r[6] = { userEnteredValue: { stringValue: ' NV123 ' } };

    await sync();
    expect(runOrder).toHaveBeenCalledWith({
      input: {
        order_id: 'o1',
        status: 'shipped',
        tracking_number: 'NV123',
        allowed_from: ['ready_to_ship'],
        audit: {
          adminId: 'system:google-sheet',
          action: 'edit',
          reason: expect.stringMatching(
            /^mark as shipped \(Google Sheet, seen \d{4}-\d\d-\d\d \d\d:\d\d MYT\)$/,
          ),
        },
      },
    });
    expect(notifyDeliveryChange).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ id: 'o1', status: 'ready_to_ship' }),
      { order_id: 'o1', status: 'shipped' },
      'NV123',
    );
    expect(values(tab('All orders').grid)[1].slice(5, 12)).toEqual([
      'Shipped',
      'NV123',
      null,
      null,
      'shipped',
      'NV123',
      'o1',
    ]);
  });

  it('refuses a cancel from the sheet: the order is untouched and NOTE says why', async () => {
    await sync();
    orderRow('o1')[5] = { userEnteredValue: { stringValue: 'Canceled' } };

    await sync();
    expect(runOrder).not.toHaveBeenCalled();
    const r = values(tab('All orders').grid)[1];
    expect(r[5]).toBe('Ready to ship');
    expect(r[7]).toMatch(/Cancel in admin/);
  });

  it('never applies an edit twice when the write after it failed', async () => {
    await sync();
    orderRow('o1')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };
    failNextWrite = true;
    await expect(sync()).rejects.toThrow(/503/); // edit saved, write fails
    expect(runOrder).toHaveBeenCalledTimes(1);

    await sync();
    expect(runOrder).toHaveBeenCalledTimes(1);
    expect(notifyDeliveryChange).toHaveBeenCalledTimes(1);
    const r = values(tab('All orders').grid)[1];
    expect([r[5], r[7], r[9]]).toEqual([
      'Pending to ship',
      null,
      'pending_ship',
    ]);
  });

  it('shows a workflow refusal in NOTE and still saves the other rows', async () => {
    orders.push(mk('o2', '2026-11-25T02:00:00Z'));
    await sync();
    orderRow('o1')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };
    orderRow('o2')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };
    runOrder.mockImplementationOnce(async () => {
      throw { type: 'not_allowed', message: 'Order is locked' };
    });

    await sync();
    expect(values([orderRow('o1')])[0][7]).toBe('Not saved: Order is locked');
    expect(orders.find((o) => o.id === 'o2')!.status).toBe('pending_ship');
  });

  it('hides an unexpected error behind a plain note and logs it', async () => {
    await sync();
    orderRow('o1')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };
    runOrder.mockImplementationOnce(async () => {
      throw new Error('connection terminated unexpectedly');
    });

    await sync();
    expect(values([orderRow('o1')])[0][7]).toBe(
      'Not saved: try again, or use the admin.',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/o1 not saved: connection terminated/),
    );
  });

  it('leaves a row staff typed into during the pass for the next pass', async () => {
    orders.push(mk('o2', '2026-11-25T02:00:00Z'));
    await sync();
    orderRow('o1')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };
    // While that pass runs, staff type o1's tracking number.
    gets = 0;
    onReRead = () => {
      orderRow('o1')[6] = { userEnteredValue: { stringValue: 'NV777' } };
    };

    await sync();
    expect(values([orderRow('o1')])[0][6]).toBe('NV777'); // not overwritten
    await sync(); // next pass: own edit already saved, tracking now picked up
    expect(orders[0]).toMatchObject({
      status: 'pending_ship',
      tracking_number: 'NV777',
    });
  });

  it('adds a new order at the bottom, so rows above never move', async () => {
    orders.push(mk('o3', '2026-11-25T03:00:00Z'));
    await sync();
    orders.push(mk('o4', '2026-11-25T04:00:00Z'));
    await sync();
    expect(
      values(tab('All orders').grid)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(['o1', 'o3', 'o4']);
  });

  it('refuses, once, an edit on an order whose row just moved', async () => {
    orders.push(mk('o3', '2026-11-25T03:00:00Z'));
    await sync();
    // An older order comes back into the window: o3 moves down a row. (The
    // mocked loader returns this array as is; the real one sorts by date.)
    orders.splice(1, 0, mk('o2', '2026-11-25T02:00:00Z'));
    await sync();
    orderRow('o3')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };

    await sync();
    expect(runOrder).not.toHaveBeenCalled();
    expect(values([orderRow('o3')])[0][7]).toMatch(/Rows moved/);

    orderRow('o3')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };
    await sync();
    expect(runOrder).toHaveBeenCalledTimes(1);
  });

  it('ignores edits while the header is not ours, and puts it back', async () => {
    await sync();
    const grid = tab('All orders').grid;
    grid[0][5] = { userEnteredValue: { stringValue: 'MY NOTES' } };
    orderRow('o1')[5] = {
      userEnteredValue: { stringValue: 'Pending to ship' },
    };

    await sync();
    expect(runOrder).not.toHaveBeenCalled();
    expect(values(tab('All orders').grid)[0][5]).toBe('STATUS');
  });

  it('refuses an order that sits on two rows', async () => {
    await sync();
    const grid = tab('All orders').grid;
    grid[2] = grid[1].map((c) => ({ ...c }));
    grid[1][5] = { userEnteredValue: { stringValue: 'Pending to ship' } };

    await sync();
    expect(runOrder).not.toHaveBeenCalled();
    expect(values(tab('All orders').grid)).toHaveLength(2); // duplicate cleared
  });
});
