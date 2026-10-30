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
  it('delivered on the real page, at the delivery scan time, with no recipient name', () => {
    const r = classifyDhlEcommerce(fixture('dhl-ecommerce-delivered.html'));
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
  const html = (status: number, body: string) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as Response;

  it('routes each number to its carrier and keeps per-number failures', async () => {
    const fetchFn = jest.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('NVMYNINJA000000001')) return json(200, ninjaDelivered);
      if (u.includes('NVMYNINJA000000002')) return json(404, {});
      if (u.includes('NVMYNINJA000000003')) return json(503, {});
      if (u.includes('ref=7128100488960676')) {
        return html(200, fixture('dhl-ecommerce-delivered.html'));
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
});
