import { deskOf, requireReportKey } from '../require-report-key';

const FINANCE = 'f'.repeat(40);
const STORE = 's'.repeat(40);
const saved = {
  finance: process.env.REPORT_KEY_FINANCE,
  store: process.env.REPORT_KEY_STORE,
};
beforeEach(() => {
  process.env.REPORT_KEY_FINANCE = FINANCE;
  process.env.REPORT_KEY_STORE = STORE;
});
afterAll(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('REPORT_KEY_FINANCE', saved.finance);
  restore('REPORT_KEY_STORE', saved.store);
});

function run(
  url: string,
  headers: Record<string, string | string[] | undefined>,
) {
  const info = jest.fn();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = jest.fn();
  requireReportKey()(
    {
      originalUrl: url,
      headers,
      scope: { resolve: () => ({ info }) },
    } as never,
    res as never,
    next,
  );
  return { res, next, info };
}

describe('deskOf', () => {
  it.each([
    ['/reports/finance/economy', 'finance'],
    ['/reports/finance/economy?group=default', 'finance'],
    ['/reports/FINANCE/economy', 'finance'],
    ['/REPORTS/finance/economy', 'finance'],
    ['/reports/store/packs', 'store'],
    ['/reports/admin/economy', null],
    ['/reports', null],
    ['/reports/', null],
    ['/reports//finance/economy', null],
    ['/reportsfinance/economy', null],
    ['/reports/fin%61nce/economy', null],
    // Judged on the RAW path, as Express routes it: new URL() would collapse
    // `\` and `..` and pick a different desk than the handler Express runs.
    ['/reports/finance/player/..\\..\\store\\a', 'finance'],
    ['/reports/store/../finance/economy', 'store'],
    ['http://host:99999/reports/finance/economy', null],
    ['/reports/store\\..\\finance/economy', null],
  ])('%s -> %p', (url, desk) => {
    expect(deskOf(url)).toBe(desk);
  });
});

describe('requireReportKey', () => {
  const ECONOMY = '/reports/finance/economy?group=default';

  it('answers 503 and never calls next when the desk key is unset', () => {
    delete process.env.REPORT_KEY_FINANCE;
    const { res, next } = run(ECONOMY, { 'x-report-key': FINANCE });
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a key shorter than 32 characters as unset', () => {
    process.env.REPORT_KEY_FINANCE = 'short';
    expect(run(ECONOMY, { 'x-report-key': 'short' }).res.statusCode).toBe(503);
  });

  it('answers a bare 401 without the header', () => {
    const { res, next } = run(ECONOMY, {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a wrong key of the same length', () => {
    expect(
      run(ECONOMY, { 'x-report-key': 'x'.repeat(40) }).res.statusCode,
    ).toBe(401);
  });

  it('answers 401 for a wrong key of a different length', () => {
    expect(run(ECONOMY, { 'x-report-key': `${FINANCE}x` }).res.statusCode).toBe(
      401,
    );
  });

  it("refuses another desk's key: the store key cannot open finance", () => {
    const { res, next } = run(ECONOMY, { 'x-report-key': STORE });
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an unknown desk whatever key is sent', () => {
    expect(
      run('/reports/admin/economy', { 'x-report-key': FINANCE }).res.statusCode,
    ).toBe(401);
  });

  it('answers a bare 401, not a throw, for an absolute-form target', () => {
    const { res, next } = run('http://host:99999/reports/finance/economy', {
      'x-report-key': FINANCE,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('holds a mixed-case desk segment to that desk key', () => {
    expect(
      run('/reports/Finance/economy', { 'x-report-key': FINANCE }).next,
    ).toHaveBeenCalledTimes(1);
    expect(
      run('/reports/Finance/economy', { 'x-report-key': STORE }).res.statusCode,
    ).toBe(401);
  });

  it('calls next for the right key, writes no response, and logs desk and path', () => {
    const { res, next, info } = run(ECONOMY, { 'x-report-key': FINANCE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(info).toHaveBeenCalledWith(`[reports] finance ${ECONOMY}`);
  });

  it('uses the first value when the header repeats', () => {
    expect(
      run(ECONOMY, { 'x-report-key': [FINANCE, 'other'] }).next,
    ).toHaveBeenCalledTimes(1);
  });

  it('ignores whitespace around the configured key', () => {
    process.env.REPORT_KEY_FINANCE = `  ${FINANCE}\n`;
    expect(
      run(ECONOMY, { 'x-report-key': FINANCE }).next,
    ).toHaveBeenCalledTimes(1);
  });
});
