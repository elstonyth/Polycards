import { describe, it, expect } from 'vitest';
import { rollbackRead } from '@/lib/notifications/rollback-read';
import type { Notification } from '@/lib/actions/notifications';

const notif = (id: string, readAt: string | null): Notification => ({
  id,
  template: 'test',
  data: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  readAt,
});

describe('rollbackRead', () => {
  it('reverts a single optimistically-read row back to unread (onRead undo)', () => {
    const items = [notif('a', '2026-08-02T00:00:00.000Z'), notif('b', null)];
    const result = rollbackRead(items, ['a']);
    expect(result.find((n) => n.id === 'a')?.readAt).toBeNull();
    expect(result.find((n) => n.id === 'b')?.readAt).toBeNull();
  });

  it('reverts every id in a multi-row snapshot (onClearAll undo)', () => {
    const items = [
      notif('a', '2026-08-02T00:00:00.000Z'),
      notif('b', '2026-08-02T00:00:00.000Z'),
      notif('c', '2026-08-01T00:00:00.000Z'), // was already read before the clear
    ];
    const result = rollbackRead(items, ['a', 'b']);
    expect(result.find((n) => n.id === 'a')?.readAt).toBeNull();
    expect(result.find((n) => n.id === 'b')?.readAt).toBeNull();
    // Not in the snapshot — a pre-existing read stays untouched.
    expect(result.find((n) => n.id === 'c')?.readAt).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('is a no-op for an id not present in the list', () => {
    const items = [notif('a', null)];
    const result = rollbackRead(items, ['missing']);
    expect(result).toEqual(items);
  });

  it('accepts a Set directly (idempotent with an array of the same ids)', () => {
    const items = [notif('a', '2026-08-02T00:00:00.000Z')];
    const result = rollbackRead(items, new Set(['a']));
    expect(result.find((n) => n.id === 'a')?.readAt).toBeNull();
  });

  it('does not mutate the input array', () => {
    const items = [notif('a', '2026-08-02T00:00:00.000Z')];
    rollbackRead(items, ['a']);
    expect(items.find((n) => n.id === 'a')?.readAt).toBe(
      '2026-08-02T00:00:00.000Z',
    );
  });
});
