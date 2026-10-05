import { describe, it, expect } from 'vitest';
import { AnnouncementsSchema } from '@/lib/data/schemas';
import {
  announcementSig,
  mytDay,
  shouldShowAnnouncements,
} from '@/lib/announcement-seen';

describe('AnnouncementsSchema', () => {
  it('parses the store route shape (nullable caption and link)', () => {
    const body = {
      announcements: [
        {
          id: 'ann_1',
          image_url: 'https://cdn.example.com/a.webp',
          title: null,
          link_url: '/slots/base-set',
          updated_at: '2026-10-06T00:00:00.000Z',
        },
      ],
    };
    expect(AnnouncementsSchema.parse(body)).toEqual(body);
  });

  it('rejects a slide without an image', () => {
    expect(
      AnnouncementsSchema.safeParse({
        announcements: [
          { id: 'ann_1', title: null, link_url: null, updated_at: 'x' },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('announcement once-per-MYT-day rule', () => {
  const first = { id: 'ann_1', updated_at: '2026-10-06T00:00:00.000Z' };
  const second = { id: 'ann_2', updated_at: '2026-10-05T00:00:00.000Z' };
  const set = [first, second];
  const sig = announcementSig(set);
  const seen = (s: string, day: string) => JSON.stringify({ sig: s, day });

  it('rolls the day over at 00:00 MYT (16:00 UTC), not at UTC midnight', () => {
    expect(mytDay(Date.parse('2026-10-06T15:59:59Z'))).toBe('2026-10-06');
    expect(mytDay(Date.parse('2026-10-06T16:00:00Z'))).toBe('2026-10-07');
  });

  it('shows when nothing (or garbage) is stored', () => {
    expect(shouldShowAnnouncements(null, sig, '2026-10-06')).toBe(true);
    expect(shouldShowAnnouncements('{not json', sig, '2026-10-06')).toBe(true);
  });

  it('stays closed for the same set on the same day', () => {
    expect(
      shouldShowAnnouncements(seen(sig, '2026-10-06'), sig, '2026-10-06'),
    ).toBe(false);
  });

  it('shows again the next MYT day', () => {
    expect(
      shouldShowAnnouncements(seen(sig, '2026-10-06'), sig, '2026-10-07'),
    ).toBe(true);
  });

  it('shows again at once when a slide is added or edited', () => {
    const edited = announcementSig([
      { ...first, updated_at: '2026-10-06T09:00:00.000Z' },
      second,
    ]);
    const added = announcementSig([
      ...set,
      { id: 'ann_3', updated_at: '2026-10-06T00:00:00.000Z' },
    ]);
    for (const next of [edited, added]) {
      expect(next).not.toBe(sig);
      expect(
        shouldShowAnnouncements(seen(sig, '2026-10-06'), next, '2026-10-06'),
      ).toBe(true);
    }
  });

  it('never shows an empty set', () => {
    expect(
      shouldShowAnnouncements(null, announcementSig([]), '2026-10-06'),
    ).toBe(false);
  });
});
