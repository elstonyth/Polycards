import { describe, expect, it } from 'vitest';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';
import { rm, rm0 } from '@/lib/format';
import {
  CREDIT_ART,
  challengeOf,
  challengeStatus,
  progressCount,
  checkinCount,
  claimNotice,
  claimableCounts,
  orderForDisplay,
  rewardArt,
  rewardLabel,
  splitHub,
} from '../task-hub';

const task = (
  id: string,
  over: Partial<TaskEntry> & {
    req?: Record<string, unknown>;
    done?: boolean;
  } = {},
): TaskEntry => {
  const { req, done, ...rest } = over;
  return {
    id,
    kind: 'weekly',
    title: id,
    requirement: {
      type: 'rip_count',
      count: 3,
      ...req,
    } as TaskEntry['requirement'],
    reward: { type: 'credit', amount_myr: 5 },
    progress: { current: done ? 3 : 1, target: 3, completed: Boolean(done) },
    claimed: false,
    ...rest,
  };
};

const hub = (tasks: TaskEntry[], over: Partial<TaskHub> = {}): TaskHub => ({
  week_start: '2026-10-05',
  vip_level: 1,
  checked_in_today: false,
  pending_spins: [],
  tasks,
  ...over,
});

describe('splitHub', () => {
  it('routes each task to its tab and weekly check-in tasks onto the track', () => {
    const tabs = splitHub([
      task('d1', { kind: 'daily' }),
      task('w1'),
      task('ci3', { req: { type: 'checkin_days', days: 3 } }),
      task('ci7a', { req: { type: 'checkin_days', days: 7 } }),
      task('ci7b', { req: { type: 'checkin_days', days: 7 } }),
      task('dci', { kind: 'daily', req: { type: 'checkin_days', days: 1 } }),
      task('a1', { kind: 'achievement' }),
    ]);
    expect(tabs.daily.map((t) => t.id)).toEqual(['d1', 'dci']);
    expect(tabs.weekly.map((t) => t.id)).toEqual(['w1']);
    expect(tabs.achievements.map((t) => t.id)).toEqual(['a1']);
    expect([...tabs.milestones.keys()].sort()).toEqual([3, 7]);
    expect(tabs.milestones.get(7)!.map((t) => t.id)).toEqual(['ci7a', 'ci7b']);
  });
});

describe('orderForDisplay', () => {
  it('claimable first, claimed last, admin order kept inside each band', () => {
    const out = orderForDisplay([
      task('claimed', { done: true, claimed: true }),
      task('open1'),
      task('ready1', { done: true }),
      task('open2'),
      task('ready2', { done: true }),
    ]);
    expect(out.map((t) => t.id)).toEqual([
      'ready1',
      'ready2',
      'open1',
      'open2',
      'claimed',
    ]);
  });
});

describe('checkinCount', () => {
  it("prefers the backend's count, clamped to the 7 slots", () => {
    const tabs = splitHub([]);
    expect(checkinCount(hub([], { checkins_this_week: 4 }), tabs)).toBe(4);
    expect(checkinCount(hub([], { checkins_this_week: 9 }), tabs)).toBe(7);
  });

  it('a backend without the field falls back to the milestones, then today', () => {
    const ci = task('ci5', { req: { type: 'checkin_days', days: 5 } });
    ci.progress = { current: 2, target: 5, completed: false };
    expect(checkinCount(hub([ci]), splitHub([ci]))).toBe(2);
    expect(
      checkinCount(hub([], { checked_in_today: true }), splitHub([])),
    ).toBe(1);
  });
});

describe('claimableCounts', () => {
  it('counts a claimable check-in milestone on the Daily tab', () => {
    const tabs = splitHub([
      task('ci3', { req: { type: 'checkin_days', days: 3 }, done: true }),
      task('w', { done: true }),
      task('w2', { done: true, claimed: true }),
    ]);
    expect(claimableCounts(tabs)).toEqual({
      daily: 1,
      weekly: 1,
      achievements: 0,
    });
  });
});

describe('reward art and label', () => {
  it('shows the prize itself — slab, pack shot, or credit coins', () => {
    expect(rewardArt({ type: 'credit', amount_myr: 5 })).toBe(CREDIT_ART);
    expect(
      rewardArt({ type: 'pack', pack_id: 'b', pack_image: '/p.webp' }),
    ).toBe('/p.webp');
    expect(rewardArt({ type: 'card', card_image: 'https://cdn/x.webp' })).toBe(
      'https://cdn/x.webp',
    );
    // A gone pack/card has no picture: an icon, never a broken image.
    expect(rewardArt({ type: 'pack', pack_id: 'b', pack_image: null })).toBe(
      null,
    );
  });

  it('names the prize and what it is worth', () => {
    expect(
      rewardLabel({
        type: 'card',
        card_name: 'Pikachu',
        card_grade: 'PSA 10',
        card_value_myr: 120,
      }),
    ).toEqual({
      name: `Pikachu · PSA${String.fromCharCode(0xa0)}10`,
      value: 120,
    });
    expect(
      rewardLabel({ type: 'pack', pack_id: 'bronze', pack_price_myr: 30 }),
    ).toEqual({ name: 'Free rip · bronze', value: 30 });
  });
});

describe('claimNotice', () => {
  it('says bonus credit is for packs, naming the amount when known', () => {
    expect(claimNotice({ type: 'credit', amount_myr: 5 })).toBe(
      `RM${String.fromCharCode(0xa0)}5.00 bonus credit added. Use it on packs — it can’t be withdrawn.`,
    );
    expect(claimNotice({ type: 'credit' })).toBe(
      'Bonus credit added. Use it on packs — it can’t be withdrawn.',
    );
    // A zero or broken amount must never print "RM 0.00" or "RM NaN".
    for (const amount_myr of [0, Number.NaN])
      expect(claimNotice({ type: 'credit', amount_myr })).toBe(
        'Bonus credit added. Use it on packs — it can’t be withdrawn.',
      );
  });

  it('says a prize card ships (for a fee) or sells back', () => {
    expect(claimNotice({ type: 'card', card_name: 'Mew' })).toBe(
      'Card added to your Vault. Ship it (delivery fee applies) or sell it back.',
    );
  });
});

describe('claimNotice — a free rip with no spin to hand over', () => {
  it('points at the waiting free rip, not at the Vault', () => {
    expect(claimNotice({ type: 'pack', pack_id: 'bronze' })).toBe(
      'Free rip added — spin it from the top of this page.',
    );
  });
});

describe('challenge side of a row', () => {
  it('reads each goal as verb · picture · amount', () => {
    expect(
      challengeOf(
        task('a', {
          req: {
            type: 'rip_count',
            count: 10,
            pack_id: 'bronze',
            pack_title: 'Bronze Pack',
            pack_image: '/b.webp',
          },
          progress: { current: 3, target: 10, completed: false },
        }),
      ),
    ).toEqual({
      kind: 'rip',
      verb: 'RIP',
      amount: '×10',
      art: '/b.webp',
    });
    expect(
      challengeOf(
        task('b', {
          req: {
            type: 'vault_pixel_count',
            pokemon_name: 'Pikachu',
            pokemon_image: 'https://cdn/p.gif',
          },
        }),
      ),
    ).toMatchObject({
      kind: 'pull',
      verb: 'PULL',
      art: 'https://cdn/p.gif',
    });
    // Not narrowed (or a backend that predates the art): no picture.
    expect(challengeOf(task('c'))).toMatchObject({ verb: 'RIP', art: null });
    expect(
      challengeOf(
        task('d', {
          req: { type: 'reach_level' },
          progress: { current: 4, target: 10, completed: false },
        }),
      ),
    ).toMatchObject({ verb: 'REACH', amount: 'LV 10' });
    expect(
      challengeOf(
        task('e', {
          req: { type: 'topup_myr' },
          progress: { current: 40.5, target: 100, completed: false },
        }),
      ),
    ).toMatchObject({ verb: 'TOP UP', amount: rm0(100) });
  });

  it('falls back to a neutral goal for types it does not know', () => {
    // A backend newer than this page must not crash it — nor match a
    // prototype key by accident.
    for (const type of ['spend_myr', 'constructor'])
      expect(challengeOf(task('x', { req: { type } }))).toMatchObject({
        kind: 'other',
        verb: 'GOAL',
        art: null,
      });
  });

  it('counts money goals in RM, sen only when there are some', () => {
    const topup = (current: number) =>
      task('t', {
        req: { type: 'topup_myr' },
        progress: { current, target: 100, completed: false },
      });
    expect(progressCount(topup(40.5))).toEqual({
      done: rm(40.5),
      of: rm0(100),
    });
    // RM 99.99 must never round to "done".
    expect(progressCount(topup(99.99)).done).toBe(rm(99.99));
    expect(progressCount(topup(40)).done).toBe(rm0(40));
    expect(progressCount(task('r'))).toEqual({ done: '1', of: '3' });
  });

  it('counts what is left in the requirement unit', () => {
    expect(challengeStatus(task('a'))).toBe('2 more rips to go');
    expect(
      challengeStatus(
        task('b', {
          req: { type: 'vault_pixel_count' },
          progress: { current: 9, target: 10, completed: false },
        }),
      ),
    ).toBe('1 more pull to go');
    expect(
      challengeStatus(
        task('c', {
          req: { type: 'spend_myr' },
          progress: { current: 0, target: 50, completed: false },
        }),
      ),
    ).toBe('50 to go');
    expect(
      challengeStatus(
        task('d', {
          req: { type: 'topup_myr' },
          progress: { current: 40.5, target: 100, completed: false },
        }),
      ),
    ).toBe(`Top up ${rm(59.5)} more`);
  });

  it('says done, or claimed, instead of a count', () => {
    expect(challengeStatus(task('a', { done: true }))).toBe(
      'Complete — your prize is ready',
    );
    expect(challengeStatus(task('b', { done: true, claimed: true }))).toBe(
      'Prize claimed',
    );
    // Target reached but the backend has not flagged it complete yet.
    expect(
      challengeStatus(
        task('c', { progress: { current: 3, target: 3, completed: false } }),
      ),
    ).toBe('Almost there');
  });
});
