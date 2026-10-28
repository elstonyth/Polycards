import { describe, expect, it } from 'vitest';
import { attemptKey, settleAttempt } from './grant-attempts';

const lost = new TypeError('Failed to fetch');
const status = (s: number) => Object.assign(new Error('x'), { status: s });

describe('grant attempt keys', () => {
  // The panel unmounts on every tab switch. A key held only by the mounted
  // panel turned a retyped identical grant, after a lost response, into a
  // second grant with a fresh key.
  it('replays the key for the same grant after the panel remounts', () => {
    const first = attemptKey('bonus:cus_a', '[50,"thanks"]');
    // remount: nothing but the module's own state carries over
    expect(attemptKey('bonus:cus_a', '[50,"thanks"]')).toBe(first);
  });

  it('keeps the key after a lost response or a 5xx', () => {
    const first = attemptKey('gift:cus_b', 'g1');
    settleAttempt('gift:cus_b', lost);
    expect(attemptKey('gift:cus_b', 'g1')).toBe(first);
    settleAttempt('gift:cus_b', status(502));
    expect(attemptKey('gift:cus_b', 'g1')).toBe(first);
  });

  it('starts fresh after a success, a 4xx, or changed values', () => {
    const a = attemptKey('bonus:cus_c', 's1');
    settleAttempt('bonus:cus_c');
    const b = attemptKey('bonus:cus_c', 's1');
    expect(b).not.toBe(a);
    settleAttempt('bonus:cus_c', status(400));
    const c = attemptKey('bonus:cus_c', 's1');
    expect(c).not.toBe(b);
    expect(attemptKey('bonus:cus_c', 's2')).not.toBe(c);
  });

  it('never shares a key between customers or kinds', () => {
    const a = attemptKey('bonus:cus_d', 'same');
    expect(attemptKey('bonus:cus_e', 'same')).not.toBe(a);
    expect(attemptKey('gift:cus_d', 'same')).not.toBe(a);
  });
});
