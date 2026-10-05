import {
  LIVE_ANNOUNCEMENTS_CAP,
  pickLiveAnnouncements,
  validateAnnouncement,
} from '../announcements';
import { validateImage } from '../../../api/admin/media/validate';

const ok = {
  image_url: 'https://cdn.example.com/a.webp',
  title: null,
  link_url: null,
  startsAt: null,
  endsAt: null,
};

describe('validateAnnouncement', () => {
  it('accepts an http(s) or same-origin image and trims', () => {
    expect(validateAnnouncement(ok).image_url).toBe(ok.image_url);
    expect(
      validateAnnouncement({ ...ok, image_url: '  /static/a.webp ' }).image_url,
    ).toBe('/static/a.webp');
  });

  it.each([
    ['empty', ''],
    ['protocol-relative', '//evil.example/a.webp'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['bare word', 'a.webp'],
    ['over 2048 chars', 'https://x/' + 'a'.repeat(2048)],
  ])('rejects a %s image_url', (_label, image_url) => {
    expect(() => validateAnnouncement({ ...ok, image_url })).toThrow(
      /image_url/,
    );
  });

  it('normalizes a blank title / link to null and trims a title', () => {
    const v = validateAnnouncement({ ...ok, title: '   ', link_url: '  ' });
    expect(v.title).toBeNull();
    expect(v.link_url).toBeNull();
    expect(validateAnnouncement({ ...ok, title: ' Drop! ' }).title).toBe(
      'Drop!',
    );
  });

  it('caps the title at 80 chars', () => {
    expect(
      validateAnnouncement({ ...ok, title: 'x'.repeat(80) }).title,
    ).toHaveLength(80);
    expect(() =>
      validateAnnouncement({ ...ok, title: 'x'.repeat(81) }),
    ).toThrow(/title/);
  });

  it('applies the URL rule to link_url (it becomes an href)', () => {
    expect(validateAnnouncement({ ...ok, link_url: '/slots/x' }).link_url).toBe(
      '/slots/x',
    );
    expect(() =>
      validateAnnouncement({ ...ok, link_url: 'javascript:alert(1)' }),
    ).toThrow(/link_url/);
    expect(() =>
      validateAnnouncement({ ...ok, link_url: '//evil.example' }),
    ).toThrow(/link_url/);
  });

  it('requires the end after the start', () => {
    const t = new Date('2026-10-06T00:00:00Z');
    expect(() =>
      validateAnnouncement({ ...ok, startsAt: t, endsAt: t }),
    ).toThrow(/after its start/);
    expect(() =>
      validateAnnouncement({
        ...ok,
        startsAt: t,
        endsAt: new Date(t.getTime() + 1),
      }),
    ).not.toThrow();
  });
});

describe('pickLiveAnnouncements', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const row = (
    id: string,
    over: Partial<{
      active: boolean;
      sort: number;
      starts_at: string | null;
      ends_at: string | null;
      created_at: string;
    }> = {},
  ) => ({
    id,
    active: true,
    sort: 0,
    starts_at: null,
    ends_at: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  });

  it('drops inactive and out-of-window rows (start inclusive, end exclusive)', () => {
    const ids = pickLiveAnnouncements(
      [
        row('live'),
        row('off', { active: false }),
        row('future', { starts_at: '2026-10-06T12:00:01Z' }),
        row('starts-now', { starts_at: '2026-10-06T12:00:00Z' }),
        row('ended', { ends_at: '2026-10-06T12:00:00Z' }),
        row('ends-later', { ends_at: '2026-10-06T12:00:01Z' }),
      ],
      now,
    ).map((r) => r.id);
    expect(ids.sort()).toEqual(['ends-later', 'live', 'starts-now']);
  });

  it('orders by sort ASC, then newest first', () => {
    const ids = pickLiveAnnouncements(
      [
        row('b-old', { sort: 1, created_at: '2026-10-01T00:00:00Z' }),
        row('b-new', { sort: 1, created_at: '2026-10-05T00:00:00Z' }),
        row('a', { sort: 0 }),
      ],
      now,
    ).map((r) => r.id);
    expect(ids).toEqual(['a', 'b-new', 'b-old']);
  });

  it('caps the carousel', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row(`r${i}`, { sort: i }),
    );
    const live = pickLiveAnnouncements(rows, now);
    expect(live).toHaveLength(LIVE_ANNOUNCEMENTS_CAP);
    expect(live[0].id).toBe('r0');
  });
});

describe("image kind 'announcement'", () => {
  const base = {
    bytes: 1000,
    mimeType: 'image/png',
    detectedFormat: 'png',
    frames: 1,
  };

  it.each([
    ['4:5 poster', 1080, 1350],
    ['9:16 story', 1080, 1920],
    ['wide banner', 1600, 400],
    ['square', 800, 800],
  ])('accepts any aspect ratio (%s)', (_label, width, height) => {
    expect(validateImage({ ...base, width, height }, 'announcement')).toEqual({
      ok: true,
    });
  });

  it('rejects images narrower than 400px', () => {
    const v = validateImage(
      { ...base, width: 399, height: 600 },
      'announcement',
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('too_small');
  });

  it('rejects animated images', () => {
    const v = validateImage(
      { ...base, width: 1080, height: 1350, frames: 4 },
      'announcement',
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('animated');
  });
});
