import { LOSSLESS_PERCENT } from '../buyback-rate';
import { FREE_WELCOME_CATEGORY } from '../free-pack';
import {
  isLossless,
  losslessStatus,
  withLossless,
  type LosslessWindow,
} from '../lossless';

const S = Date.parse('2026-10-16T16:00:00Z');
const E = Date.parse('2026-10-18T16:00:00Z');

const all: LosslessWindow = {
  id: 'a',
  starts_at: new Date(S),
  ends_at: new Date(E),
  cancelled_at: null,
  pack_slugs: null,
};
const gold = { slug: 'gold-pack', category: 'pokemon', buyback_percent: 90 };
const silver = { slug: 'silver-pack', category: 'pokemon' };

describe('lossless', () => {
  it('LOSSLESS_PERCENT is 100', () => {
    expect(LOSSLESS_PERCENT).toBe(100);
  });

  it('is live from starts_at (inclusive) to ends_at (exclusive)', () => {
    expect(isLossless([all], gold, S)).toBe(true);
    expect(isLossless([all], gold, S - 1)).toBe(false);
    expect(isLossless([all], gold, E - 1)).toBe(true);
    expect(isLossless([all], gold, E)).toBe(false);
  });

  it('accepts ISO strings for the dates', () => {
    const iso: LosslessWindow = {
      ...all,
      starts_at: new Date(S).toISOString(),
      ends_at: new Date(E).toISOString(),
    };
    expect(isLossless([iso], gold, S)).toBe(true);
    expect(isLossless([iso], gold, E)).toBe(false);
  });

  it('never matches a window with an unparsable start or end', () => {
    expect(isLossless([{ ...all, starts_at: 'nope' }], gold, S)).toBe(false);
    expect(isLossless([{ ...all, ends_at: 'nope' }], gold, S)).toBe(false);
  });

  it('excludes the free welcome pack and reward boxes', () => {
    expect(
      isLossless(
        [all],
        { slug: 'welcome', category: FREE_WELCOME_CATEGORY },
        S,
      ),
    ).toBe(false);
    expect(isLossless([all], { slug: 'rb', category: 'reward_box' }, S)).toBe(
      false,
    );
  });

  it('excludes a ticket pack, which has no buyback to lift', () => {
    const lucky = { slug: 'lucky', category: 'poly', prize_type: 'tickets' };
    expect(isLossless([all], lucky, S)).toBe(false);
    expect(isLossless([{ ...all, pack_slugs: ['lucky'] }], lucky, S)).toBe(false);
    expect(isLossless([all], { ...lucky, prize_type: 'cards' }, S)).toBe(true);
  });

  it('excludes reward-sourced pulls but not gift or bonus', () => {
    expect(isLossless([all], gold, S + 1, 'reward')).toBe(false);
    expect(isLossless([all], gold, S + 1, 'gift')).toBe(true);
    expect(isLossless([all], gold, S + 1, 'bonus')).toBe(true);
    expect(isLossless([all], gold, S + 1, 'pack')).toBe(true);
    expect(isLossless([all], gold, S + 1, null)).toBe(true);
  });

  it('limits a window to its pack_slugs when set', () => {
    const only = { ...all, pack_slugs: ['silver-pack'] };
    expect(isLossless([only], gold, S)).toBe(false);
    expect(isLossless([only], silver, S)).toBe(true);
  });

  it('treats a mid-window cancel as an early end', () => {
    const cancelled = { ...all, cancelled_at: new Date(S + 1000) };
    expect(isLossless([cancelled], gold, S + 999)).toBe(true);
    expect(isLossless([cancelled], gold, S + 1000)).toBe(false);
    expect(losslessStatus(cancelled, S + 5000)).toBe('ended');
  });

  it('treats a cancel before the start as cancelled and never live', () => {
    const cancelled = { ...all, cancelled_at: new Date(S - 1) };
    expect(losslessStatus(cancelled, S)).toBe('cancelled');
    expect(losslessStatus(cancelled, S - 5000)).toBe('cancelled');
    expect(isLossless([cancelled], gold, S)).toBe(false);
  });

  it('is lossless when any overlapping window is live', () => {
    const cancelled = { ...all, id: 'b', cancelled_at: new Date(S - 1) };
    expect(isLossless([cancelled, all], gold, S)).toBe(true);
  });

  it('reports upcoming, live and ended', () => {
    expect(losslessStatus(all, S - 1)).toBe('upcoming');
    expect(losslessStatus(all, S)).toBe('live');
    expect(losslessStatus(all, E)).toBe('ended');
  });

  it('is false with no pack', () => {
    expect(isLossless([all], null, S)).toBe(false);
    expect(isLossless([all], undefined, S)).toBe(false);
  });

  describe('withLossless', () => {
    it('returns a 100% copy without mutating the pack', () => {
      const out = withLossless(gold, [all], S);
      expect(out?.buyback_percent).toBe(LOSSLESS_PERCENT);
      expect(out).not.toBe(gold);
      expect(gold.buyback_percent).toBe(90);
    });

    it('returns the same object when no window applies', () => {
      expect(withLossless(gold, [], S)).toBe(gold);
      expect(withLossless(gold, [all], S, 'reward')).toBe(gold);
    });

    it('passes a missing pack through', () => {
      expect(withLossless(undefined, [all], S)).toBeUndefined();
      expect(withLossless(null, [all], S)).toBeNull();
    });
  });
});
