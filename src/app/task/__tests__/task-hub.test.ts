import { describe, expect, it } from 'vitest';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';
import {
  CREDIT_ART,
  checkinCount,
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
    ).toEqual({ name: 'Pikachu · PSA 10', value: 120 });
    expect(
      rewardLabel({ type: 'pack', pack_id: 'bronze', pack_price_myr: 30 }),
    ).toEqual({ name: 'Free rip · bronze', value: 30 });
  });
});
