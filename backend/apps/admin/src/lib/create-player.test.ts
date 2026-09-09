import { describe, it, expect } from 'vitest';
import {
  credentialLines,
  defaultGroupForNewPlayer,
  parseBatchCount,
} from './create-player';

describe('defaultGroupForNewPlayer', () => {
  const def = { id: 'g_def', name: 'DEFAULT', metadata: { is_default: true } };
  const pro = { id: 'g_pro', name: 'pro', metadata: { odds_set: 2 } };
  const partner = {
    id: 'g_partner',
    name: 'Partner Acc',
    metadata: { partner_rate_bp: 400 },
  };

  it('prefers the first partner group', () => {
    expect(defaultGroupForNewPlayer([def, pro, partner])).toBe('g_partner');
  });

  it('falls back to DEFAULT, then to nothing', () => {
    expect(defaultGroupForNewPlayer([pro, def])).toBe('g_def');
    expect(defaultGroupForNewPlayer([pro])).toBe('');
    expect(defaultGroupForNewPlayer([])).toBe('');
  });
});

describe('parseBatchCount', () => {
  it('accepts integers in 1..50 and nothing else', () => {
    expect(parseBatchCount('1')).toBe(1);
    expect(parseBatchCount(' 50 ')).toBe(50);
    for (const bad of ['0', '51', '1.5', '', 'x', '-3']) {
      expect(parseBatchCount(bad)).toBeNull();
    }
  });
});

describe('credentialLines', () => {
  it('is one tab-separated line per account, blank name allowed', () => {
    expect(
      credentialLines([
        { name: 'Ada', email: 'a@x.gg', password: 'pw1' },
        { name: null, email: 'b@x.gg', password: 'pw2' },
      ]),
    ).toBe('Ada\ta@x.gg\tpw1\n\tb@x.gg\tpw2');
  });
});
