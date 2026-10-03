import { describe, it, expect } from 'vitest';
import { countryOfIp } from '@/lib/visitor-country';

describe('countryOfIp', () => {
  it.each([
    ['156.222.253.157', 'EG'], // the 2026-10-03 free-pack farming burst
    ['175.143.0.1', 'MY'],
    ['202.166.0.1', 'SG'],
    ['::ffff:175.143.0.1', 'MY'], // IPv4-mapped IPv6, as some proxies send it
  ])('maps %s to %s', (ip, country) => {
    expect(countryOfIp(ip)).toBe(country);
  });

  // Unknown must stay null, never a guess: the gate lets null through.
  it.each([
    undefined,
    null,
    '',
    '2405:3800:8fa:b723::1', // IPv6: not in the IPv4-only data
    '10.244.9.106', // private
    '999.1.1.1',
    '1.2.3',
    'not-an-ip',
  ])('returns null for %s', (ip) => {
    expect(countryOfIp(ip)).toBeNull();
  });
});
