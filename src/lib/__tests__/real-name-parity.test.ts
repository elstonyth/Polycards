import { describe, it, expect } from 'vitest';

import {
  normalizeRealName,
  REAL_NAME_INVALID,
  REAL_NAME_MAX,
  REAL_NAME_MIN,
} from '@/lib/real-name';
// Plain TS with no Medusa imports, so directly importable across the package
// boundary (same technique as free-pack-parity.test.ts).
import {
  normalizeRealName as backendNormalizeRealName,
  REAL_NAME_INVALID as BACKEND_REAL_NAME_INVALID,
  REAL_NAME_MAX as BACKEND_REAL_NAME_MAX,
  REAL_NAME_MIN as BACKEND_REAL_NAME_MIN,
} from '../../../backend/packages/api/src/utils/real-name';

// The storefront's check is a courtesy; the backend's is the one that refuses.
// If they drift, the form either blocks a name the backend would take, or
// passes one it refuses after the customer already confirmed it.
describe('real-name validator parity (storefront ↔ backend)', () => {
  it('shares the bounds and the refusal copy', () => {
    expect(REAL_NAME_MIN).toBe(BACKEND_REAL_NAME_MIN);
    expect(REAL_NAME_MAX).toBe(BACKEND_REAL_NAME_MAX);
    expect(REAL_NAME_INVALID).toBe(BACKEND_REAL_NAME_INVALID);
  });

  it.each([
    'Tan Ah Kow',
    '  MUHAMMAD   ALI  BIN  ABU  ',
    'Siti Nur @ Aisyah',
    'Rajesh a/l Kumar',
    "O'Neil Jean-Luc",
    '陈大文',
    'Nguyễn Văn An',
    '',
    'ab',
    'Tan 123',
    '-Tan',
    'Tan 😀',
    'https://x.y',
    'a'.repeat(101),
  ])('normalizes %j identically', (input) => {
    expect(normalizeRealName(input)).toBe(backendNormalizeRealName(input));
  });
});
