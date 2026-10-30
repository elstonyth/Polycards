import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmProposal, takeEvents } from '../assistant';

// Vite defines __BACKEND_URL__ at build time; the node test runner does not.
const answer = (status: number, body: unknown) => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal('__BACKEND_URL__', 'https://api.test');
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('confirm proposals', () => {
  it('reads a confirm event from the chat stream', () => {
    const line = JSON.stringify({
      type: 'confirm',
      kind: 'note',
      summary: 'Note: Likes short captions.',
      token: 'tok',
    });
    expect(takeEvents(`${line}\n`).events).toEqual([
      {
        type: 'confirm',
        kind: 'note',
        summary: 'Note: Likes short captions.',
        token: 'tok',
      },
    ]);
  });

  it('posts the token with the session cookie', async () => {
    const fetch = answer(200, {
      saved: true,
      kind: 'schedule',
      id: 'sch_1',
      next_run_at: '2026-11-02T01:00:00.000Z',
    });
    await expect(confirmProposal('tok')).resolves.toMatchObject({
      kind: 'schedule',
      next_run_at: '2026-11-02T01:00:00.000Z',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.test/admin/assistant/confirm');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(init?.body))).toEqual({ token: 'tok' });
  });

  it("throws the server's code and message on a refusal", async () => {
    answer(400, {
      code: 'confirm_expired',
      message: 'This has expired or is not yours to save. Ask again.',
    });
    await expect(confirmProposal('tok')).rejects.toMatchObject({
      code: 'confirm_expired',
      message: 'This has expired or is not yours to save. Ask again.',
      status: 400,
    });
  });

  it('throws without a code when the body is not JSON', async () => {
    vi.stubGlobal('__BACKEND_URL__', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad gateway', { status: 502 })),
    );
    const err = await confirmProposal('tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      message: 'Request failed (502).',
      code: undefined,
    });
  });
});
