import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The actions import the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). Nothing
// beneath the port (SDK, cookies, logger) is mocked — the real schema parsing
// and copy tables run.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
} from '../notifications';

const ROW = {
  id: 'ntf_1',
  template: 'pull.graded',
  data: { card: 'Pikachu' },
  created_at: '2026-09-01T00:00:00.000Z',
  read_at: null,
};

describe('getNotifications', () => {
  it('pages the feed and maps the rows', async () => {
    const mem = backend({
      'GET /store/notifications': {
        body: { notifications: [ROW], unread_count: 4, has_more: true },
      },
    });
    expect(await getNotifications(2)).toEqual({
      ok: true,
      notifications: [
        {
          id: 'ntf_1',
          template: 'pull.graded',
          data: { card: 'Pikachu' },
          createdAt: '2026-09-01T00:00:00.000Z',
          readAt: null,
        },
      ],
      unreadCount: 4,
      page: 2,
      hasMore: true,
    });
    expect(mem.requests).toEqual([
      {
        method: 'GET',
        path: '/store/notifications',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
        query: { limit: 20, offset: 20 },
      },
    ]);
  });

  // The envelope is SOFT on purpose: it only carries the count and the
  // pagination flag, so a malformed one must degrade to counting the rows we
  // did get — never blank the feed the customer came to read.
  it('a malformed envelope still lists the rows and counts the unread ones', async () => {
    backend({
      'GET /store/notifications': {
        body: { notifications: [ROW], unread_count: 'lots' },
      },
    });
    const r = await getNotifications();
    expect(r.ok && r.notifications).toHaveLength(1);
    expect(r.ok && r.unreadCount).toBe(1);
    expect(r.ok && r.hasMore).toBe(false);
  });

  it('one bad row drops, the rest survive', async () => {
    backend({
      'GET /store/notifications': {
        body: { notifications: [ROW, { id: 'broken' }], unread_count: 1 },
      },
    });
    const r = await getNotifications();
    expect(r.ok && r.notifications.map((n) => n.id)).toEqual(['ntf_1']);
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await getNotifications()).toEqual({
      ok: false,
      error: 'Please log in to view your notifications.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  it('a backend refusal maps through the notification copy table', async () => {
    backend({ 'GET /store/notifications': { status: 429 } });
    expect(await getNotifications()).toEqual({
      ok: false,
      error: 'Too many requests — give it a moment and try again.',
      needsAuth: false,
    });
  });
});

describe('getUnreadCount', () => {
  it('reads the smallest legal page and returns the true total', async () => {
    const mem = backend({
      'GET /store/notifications': { body: { unread_count: 7 } },
    });
    expect(await getUnreadCount()).toBe(7);
    expect(mem.requests[0]).toMatchObject({
      method: 'GET',
      path: '/store/notifications',
      query: { limit: 1 },
    });
  });

  // The nav badge calls this unconditionally: no auth gate, and never a throw.
  it.each([
    ['logged out', {}, { token: null } as const],
    [
      'a failed read',
      { 'GET /store/notifications': { status: 500 } },
      undefined,
    ],
    [
      'an unparsable envelope',
      { 'GET /store/notifications': { body: { unread_count: null } } },
      undefined,
    ],
  ])('shows no badge on %s', async (_label, routes, opts) => {
    backend(routes, opts);
    expect(await getUnreadCount()).toBe(0);
  });
});

describe('markRead / markAllRead', () => {
  it('posts an empty body to the per-id route', async () => {
    const mem = backend({
      'POST /store/notifications/:id/read': {
        body: { id: 'ntf_1', read_at: '2026-09-02T00:00:00.000Z' },
      },
    });
    expect(await markRead('ntf_1')).toEqual({
      ok: true,
      id: 'ntf_1',
      readAt: '2026-09-02T00:00:00.000Z',
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/notifications/ntf_1/read',
      body: {},
    });
  });

  it('rejects an invalid id before any request', async () => {
    const mem = backend({});
    expect(await markRead('  ')).toEqual({
      ok: false,
      error: 'Invalid notification id.',
    });
    expect(mem.requests).toEqual([]);
  });

  it('a 404 reads as "not found", not as a generic failure', async () => {
    backend({ 'POST /store/notifications/:id/read': { status: 404 } });
    expect(await markRead('ntf_1')).toEqual({
      ok: false,
      error: 'Notification not found.',
      needsAuth: false,
    });
  });

  it('clears the whole feed in one request', async () => {
    const mem = backend({
      'POST /store/notifications/read-all': {
        body: { marked: 12, read_at: '2026-09-02T00:00:00.000Z' },
      },
    });
    expect(await markAllRead()).toEqual({
      ok: true,
      marked: 12,
      readAt: '2026-09-02T00:00:00.000Z',
    });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/notifications/read-all',
      body: {},
    });
  });

  it('a 2xx with the wrong shape is an unexpected response', async () => {
    backend({
      'POST /store/notifications/read-all': { body: { marked: 'a' } },
    });
    expect(await markAllRead()).toEqual({
      ok: false,
      error: 'Got an unexpected response. Please try again.',
    });
  });
});
