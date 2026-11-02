import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_COUNT, avatarForSeed, avatarPath } from '../avatar-seed';

describe('avatarForSeed', () => {
  it('always lands inside the catalog', () => {
    for (const seed of [0, 1, 79, 80, 81, 2_147_483_647, -5, 1.9]) {
      const id = Number(/avatar-(\d+)\.webp$/.exec(avatarForSeed(seed))?.[1]);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(AVATAR_COUNT);
    }
  });

  it('gives a customer the same avatar on every call', () => {
    expect(avatarForSeed(1234)).toBe(avatarForSeed(1234));
  });

  it('falls back to a real avatar on a non-finite seed', () => {
    expect(avatarForSeed(Number.NaN)).toBe('/images/avatars/avatar-1.webp');
  });
});

// A count that outgrew the files would show customers a broken image, and the
// tile would offer it in the picker.
it('every catalog id has its file', () => {
  const missing = Array.from({ length: AVATAR_COUNT }, (_, i) =>
    avatarPath(i + 1),
  ).filter((p) => !existsSync(join(process.cwd(), 'public', p)));
  expect(missing).toEqual([]);
});
