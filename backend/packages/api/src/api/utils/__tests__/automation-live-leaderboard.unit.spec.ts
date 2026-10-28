import { observeLiveRanks } from '../automation-live-leaderboard';

const now = Date.parse('2026-10-18T12:00:00Z');
const bounds = {
  startUtc: new Date('2026-10-12T00:00:00Z'),
  endUtc: new Date('2026-10-19T00:00:00Z'),
};
const packs = () => ({
  challengeSettings: jest.fn().mockResolvedValue({
    timezone: 'Asia/Kuala_Lumpur',
    reset_day: 1,
    reset_hour: 8,
  }),
  challengeWeekBounds: jest.fn().mockResolvedValue(bounds),
  challengeWeekTop: jest.fn().mockResolvedValue([
    { customer_id: 'hidden', pulls: 4, volumeMyr: 1000 },
    { customer_id: 'external', pulls: 2, volumeMyr: 500 },
  ]),
  challengeWeekVolumeFor: jest
    .fn()
    .mockResolvedValue({ pulls: 3, volumeMyr: 20 }),
  disabledCustomerIds: jest.fn().mockResolvedValue(new Set(['hidden'])),
  leaderboardTop: jest
    .fn()
    .mockImplementation(async (options: { customerIds?: string[] }) =>
      options.customerIds
        ? [{ customer_id: 'cus_a', pulls: 6, volume: 40, points: 100 }]
        : [{ customer_id: 'external', pulls: 8, volume: 900, points: 100 }],
    ),
});

it('uses challenge anchor and own score below the visible board, excluding hidden accounts', async () => {
  const service = packs();
  const rows = await observeLiveRanks(
    service,
    [{ customerId: 'cus_a', period: 'weekly', targetRank: 1 }],
    () => now,
  );
  expect(rows[0]).toMatchObject({
    customerId: 'cus_a',
    periodKey: bounds.startUtc.toISOString(),
    ownPulls: 3,
    ownValueMyr: 20,
    entries: [{ customerId: 'external', pulls: 2, valueMyr: 500 }],
  });
  expect(service.challengeWeekTop).toHaveBeenCalledWith({
    timezone: 'Asia/Kuala_Lumpur',
    resetDay: 1,
    resetHour: 8,
    limit: 20,
  });
});

it('loads all-time own scores through the same aggregate without a truncated top-list assumption', async () => {
  const service = packs();
  const rows = await observeLiveRanks(
    service,
    [{ customerId: 'cus_a', period: 'alltime', targetRank: 3 }],
    () => now,
  );
  expect(service.leaderboardTop).toHaveBeenCalledWith({
    sinceMs: null,
    limit: 1,
    customerIds: ['cus_a'],
  });
  expect(rows[0]).toMatchObject({
    periodKey: 'alltime',
    ownPulls: 6,
    ownValueMyr: 40,
  });
});

it('fails closed on source errors and a reset between observation queries', async () => {
  const service = packs();
  service.challengeWeekTop.mockRejectedValueOnce(
    new Error('database unavailable'),
  );
  expect(
    await observeLiveRanks(
      service,
      [{ customerId: 'cus_a', period: 'weekly', targetRank: 1 }],
      () => now,
    ),
  ).toEqual([]);
  service.challengeWeekTop.mockResolvedValue([]);
  service.challengeWeekBounds
    .mockResolvedValueOnce(bounds)
    .mockResolvedValueOnce({ ...bounds, startUtc: bounds.endUtc });
  expect(
    await observeLiveRanks(
      service,
      [{ customerId: 'cus_a', period: 'weekly', targetRank: 1 }],
      () => now,
    ),
  ).toEqual([]);
});
