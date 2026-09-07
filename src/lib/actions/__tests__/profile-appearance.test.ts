import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// `setAvatarFrame` imports the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). The two Next
// server-only modules the file also pulls in are stubbed: `revalidatePath` is
// asserted, `cookies` is only reached by the multipart upload.
const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

import { setAvatarFrame } from '../profile-appearance';

beforeEach(() => vi.clearAllMocks());

describe('setAvatarFrame', () => {
  it('posts the level and revalidates /me', async () => {
    const mem = backend({ 'POST /store/profile/frame': { body: {} } });
    expect(await setAvatarFrame(50)).toEqual({ ok: true });
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/profile/frame',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
        body: { level: 50 },
      },
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/me');
  });

  it('unequips with an explicit null, not an omitted key', async () => {
    const mem = backend({ 'POST /store/profile/frame': { body: {} } });
    await setAvatarFrame(null);
    expect(mem.requests[0]?.body).toEqual({ level: null });
  });

  // A server action is a public endpoint: a level that is not a milestone is
  // refused here, before the request.
  it('refuses a level outside the milestone set before any request', async () => {
    const mem = backend({});
    expect(await setAvatarFrame(7)).toEqual({
      ok: false,
      error: 'Invalid frame.',
    });
    expect(mem.requests).toEqual([]);
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await setAvatarFrame(50)).toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mem.requests).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("maps the backend's lock refusal to its own copy", async () => {
    backend({
      'POST /store/profile/frame': {
        status: 400,
        body: { message: 'This frame unlocks at level 60.' },
      },
    });
    expect(await setAvatarFrame(50)).toEqual({
      ok: false,
      error: 'That frame is still locked — keep leveling!',
    });
  });

  it('falls back cleanly on an unrecognised refusal', async () => {
    backend({
      'POST /store/profile/frame': { status: 500, body: { message: 'boom' } },
    });
    expect(await setAvatarFrame(50)).toEqual({
      ok: false,
      error: 'Something went wrong. Please try again.',
    });
  });
});
