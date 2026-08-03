import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLAYER_GROUP_FLAG,
  DEFAULT_PLAYER_GROUP_NAME,
  effectiveOddsSet,
  isDefaultPlayerGroup,
  oddsSetOf,
} from './player-groups';

// This app builds standalone, so packs/odds-sets.ts cannot be imported here —
// the constants are copied. Copies drift silently, and the consequence is not
// cosmetic: the Profile tab would name a different group, or a different odds
// set, than the spin actually rolls. So read the backend SOURCE and assert the
// literals still match. Same technique as no-core-shadow.test.ts, which reads
// the prebuilt dashboard bundle for the same "no compiler covers this" reason.
const BACKEND_ODDS_SETS = join(
  __dirname,
  '../../../../packages/api/src/modules/packs/odds-sets.ts',
);

describe('player-group constants match the backend', () => {
  const src = readFileSync(BACKEND_ODDS_SETS, 'utf8');

  it('reads the backend source (guards the path itself)', () => {
    // Without this, a moved/renamed backend file would make every extraction
    // below return undefined and the expectations vacuous.
    expect(src).toContain('resolveOddsSetForCustomer');
  });

  it('mirrors DEFAULT_PLAYER_GROUP_NAME', () => {
    const m = /DEFAULT_PLAYER_GROUP_NAME\s*=\s*'([^']+)'/.exec(src);
    expect(m?.[1]).toBe(DEFAULT_PLAYER_GROUP_NAME);
  });

  it('mirrors DEFAULT_PLAYER_GROUP_FLAG', () => {
    const m = /DEFAULT_PLAYER_GROUP_FLAG\s*=\s*'([^']+)'/.exec(src);
    expect(m?.[1]).toBe(DEFAULT_PLAYER_GROUP_FLAG);
  });
});

describe('oddsSetOf', () => {
  it('accepts sets 2 and 3 as number or string', () => {
    expect(oddsSetOf(2)).toBe(2);
    expect(oddsSetOf('2')).toBe(2);
    expect(oddsSetOf(3)).toBe(3);
    expect(oddsSetOf('3')).toBe(3);
  });

  it('rolls anything else to set 1', () => {
    for (const v of [1, '1', 0, 4, 'x', null, undefined, {}]) {
      expect(oddsSetOf(v)).toBe(1);
    }
  });
});

describe('isDefaultPlayerGroup', () => {
  it('matches the metadata marker even after a rename', () => {
    expect(
      isDefaultPlayerGroup({ name: 'House', metadata: { is_default: true } }),
    ).toBe(true);
  });

  it('matches the legacy name for a row that predates the marker', () => {
    expect(isDefaultPlayerGroup({ name: 'DEFAULT', metadata: null })).toBe(
      true,
    );
  });

  it('does not match a real group', () => {
    expect(
      isDefaultPlayerGroup({ name: 'pro', metadata: { odds_set: 2 } }),
    ).toBe(false);
  });
});

describe('effectiveOddsSet', () => {
  it('reads a real group verbatim', () => {
    expect(effectiveOddsSet({ name: 'pro', metadata: { odds_set: 3 } })).toBe(
      3,
    );
  });

  // The invariant the whole design rests on: a default-group member and a
  // customer with no group at all must roll the same odds, so a stray odds_set
  // on that row must never be shown as if it applied.
  it('pins the default group to set 1 whatever its row says', () => {
    expect(
      effectiveOddsSet({ name: 'DEFAULT', metadata: { odds_set: 3 } }),
    ).toBe(1);
    expect(
      effectiveOddsSet({
        name: 'House',
        metadata: { is_default: true, odds_set: 2 },
      }),
    ).toBe(1);
  });
});
