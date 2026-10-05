import { describe, expect, it } from 'vitest';
import { TaskHubSchema } from '../schemas';

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task_1',
  kind: 'daily',
  title: 'Rip a pack today',
  requirement: { type: 'rip_count', count: 1, pack_id: null },
  reward: {
    type: 'card',
    card_handle: 'pika',
    card_name: 'Pikachu',
    card_grade: 'PSA 10',
    card_value_myr: 120,
    card_image: 'https://cdn.example/pika-slab.webp',
  },
  progress: { current: 0, target: 1, completed: false },
  claimed: false,
  ...over,
});

const hub = (over: Record<string, unknown> = {}) => ({
  week_start: '2026-10-05',
  day_key: '2026-10-06',
  checkins_this_week: 2,
  vip_level: 3,
  checked_in_today: true,
  pending_spins: [
    {
      claim_id: 'c1',
      task_id: 't1',
      title: 'Free rip',
      pack_id: 'bronze',
      pack_title: 'Bronze Pack',
      pack_image: '/images/polycards/bronze.webp',
    },
  ],
  tasks: [task()],
  ...over,
});

describe('TaskHubSchema (task hub v2)', () => {
  it('carries daily tasks, reward art and the check-in count', () => {
    const r = TaskHubSchema.parse(hub());
    expect(r.tasks[0]?.kind).toBe('daily');
    expect(r.tasks[0]?.reward.card_image).toBe(
      'https://cdn.example/pika-slab.webp',
    );
    expect(r.pending_spins[0]?.pack_image).toBe(
      '/images/polycards/bronze.webp',
    );
    expect(r.checkins_this_week).toBe(2);
    expect(r.day_key).toBe('2026-10-06');
  });

  it('drops ONE row of a kind it does not know, never the whole hub', () => {
    // Deploy skew: a backend a cadence ahead must not blank /task.
    const r = TaskHubSchema.parse(
      hub({ tasks: [task({ kind: 'monthly' }), task({ id: 'task_2' })] }),
    );
    expect(r.tasks.map((t) => t.id)).toEqual(['task_2']);
  });

  it('a backend that predates the new fields still parses', () => {
    const r = TaskHubSchema.parse(
      hub({
        day_key: undefined,
        checkins_this_week: undefined,
        tasks: [
          task({ kind: 'weekly', reward: { type: 'credit', amount_myr: 5 } }),
        ],
      }),
    );
    expect(r.checkins_this_week).toBeUndefined();
    expect(r.tasks).toHaveLength(1);
  });
});
