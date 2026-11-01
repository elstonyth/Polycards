import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { GET } from '../route';
import { clearLuckyDrawCache } from '../../lucky-draw/view';

// The Games sheet's "is a Lucky Draw on?" — public, so it must answer from the
// shared page alone and carry nothing but the boolean.
jest.mock('../../pulls/pullers', () => ({
  loadPullerProfiles: async () => ({
    disabled: new Set<string>(),
    profileOf: () => ({}),
  }),
}));

const luckyDrawPage = jest.fn();
const mkReq = () =>
  ({
    scope: { resolve: () => ({ luckyDrawPage }) },
  }) as unknown as MedusaRequest;
const run = async () => {
  let body: unknown;
  await GET(mkReq(), {
    json: (b: unknown) => (body = b),
  } as unknown as MedusaResponse);
  return body;
};

beforeEach(() => {
  clearLuckyDrawCache();
  luckyDrawPage.mockReset();
});

it('answers live: false when no event is published', async () => {
  luckyDrawPage.mockResolvedValue({ events: [], event: null, prizes: [] });
  expect(await run()).toEqual({
    live: false,
    latest_gate_at: null,
    upcoming: [],
  });
});

const event = (endsInMs: number) => ({
  id: 'ldev_1',
  name: 'November Lucky Draw',
  starts_at: new Date(Date.now() - 86_400_000).toISOString(),
  ends_at: new Date(Date.now() + endsInMs).toISOString(),
  top: [],
  result: null,
});

const open = { id: 'ldpz_1', top: [], result: null };
const drawn = {
  id: 'ldpz_2',
  top: [],
  result: { prize_id: 'ldpz_2', winner_customer_id: null },
};

it('answers live: true, and only that, while a prize is still open', async () => {
  luckyDrawPage.mockResolvedValue({
    events: [],
    event: event(86_400_000),
    prizes: [drawn, open],
  });
  expect(await run()).toEqual({
    live: true,
    latest_gate_at: null,
    upcoming: [],
  });
});

// The page keeps an ended or fully drawn event's results up; the sheet says
// "Coming soon" until the next event is set up.
it('answers live: false once every prize is drawn', async () => {
  luckyDrawPage.mockResolvedValue({
    events: [],
    event: event(86_400_000),
    prizes: [drawn],
  });
  expect(await run()).toEqual({
    live: false,
    latest_gate_at: null,
    upcoming: [],
  });
});

it('answers live: false once the event has ended', async () => {
  luckyDrawPage.mockResolvedValue({
    events: [],
    event: event(-60_000),
    prizes: [open],
  });
  expect(await run()).toEqual({
    live: false,
    latest_gate_at: null,
    upcoming: [],
  });
});

it('names when the newest open gate went live, for the Draw tab dot', async () => {
  const gate = (liveAt: string, endsInMs: number) => ({
    id: liveAt,
    live_at: liveAt,
    ends_at: new Date(Date.now() + endsInMs).toISOString(),
    top: [],
  });
  luckyDrawPage.mockResolvedValue({
    events: [
      gate('2026-11-01T00:00:00.000Z', 3_600_000),
      gate('2026-11-02T00:00:00.000Z', 3_600_000),
      // Ended, waiting for its draw: not something to come and see.
      gate('2026-11-03T00:00:00.000Z', -60_000),
    ],
    event: null,
    prizes: [],
  });
  expect(await run()).toMatchObject({
    live: false,
    latest_gate_at: '2026-11-02T00:00:00.000Z',
  });
});

it('lists every gate still to draw, ended ones too: ids and times, nothing else', async () => {
  const endsAt = new Date(Date.now() - 60_000).toISOString();
  luckyDrawPage.mockResolvedValue({
    events: [
      {
        id: 'ldev_9',
        live_at: endsAt,
        ends_at: endsAt,
        total_tickets: 40,
        entrant_count: 4,
        top: [{ customer_id: 'cus_1', tickets: 40 }],
      },
    ],
    event: null,
    prizes: [],
  });
  const body = (await run()) as { upcoming: unknown };
  expect(body.upcoming).toEqual([{ id: 'ldev_9', ends_at: endsAt }]);
});
