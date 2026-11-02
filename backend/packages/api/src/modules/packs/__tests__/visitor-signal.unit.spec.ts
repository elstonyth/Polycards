import PacksModuleService from '../service';

// The SQL behind support's same-device and same-network flags (ADR 0016), on a
// fake `em`. Same fake-`this` technique as customer-metadata-lock.unit.spec.ts.
// That the SQL runs is proved on a prod copy, not here.
const fakeService = (answers: unknown[][] = []) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const calls: { sql: string; params: unknown[] }[] = [];
  const em = {
    execute: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return answers.shift() ?? [];
    }),
  };
  return { svc, calls, ctx: { transactionManager: em, manager: em } as never };
};

describe('recordVisitorSignal', () => {
  it('upserts on the unique index, with a browserless visit stored as blank', async () => {
    const { svc, calls, ctx } = fakeService();
    await svc.recordVisitorSignal(
      { customerId: 'cus_1', ip: '175.143.0.1', deviceId: null },
      ctx,
    );
    expect(calls[0].sql).toContain(
      'ON CONFLICT (customer_id, ip, device_id) DO UPDATE',
    );
    expect(calls[0].sql).toContain('hits = visitor_signal.hits + 1');
    expect(calls[0].params.slice(1)).toEqual(['cus_1', '175.143.0.1', '']);
    expect(String(calls[0].params[0])).toMatch(/^vsig_/);
  });
});

describe('visitorSignalMatches', () => {
  it('never lists the customer themself, and ignores a blank browser id', async () => {
    const { svc, calls, ctx } = fakeService([[{ n: 3 }], [], []]);
    const out = await svc.visitorSignalMatches('cus_1', ctx);
    expect(out).toEqual({ recorded: true, device: [], ip: [] });
    for (const { sql, params } of calls.slice(1)) {
      expect(sql).toContain('customer_id <> ?');
      expect(params).toEqual(['cus_1', 'cus_1']);
    }
    expect(calls[1].sql).toContain("device_id <> ''");
  });

  it('says when nothing has been recorded yet', async () => {
    const { svc, ctx } = fakeService([[{ n: 0 }], [], []]);
    expect((await svc.visitorSignalMatches('cus_1', ctx)).recorded).toBe(false);
  });

  it('puts the smallest IP groups first and caps the names', async () => {
    const { svc, calls, ctx } = fakeService([[{ n: 1 }], [], []]);
    await svc.visitorSignalMatches('cus_1', ctx);
    expect(calls[2].sql).toContain('ORDER BY accounts ASC');
    expect(calls[2].sql).toContain('[1:10]');
  });
});

describe('purgeVisitorSignals', () => {
  it('keeps 180 days, as the privacy page says', async () => {
    const { svc, calls, ctx } = fakeService();
    await svc.purgeVisitorSignals(ctx);
    expect(calls[0].sql).toContain("interval '180 days'");
    expect(calls[0].sql).toContain('DELETE FROM visitor_signal');
  });
});
