import * as fs from 'fs';
import type { MedusaRequest } from '@medusajs/framework/http';
import { RATE_LIMITS } from '../../utils/rate-limit';
import {
  MIDDLEWARES_PATH,
  extractLimiterEntries,
  isLimited,
  limiterBindings,
} from '../../__tests__/rate-limit-coverage-helpers';

const src = fs.readFileSync(MIDDLEWARES_PATH, 'utf8');
const entry = extractLimiterEntries(src).find(
  (e) => e.matcher === '/reports/*',
);

describe('/reports/* middleware registration', () => {
  it('registers GET /reports/* with the rate limiter BEFORE the key guard', () => {
    expect(entry).toBeDefined();
    expect(entry!.methods).toEqual(['GET']);
    expect(isLimited(entry!, limiterBindings(src))).toBe(true);
    const limiterAt = entry!.middlewares.indexOf('deskReportsRateLimit');
    const guardAt = entry!.middlewares.indexOf('requireReportKey()');
    expect(limiterAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(limiterAt);
  });

  it('binds the desk-reports limiter once', () => {
    expect(src.match(/rateLimit\('desk-reports'\)/g)).toHaveLength(1);
  });

  // Every desk bot calls from the one PC, so an IP-only key would let a busy
  // desk spend every other desk's budget.
  it('keys the desk-reports limiter by desk and caller address', () => {
    const keyOf = RATE_LIMITS['desk-reports'].keyOf;
    const req = (originalUrl: string, ip: string) =>
      ({ originalUrl, ip, headers: {} }) as unknown as MedusaRequest;
    expect(keyOf(req('/reports/finance/economy', '1.2.3.4'))).toBe(
      'finance:ip:1.2.3.4',
    );
    expect(keyOf(req('/reports/growth/challenge?week=last', '1.2.3.4'))).toBe(
      'growth:ip:1.2.3.4',
    );
    expect(keyOf(req('/reports/nope/x', '5.6.7.8'))).toBe('none:ip:5.6.7.8');
  });
});
