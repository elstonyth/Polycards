import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { localTokenValid } from '@/lib/local-sign-in';

const setAuthToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/data/customer', () => ({ setAuthToken }));

import { GET } from '../route';

const SECRET = 'local-prod-copy-jwt-not-for-prod';
const on = () => {
  vi.stubEnv('LOCAL_SIGN_IN', '1');
  vi.stubEnv('LOCAL_SIGN_IN_SECRET', SECRET);
  vi.stubEnv('LOCAL_SIGN_IN_ACCOUNTS', 'cus_A:authid_A,cus_B:authid_B');
  vi.stubEnv('NEXT_PUBLIC_MEDUSA_BACKEND_URL', 'http://localhost:9100');
};
const get = (query = '') =>
  GET(new NextRequest(`http://localhost:4320/api/dev-sign-in${query}`));

afterEach(() => {
  vi.unstubAllEnvs();
  setAuthToken.mockClear();
});

describe('GET /api/dev-sign-in', () => {
  it('does not exist unless the local launch switched it on', async () => {
    expect((await get()).status).toBe(404);
    on();
    vi.stubEnv('NEXT_PUBLIC_MEDUSA_BACKEND_URL', 'https://admin.polycards.gg');
    expect((await get()).status).toBe(404);
    expect(setAuthToken).not.toHaveBeenCalled();
  });

  it('signs in as the first allowed account and sends you to Me', async () => {
    on();
    const res = await get();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/me');
    const token = setAuthToken.mock.calls[0]?.[0] as string;
    expect(localTokenValid(SECRET, token)).toBe(true);
    expect(JSON.parse(atob(token.split('.')[1] ?? '')).actor_id).toBe('cus_A');
  });

  it('signs in only as an allowed account', async () => {
    on();
    expect((await get('?as=cus_B')).status).toBe(303);
    expect((await get('?as=cus_someone_else')).status).toBe(404);
    expect(setAuthToken).toHaveBeenCalledOnce();
  });

  it('never sends you off this site', async () => {
    on();
    const to = async (next: string) =>
      (await get(`?next=${encodeURIComponent(next)}`)).headers.get('location');
    expect(await to('/vault')).toBe('/vault');
    expect(await to('//evil.example')).toBe('/me');
    expect(await to('/\t/evil.example')).toBe('/me');
  });
});
