import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyDhlEcommerce,
  classifyNinjaVan,
  classifyPosLaju,
  detectCarrier,
  parsePosDate,
  trackShipments,
  type NinjaOrder,
  type PosConnote,
} from '../shipment-tracking';

// Shapes trimmed from real answers on 2026-10-30 (NVMYNINJA002596746 and
// EHE311095909MY, both delivered).
const ninjaDelivered: NinjaOrder = {
  status: 'Completed',
  granular_status: 'Completed',
  events: [
    {
      type: 'FROM_SHIPPER_TO_DP',
      time: '2026-10-20T10:43:01Z',
      data: { dp_name: 'Ninja Self Owned Store Mount Austin' },
    },
    {
      type: 'DRIVER_INBOUND_SCAN',
      time: '2026-10-22T04:19:18Z',
      data: { hub_name: 'Station Bayan Lepas' },
    },
    {
      type: 'DELIVERY_SUCCESS',
      time: '2026-10-22T08:14:42Z',
      data: { is_rts: false },
    },
  ],
};

const posDelivered: PosConnote = {
  connote_id: 'EHE311095909MY',
  process_status: 'DELIVERED',
  tracking_data: [
    {
      date: '06 Oct 2026, 12:20:00 PM',
      process: 'Delivery completed',
      office: '',
    },
    {
      date: '06 Oct 2026, 09:34:00 AM',
      process: 'Out for delivery',
      office: '',
    },
    {
      date: '06 Oct 2026, 07:23:00 AM',
      process: 'Processing',
      office: 'Pusat Pos Laju Parit Buntar',
    },
  ],
};

describe('detectCarrier', () => {
  it.each([
    ['NVMYNINJA002596746', 'ninjavan'],
    ['nvmyninja002596746 ', 'ninjavan'],
    ['NVSGABC123456', 'ninjavan'],
    ['EHE315326262MY', 'poslaju'],
    ['ENE200026365MY', 'poslaju'],
    ['ER123456789MY', 'poslaju'],
    ['7125109956829386', 'dhl_ecommerce'],
    ['7128100488960676', 'dhl_ecommerce'],
    ['7135109956829386', null],
    ['712510995682938', null],
    ['', null],
  ])('%s -> %s', (n, carrier) => {
    expect(detectCarrier(n)).toBe(carrier);
  });
});

describe('classifyNinjaVan', () => {
  it('delivered on Completed + a non-RTS success scan, at the scan time', () => {
    expect(classifyNinjaVan(ninjaDelivered)).toEqual({
      carrier: 'ninjavan',
      state: 'delivered',
      event: 'Completed',
      event_at: '2026-10-22T08:14:42Z',
      delivered_at: '2026-10-22T08:14:42Z',
    });
  });

  it('a returned parcel is a problem, never delivered', () => {
    const rts: NinjaOrder = {
      status: 'Completed',
      granular_status: 'Returned to Sender',
      events: [
        {
          type: 'DELIVERY_SUCCESS',
          time: '2026-10-25T08:00:00Z',
          data: { is_rts: true },
        },
      ],
    };
    expect(classifyNinjaVan(rts).state).toBe('problem');
  });

  it('Completed without a success scan is not delivered', () => {
    expect(
      classifyNinjaVan({ status: 'Completed', events: [] }).state,
    ).not.toBe('delivered');
  });

  it('a failed last attempt is a problem; a scan in between is in transit', () => {
    expect(
      classifyNinjaVan({
        status: 'Pending',
        granular_status: 'Pending Reschedule',
        events: [{ type: 'DELIVERY_FAILURE', time: '2026-10-25T08:00:00Z' }],
      }).state,
    ).toBe('problem');
    const moving = classifyNinjaVan({
      status: 'Transit',
      granular_status: 'Arrived at Sorting Hub',
      events: [
        {
          type: 'HUB_INBOUND_SCAN',
          time: '2026-10-21T17:32:33Z',
          data: { hub_name: 'Sort Centre Shah Alam' },
        },
      ],
    });
    expect(moving.state).toBe('in_transit');
    expect(moving.event).toBe('Arrived at Sorting Hub · Sort Centre Shah Alam');
  });
});

describe('classifyPosLaju', () => {
  it('delivered on DELIVERED, at the "Delivery completed" time (MYT)', () => {
    expect(classifyPosLaju(posDelivered)).toEqual({
      carrier: 'poslaju',
      state: 'delivered',
      event: 'Delivery completed',
      event_at: '2026-10-06T04:20:00.000Z',
      delivered_at: '2026-10-06T04:20:00.000Z',
    });
  });

  it('an empty answer is not_found', () => {
    expect(
      classifyPosLaju({
        connote_id: 'ER123456789MY',
        process_status: '',
        tracking_data: null,
      }).state,
    ).toBe('not_found');
  });

  it('DELIVERED back to the sender is a problem, never delivered', () => {
    expect(
      classifyPosLaju({
        process_status: 'DELIVERED',
        tracking_data: [
          { date: '07 Oct 2026, 10:00:00 AM', process: 'Return to sender' },
          { date: '08 Oct 2026, 10:00:00 AM', process: 'Delivery completed' },
        ],
      }).state,
    ).toBe('problem');
  });

  it('anything short of DELIVERED stays in transit', () => {
    expect(
      classifyPosLaju({
        process_status: 'IN TRANSIT',
        tracking_data: [
          { date: '06 Oct 2026, 09:34:00 AM', process: 'Out for delivery' },
        ],
      }).state,
    ).toBe('in_transit');
  });
});

// DHL eCommerce: trimmed real pages (fixtures/, recipient names masked) plus
// synthetic rows in the same markup for shapes prod had no example of.
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const dhlRow = (text: string, date: string, time: string, place: string) =>
  `<div class="row position-relative d-flex align-items-start tracking-item">
  <div class="col-2 text-uppercase"><div class="text-grey-80">Day</div>
  <div class="fw-bold text-grey-80">${date}</div></div>
  <div class="col-2 text-end me-3 text-nowrap"><div>${time} LT</div></div>
  <div class="col-6"><div class="fw-bold"><span class="d-none d-lg-block">${text}</span>
  <span class="d-lg-none">${text}</span></div><div class="text-grey-80">${place}</div></div>
  </div>`;
const dhlPage = (...rows: string[]) =>
  `<span id="trackItNowForm:timelinePanel">${rows.join('\n')}</span>`;
const DELIVERED_BADGE =
  '<span class="badge bg-delivered text-white">Delivered</span>';

describe('classifyDhlEcommerce', () => {
  it('refuses the 5-row page on its own: a return could hide behind "Show more"', () => {
    expect(() =>
      classifyDhlEcommerce(fixture('dhl-ecommerce-delivered.html')),
    ).toThrow(/cut short/);
  });

  it('strips the signer name even across a line break or as "Received by"', () => {
    const r = classifyDhlEcommerce(
      DELIVERED_BADGE +
        dhlPage(
          dhlRow(
            'Successfully delivered - Received by : Ah\nChong',
            'Oct 22, 2026',
            '10:00 AM',
            'KL',
          ),
        ),
    );
    expect(r.event).toBe('Successfully delivered · KL');
  });

  it('delivered on the real page, at the delivery scan time, with no recipient name', () => {
    const r = classifyDhlEcommerce(
      fixture('dhl-ecommerce-delivered.html'),
      fixture('dhl-ecommerce-full-timeline.xml'),
    );
    expect(r).toEqual({
      carrier: 'dhl_ecommerce',
      state: 'delivered',
      event: 'Successfully delivered · Skudai, Malaysia',
      // Mon 19 Oct 2026, 01:59 PM Malaysia time.
      event_at: '2026-10-19T05:59:00.000Z',
      delivered_at: '2026-10-19T05:59:00.000Z',
    });
    expect(r.event).not.toMatch(/signed for/i);
  });

  it('the real "No result found" page is not_found', () => {
    expect(
      classifyDhlEcommerce(fixture('dhl-ecommerce-not-found.html')).state,
    ).toBe('not_found');
  });

  it('throws on any other page (a bot check, a redesign) rather than guess', () => {
    expect(() =>
      classifyDhlEcommerce('<html><body>Verify you are human</body></html>'),
    ).toThrow(/no tracking timeline/);
    expect(() => classifyDhlEcommerce(dhlPage())).toThrow(/no events/);
  });

  it('in transit carries a day header forward to the rows under it', () => {
    const r = classifyDhlEcommerce(
      dhlPage(
        dhlRow(
          'Out for Delivery',
          'Oct 19, 2026',
          '11:59\nAM',
          'Skudai, Malaysia',
        ),
        dhlRow(
          'Processed at delivery facility',
          '',
          '11:47 AM',
          'Skudai, Malaysia',
        ),
      ),
    );
    expect(r).toMatchObject({
      state: 'in_transit',
      event: 'Out for Delivery · Skudai, Malaysia',
      event_at: '2026-10-19T03:59:00.000Z',
    });
  });

  it('a return is a problem, even when the page later says delivered', () => {
    expect(
      classifyDhlEcommerce(
        dhlPage(
          dhlRow('Return to shipper', 'Oct 20, 2026', '10:00 AM', 'Ipoh'),
        ),
      ).state,
    ).toBe('problem');
    expect(
      classifyDhlEcommerce(
        DELIVERED_BADGE +
          dhlPage(
            dhlRow('Successfully delivered', 'Oct 22, 2026', '10:00 AM', 'KL'),
            dhlRow('Return to shipper', 'Oct 21, 2026', '10:00 AM', 'Ipoh'),
          ),
      ).state,
    ).toBe('problem');
  });

  it('"Successfully delivered" without the delivered badge is not delivered', () => {
    expect(
      classifyDhlEcommerce(
        dhlPage(
          dhlRow('Successfully delivered', 'Oct 22, 2026', '10:00 AM', 'KL'),
        ),
      ).state,
    ).not.toBe('delivered');
  });
});

describe('parsePosDate', () => {
  it('reads Malaysia time, 12 AM/PM included', () => {
    expect(parsePosDate('06 Oct 2026, 12:20:00 PM')).toBe(
      '2026-10-06T04:20:00.000Z',
    );
    expect(parsePosDate('06 Oct 2026, 12:05:00 AM')).toBe(
      '2026-10-05T16:05:00.000Z',
    );
    expect(parsePosDate('garbage')).toBeNull();
  });
});

describe('trackShipments', () => {
  const json = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
  const html = (status: number, body: string, cookies: string[] = []) => {
    const headers = new Headers();
    for (const c of cookies) headers.append('set-cookie', c);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      text: async () => body,
    } as Response;
  };

  it('routes each number to its carrier and keeps per-number failures', async () => {
    const fetchFn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('NVMYNINJA000000001')) return json(200, ninjaDelivered);
      if (u.includes('NVMYNINJA000000002')) {
        return json(404, { error: { code: 150002 } });
      }
      if (u.includes('NVMYNINJA000000003')) return json(503, {});
      if (u.includes('ref=7128100488960676')) {
        return init?.method === 'POST'
          ? html(200, fixture('dhl-ecommerce-full-timeline.xml'))
          : html(200, fixture('dhl-ecommerce-delivered.html'), [
              'JSESSIONID=abc123; Path=/track; Secure',
            ]);
      }
      if (u.includes('ref=7125109956829386')) return html(503, '');
      // Pos answers only one of the two numbers it was asked about.
      return json(200, { code: 'S0000', data: [posDelivered] });
    }) as unknown as typeof fetch;

    const out = await trackShipments(
      [
        'NVMYNINJA000000001',
        'NVMYNINJA000000002',
        'NVMYNINJA000000003',
        'EHE311095909MY',
        'EHE000000000MY',
        '7128100488960676',
        '7125109956829386',
        '9125109956829386',
      ],
      fetchFn,
    );

    expect(out.get('NVMYNINJA000000001')).toMatchObject({ state: 'delivered' });
    expect(out.get('NVMYNINJA000000002')).toMatchObject({ state: 'not_found' });
    expect(out.get('NVMYNINJA000000003')).toBeInstanceOf(Error);
    expect(out.get('EHE311095909MY')).toMatchObject({ state: 'delivered' });
    expect(out.get('EHE000000000MY')).toBeInstanceOf(Error);
    expect(out.get('7128100488960676')).toMatchObject({
      carrier: 'dhl_ecommerce',
      state: 'delivered',
    });
    expect(out.get('7125109956829386')).toBeInstanceOf(Error);
    expect(out.get('9125109956829386')).toMatchObject({
      state: 'unknown_carrier',
    });
    const calls = (fetchFn as unknown as jest.Mock).mock.calls.map((c) =>
      String(c[0]),
    );
    // One Pos call for both Pos numbers; a 404 is asked twice before it
    // reads as not_found.
    expect(calls.filter((u) => u.includes('pos.com.my'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('NVMYNINJA000000002'))).toHaveLength(
      2,
    );
  });

  it('a Pos error code fails the whole batch rather than reading as not delivered', async () => {
    const fetchFn = (async () =>
      json(200, { code: 'E9999', data: null })) as unknown as typeof fetch;
    const out = await trackShipments(['EHE311095909MY'], fetchFn);
    expect(out.get('EHE311095909MY')).toBeInstanceOf(Error);
  });

  it('stops asking Ninja Van after a 429 and fails the rest of the run', async () => {
    const fetchFn = jest.fn(async () =>
      json(429, {}),
    ) as unknown as typeof fetch;
    const numbers = Array.from(
      { length: 10 },
      (_, i) => `NVMYNINJA00000010${i}`,
    );
    const out = await trackShipments(numbers, fetchFn);
    // One batch of 4 is sent; the other 6 are never asked.
    expect((fetchFn as unknown as jest.Mock).mock.calls).toHaveLength(4);
    for (const n of numbers) {
      expect((out.get(n) as Error).message).toMatch(/rate limit/);
    }
  });

  it('asks DHL for the full timeline with the page\'s own view state and cookie', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST'
        ? html(200, fixture('dhl-ecommerce-full-timeline.xml'))
        : html(200, fixture('dhl-ecommerce-delivered.html'), [
            'JSESSIONID=abc123; Path=/track; Secure',
          ]),
    ) as unknown as jest.Mock;
    const out = await trackShipments(
      ['7128100488960676'],
      fetchFn as unknown as typeof fetch,
    );
    expect(out.get('7128100488960676')).toMatchObject({
      state: 'delivered',
      delivered_at: '2026-10-19T05:59:00.000Z',
    });
    const post = fetchFn.mock.calls[1][1] as RequestInit;
    const form = new URLSearchParams(post.body as string);
    expect(form.get('javax.faces.ViewState')).toBe('VIEWSTATE-FIXTURE');
    expect(form.get('javax.faces.source')).toBe('trackItNowForm:j_idt665');
    expect((post.headers as Record<string, string>).Cookie).toBe(
      'JSESSIONID=abc123',
    );
  });

  it('a Ninja Van 404 without its own not-found code is an error, not "no record"', async () => {
    const fetchFn = (async () =>
      json(404, '<html>moved</html>')) as unknown as typeof fetch;
    const out = await trackShipments(['NVMYNINJA000000002'], fetchFn);
    expect(out.get('NVMYNINJA000000002')).toBeInstanceOf(Error);
  });

  it('starts no carrier call after the deadline', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const out = await trackShipments(
      ['NVMYNINJA000000001', 'EHE311095909MY', '7128100488960676'],
      fetchFn,
      Date.now() - 1,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    for (const v of out.values()) {
      expect((v as Error).message).toMatch(/Out of time/);
    }
  });
});

describe('carrier review fixes (2026-10-30)', () => {
  it('Ninja Van: "Returned to Sender" is never delivered, whatever is_rts says', () => {
    expect(
      classifyNinjaVan({
        status: 'Completed',
        granular_status: 'Returned to Sender',
        events: [
          {
            type: 'DELIVERY_SUCCESS',
            time: '2026-10-25T08:00:00Z',
            data: { is_rts: false },
          },
        ],
      }).state,
    ).toBe('problem');
  });

  it('Ninja Van: a later return scan beats an earlier delivery scan', () => {
    expect(
      classifyNinjaVan({
        status: 'Completed',
        events: [
          { type: 'DELIVERY_SUCCESS', time: '2026-10-20T08:00:00Z', data: { is_rts: false } },
          { type: 'DELIVERY_SUCCESS', time: '2026-10-25T08:00:00Z', data: { is_rts: true } },
        ],
      }).state,
    ).toBe('problem');
  });

  it('Ninja Van: an answer with no status or events throws', () => {
    expect(() => classifyNinjaVan({} as NinjaOrder)).toThrow(/no status/);
  });

  it('Pos Laju: decides on the machine event codes when present', () => {
    const at = (h: string) => `06 Oct 2026, ${h}:00:00 AM`;
    expect(
      classifyPosLaju({
        process_status: 'DELIVERED',
        tracking_data: [
          { date: at('10'), process: 'Item handed over', event_type: 'delivery_success' },
          { date: at('09'), process: 'Out for delivery', event_type: 'out_for_delivery' },
        ],
      }).state,
    ).toBe('delivered');
    expect(
      classifyPosLaju({
        process_status: 'DELIVERED',
        tracking_data: [
          { date: at('11'), process: 'Delivery completed', event_type: 'delivery_success' },
          { date: at('10'), process: 'Sent back', event_type: 'rts_initiated' },
        ],
      }).state,
    ).toBe('problem');
    expect(
      classifyPosLaju({
        process_status: 'DELIVERED',
        tracking_data: [
          { date: at('09'), process: 'Out for delivery', event_type: 'out_for_delivery' },
        ],
      }).state,
    ).not.toBe('delivered');
  });
});
