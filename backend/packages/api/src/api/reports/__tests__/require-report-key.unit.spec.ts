import { deskOf, requireReportKey } from '../require-report-key';

const FINANCE = 'f'.repeat(40);
const STORE = 's'.repeat(40);
const DEVELOPER = 'd'.repeat(40);
const NAMES = [
  'REPORT_KEY_FINANCE',
  'REPORT_KEY_STORE',
  'REPORT_KEY_SUPPORT',
  'REPORT_KEY_GROWTH',
  'REPORT_KEY_DEVELOPER',
];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
beforeEach(() => {
  for (const n of NAMES) delete process.env[n];
  process.env.REPORT_KEY_FINANCE = FINANCE;
  process.env.REPORT_KEY_STORE = STORE;
});
afterAll(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

function run(
  url: string,
  headers: Record<string, string | string[] | undefined>,
) {
  const info = jest.fn();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    // Node lowercases header names when it reads them back; do the same.
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
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
    ['/reports/nope/economy', null],
    ['/reports/admin/read', 'admin'],
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

  it('answers 503 and never calls next when no desk key is set', () => {
    delete process.env.REPORT_KEY_FINANCE;
    delete process.env.REPORT_KEY_STORE;
    const { res, next } = run(ECONOMY, { 'x-report-key': FINANCE });
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a key shorter than 32 characters as unset', () => {
    process.env.REPORT_KEY_FINANCE = 'short';
    expect(run(ECONOMY, { 'x-report-key': 'short' }).res.statusCode).toBe(401);
    delete process.env.REPORT_KEY_STORE;
    expect(run(ECONOMY, { 'x-report-key': 'short' }).res.statusCode).toBe(503);
  });

  it('answers a bare 401 without the header', () => {
    const { res, next } = run(ECONOMY, {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
    expect(res.headers['cache-control']).toBe('no-store');
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

  it("opens every desk's reports with any desk's key, and logs who read what", () => {
    const { next, info } = run(ECONOMY, { 'x-report-key': STORE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(`[reports] store ${ECONOMY}`);
  });

  it('opens them with the developer key, which owns no reports of its own', () => {
    process.env.REPORT_KEY_DEVELOPER = DEVELOPER;
    const { next, info } = run('/reports/store/packs', {
      'x-report-key': DEVELOPER,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      '[reports] developer /reports/store/packs',
    );
    // Still no developer routes: the path must name a report desk.
    expect(
      run('/reports/developer/x', { 'x-report-key': DEVELOPER }).res.statusCode,
    ).toBe(401);
  });

  it('refuses an unknown desk whatever key is sent', () => {
    const { res } = run('/reports/nope/economy', { 'x-report-key': FINANCE });
    expect(res.statusCode).toBe(401);
    // The earliest return: the header must not wait for the key checks.
    expect(res.headers['cache-control']).toBe('no-store');
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
      run('/reports/Finance/economy', { 'x-report-key': 'x'.repeat(40) }).res
        .statusCode,
    ).toBe(401);
  });

  it('calls next for the right key, writes no response, and logs desk and path', () => {
    const { res, next, info } = run(ECONOMY, { 'x-report-key': FINANCE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(res.headers['cache-control']).toBe('no-store');
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
