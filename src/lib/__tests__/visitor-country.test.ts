import { describe, it, expect } from 'vitest';
import { countryOfIp, visitorRefusal } from '@/lib/visitor-country';

describe('countryOfIp', () => {
  it.each([
    ['156.222.253.157', 'EG'], // the 2026-10-03 free-pack farming burst
    ['175.143.0.1', 'MY'],
    ['202.166.0.1', 'SG'],
    ['8.8.8.8', 'US'],
    ['::ffff:175.143.0.1', 'MY'], // IPv4-mapped IPv6, as some proxies send it
    ['2405:3800:8fa:b723::1', 'MY'], // Malaysian mobile IPv6
    ['2c0f:fc88::1', 'EG'], // IPv6 is covered too, not waved through
  ])('maps %s to %s', (ip, country) => {
    expect(countryOfIp(ip)).toBe(country);
  });

  // Unknown must stay null, never a guess: visitorRefusal refuses it.
  it.each([
    undefined,
    null,
    '',
    '10.244.9.106', // private
    'fd00::1', // private IPv6
    '999.1.1.1',
    '1.2.3',
    'not-an-ip',
  ])('returns null for %s', (ip) => {
    expect(countryOfIp(ip)).toBeNull();
  });
});

describe('visitorRefusal', () => {
  it.each([
    ['no header (local dev, tests)', null],
    ['a Malaysian address', '175.143.0.1'],
    ['a Malaysian IPv6 address', '2405:3800:8fa:b723::1'],
  ])('allows %s', (_, header) => {
    expect(visitorRefusal(header)).toBeNull();
  });

  it.each([
    ['8.8.8.8', 'visitor country US'],
    ['202.166.0.1', 'visitor country SG'],
    // A client-sent value joined with the ingress's own, in either order.
    ['175.143.0.1, 8.8.8.8', 'more than one visitor address'],
    ['8.8.8.8,175.143.0.1', 'more than one visitor address'],
    ['', 'a visitor address with no known country'],
    ['not-an-ip', 'a visitor address with no known country'],
    ['175.143.0.1:443', 'a visitor address with no known country'],
    ['10.244.9.106', 'a visitor address with no known country'],
  ])('refuses %j', (header, reason) => {
    expect(visitorRefusal(header)).toBe(reason);
  });
});
