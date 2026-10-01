import * as fs from 'fs';
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
});
