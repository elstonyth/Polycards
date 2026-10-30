import { describe, expect, it } from 'vitest';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';
import { rm, rm0, rmAuto } from '@/lib/format';
import {
  CREDIT_ART,
  challengeOf,
  challengeStatus,
  progressOf,
  checkinCount,
  claimNotice,
  claimableCounts,
  orderForDisplay,
  rewardArt,
  rewardLabel,
  splitHub,
  stubName,
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
    tickets: 0,
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

describe('claimNotice — Lucky Draw tickets', () => {
  const base = claimNotice({ type: 'credit', amount_myr: 5 });
  it('appends the ticket count, singular for one', () => {
    expect(claimNotice({ type: 'credit', amount_myr: 5 }, 50)).toBe(
      `${base} + 50 Lucky Draw tickets`,
    );
    expect(claimNotice({ type: 'credit', amount_myr: 5 }, 1)).toBe(
      `${base} + 1 Lucky Draw ticket`,
    );
  });

  it('adds nothing for zero, none, or a broken count', () => {
    for (const tickets of [0, undefined, Number.NaN, -3])
      expect(claimNotice({ type: 'credit', amount_myr: 5 }, tickets)).toBe(
        base,
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
      subject: 'Bronze Pack',
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
    const topup = (current: number, target = 100) =>
      task('t', {
        req: { type: 'topup_myr' },
        progress: { current, target, completed: false },
      });
    // The row's headline already says the RM target; the count is just
    // how much is in, and the screen-reader text carries both.
    expect(progressOf(topup(40.5))).toMatchObject({
      count: { done: rm(40.5), of: null },
      label: `${rm(40.5)} of ${rm0(100)}`,
    });
    // RM 99.99 must never round to "done" — not in the count, not in the bar.
    expect(progressOf(topup(99.99)).count.done).toBe(rm(99.99));
    expect(progressOf(topup(99.99)).pct).toBe(99);
    expect(progressOf(topup(40)).count.done).toBe(rm0(40));
    // Money never draws pips: RM 9.75 of RM 10 would light all ten.
    expect(progressOf(topup(9.75, 10)).pips).toBe(false);
    expect(progressOf(task('r'))).toMatchObject({
      count: { done: '1', of: '3' },
      label: '1 of 3',
    });
  });

  it('clamps progress to the goal and picks pips only for small counts', () => {
    const at = (current: number, target: number) =>
      progressOf(
        task('p', { progress: { current, target, completed: false } }),
      );
    expect(at(12, 10)).toMatchObject({ done: 10, pct: 100 });
    expect(at(-1, 10)).toMatchObject({ done: 0, pct: 0 });
    expect(at(995, 1000).pct).toBe(99);
    expect(at(3, 10).pips).toBe(true);
    expect(at(3, 11).pips).toBe(false);
    expect(at(0, 0)).toMatchObject({ pct: 0, pips: false });
  });

  it('words every known goal in its own verb and unit', () => {
    const row = (type: string, target: number, current: number) =>
      task(type, {
        req: { type },
        progress: { current, target, completed: false },
      });
    const table: [string, number, string, string, string][] = [
      ['vault_count', 25, 'COLLECT', '×25', '24 more cards to go'],
      ['reach_level', 10, 'REACH', 'LV 10', '9 more levels to go'],
      ['checkin_days', 3, 'CHECK IN', '×3', '2 more check-ins to go'],
      ['rip_count', 2, 'RIP', '×2', '1 more rip to go'],
    ];
    for (const [type, target, verb, amount, status] of table) {
      const current = target - Number(status.split(' ')[0]);
      expect(challengeOf(row(type, target, current))).toMatchObject({
        verb,
        amount,
      });
      expect(challengeStatus(row(type, target, current))).toBe(status);
    }
  });

  it('names the pictured pack or Pokémon for its alt text', () => {
    expect(
      challengeOf(
        task('n', {
          req: { type: 'rip_count', pack_title: 'Bronze Pack', pack_image: '' },
        }),
      ),
    ).toMatchObject({ subject: 'Bronze Pack', art: null });
  });

  it('says a goal it cannot measure is unavailable, not nearly done', () => {
    expect(
      challengeStatus(
        task('z', {
          req: { type: 'spend_myr' },
          progress: { current: 0, target: 0, completed: false },
        }),
      ),
    ).toBe('Not available right now');
  });

  it('labels the stub prize without repeating the worth on the badge', () => {
    expect(stubName({ type: 'credit', amount_myr: 50 })).toBe('Bonus credit');
    expect(
      stubName({ type: 'pack', pack_id: 'bronze', pack_title: 'Bronze Pack' }),
    ).toBe('Free rip · Bronze Pack');
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
    ).toBe(
      `Top up ${rmAuto(59.5).replace(' ', String.fromCharCode(0xa0))} more`,
    );
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
