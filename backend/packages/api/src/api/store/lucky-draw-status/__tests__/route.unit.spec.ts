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
  luckyDrawPage.mockResolvedValue({ event: null, prizes: [] });
  expect(await run()).toEqual({ live: false });
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
    event: event(86_400_000),
    prizes: [drawn, open],
  });
  expect(await run()).toEqual({ live: true });
});

// The page keeps an ended or fully drawn event's results up; the sheet says
// "Coming soon" until the next event is set up.
it('answers live: false once every prize is drawn', async () => {
  luckyDrawPage.mockResolvedValue({ event: event(86_400_000), prizes: [drawn] });
  expect(await run()).toEqual({ live: false });
});

it('answers live: false once the event has ended', async () => {
  luckyDrawPage.mockResolvedValue({ event: event(-60_000), prizes: [open] });
  expect(await run()).toEqual({ live: false });
});
