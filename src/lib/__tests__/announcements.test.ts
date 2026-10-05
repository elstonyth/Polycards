import { describe, it, expect } from 'vitest';
import { AnnouncementsSchema } from '@/lib/data/schemas';
import {
  announcementKey,
  mytDay,
  recordSeen,
  unseenAnnouncements,
} from '@/lib/announcement-seen';

const slide = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  image_url: `https://cdn.example.com/${id}.webp`,
  title: null,
  link_url: '/slots/base-set',
  updated_at: '2026-10-06T00:00:00.000Z',
  ...over,
});

describe('AnnouncementsSchema', () => {
  it('parses the store route shape (nullable caption and link)', () => {
    const body = { announcements: [slide('ann_1')] };
    expect(AnnouncementsSchema.parse(body)).toEqual(body);
  });

  it.each([
    ['missing', undefined],
    ['relative', '/static/a.webp'],
    ['relative with a query', '/static/a.webp?x=1'],
    ['protocol-relative', '//cdn.example.com/a.webp'],
    ['javascript:', 'javascript:alert(1)'],
    ['backslash', 'https://cdn.example.com\\a.webp'],
    ['inner space', 'https://cdn.example.com/a b.webp'],
    ['control char', 'https://cdn.example.com/a\u0001.webp'],
  ])(
    'drops a slide whose image_url is %s, keeping the others',
    (_label, image_url) => {
      const parsed = AnnouncementsSchema.parse({
        announcements: [slide('bad', { image_url }), slide('good')],
      });
      expect(parsed.announcements.map((a) => a.id)).toEqual(['good']);
    },
  );

  it('rejects a body that is not a list at all', () => {
    expect(
      AnnouncementsSchema.safeParse({ announcements: 'garbage' }).success,
    ).toBe(false);
  });
});

describe('announcement once-per-MYT-day rule (per-slide union)', () => {
  const a = slide('ann_a');
  const b = slide('ann_b');
  const day = '2026-10-06';
  const ids = (list: { id: string }[]) => list.map((x) => x.id);

  it('rolls the day over at 00:00 MYT (16:00 UTC), not at UTC midnight', () => {
    expect(mytDay(Date.parse('2026-10-06T15:59:59Z'))).toBe('2026-10-06');
    expect(mytDay(Date.parse('2026-10-06T16:00:00Z'))).toBe('2026-10-07');
  });

  it('shows everything when nothing (or garbage) is stored', () => {
    expect(ids(unseenAnnouncements([a, b], null, day))).toEqual([
      'ann_a',
      'ann_b',
    ]);
    expect(ids(unseenAnnouncements([a, b], '{not json', day))).toEqual([
      'ann_a',
      'ann_b',
    ]);
  });

  it('stays closed for slides already shown today', () => {
    const stored = recordSeen(null, [a, b], day);
    expect(unseenAnnouncements([a, b], stored, day)).toEqual([]);
  });

  it('shows again the next MYT day', () => {
    const stored = recordSeen(null, [a, b], day);
    expect(ids(unseenAnnouncements([a, b], stored, '2026-10-07'))).toEqual([
      'ann_a',
      'ann_b',
    ]);
  });

  it('removing, expiring or switching off a slide never re-shows the rest', () => {
    const stored = recordSeen(null, [a, b], day);
    expect(unseenAnnouncements([a], stored, day)).toEqual([]);
    expect(unseenAnnouncements([], stored, day)).toEqual([]);
  });

  it('an added or edited slide shows on its own', () => {
    const stored = recordSeen(null, [a, b], day);
    const c = slide('ann_c');
    const bEdited = { ...b, updated_at: '2026-10-06T09:00:00.000Z' };
    expect(ids(unseenAnnouncements([a, b, c], stored, day))).toEqual(['ann_c']);
    expect(ids(unseenAnnouncements([a, bEdited], stored, day))).toEqual([
      'ann_b',
    ]);
  });

  it('two instances serving different sets never show a slide twice in a day', () => {
    // Instance 1 has the old set, instance 2 already has an edit of b.
    const bEdited = { ...b, updated_at: '2026-10-06T09:00:00.000Z' };
    const setA = [a, b];
    const setB = [a, bEdited];

    let stored: string | null = null;
    const load = (live: typeof setA) => {
      const unseen = unseenAnnouncements(live, stored, day);
      if (unseen.length) stored = recordSeen(stored, unseen, day);
      return ids(unseen);
    };
    expect(load(setA)).toEqual(['ann_a', 'ann_b']);
    expect(load(setB)).toEqual(['ann_b']); // only the edit is new
    expect(load(setA)).toEqual([]);
    expect(load(setB)).toEqual([]);
  });

  it('records the union under today, dropping yesterday', () => {
    const yesterday = recordSeen(null, [a], '2026-10-05');
    const today = JSON.parse(recordSeen(yesterday, [b], day));
    expect(today).toEqual({ day, seen: [announcementKey(b)] });
    expect(JSON.parse(recordSeen(JSON.stringify(today), [a], day))).toEqual({
      day,
      seen: [announcementKey(b), announcementKey(a)],
    });
  });
});
