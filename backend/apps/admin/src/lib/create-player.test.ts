import { describe, it, expect } from 'vitest';
import {
  defaultGroupForNewPlayer,
  generatePlayerEmail,
  generatePlayerPassword,
} from './create-player';

describe('generatePlayerEmail', () => {
  it('is partner-<6 unambiguous chars>@polycards.gg and varies', () => {
    const a = generatePlayerEmail();
    expect(a).toMatch(
      /^partner-[abcdefghijkmnpqrstuvwxyz23456789]{6}@polycards\.gg$/,
    );
    expect(generatePlayerEmail()).not.toBe(a);
    expect(generatePlayerEmail('vip')).toMatch(/^vip-/);
  });
});

describe('generatePlayerPassword', () => {
  it('is 16 chars from the symbol-free alphabet and varies', () => {
    const p = generatePlayerPassword();
    expect(p).toMatch(
      /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{16}$/,
    );
    expect(generatePlayerPassword()).not.toBe(p);
  });
});

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
